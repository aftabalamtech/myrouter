// Pure upstream-health classification — no DB, no network, unit-testable.
//
// Task §1/§2: an HTTP 403 (especially Google's VALIDATION_REQUIRED
// eligibility gate) must NEVER be classified as a successful connection, a
// successful OAuth token refresh alone is not health, and an account-level
// restriction blocks every model of that connection — so the model batch
// test uses it as its provider-level guard instead of re-pinging all models.

// Error categories. Deliberately more granular than the old generic "error":
// auth = credentials rejected; validation_required = account/eligibility gate;
// billing = payment/license; rate_limited = temporary; server = upstream 5xx.
export const HEALTH_CATEGORIES = Object.freeze([
  "ok",
  "auth",
  "billing",
  "validation_required",
  "rate_limited",
  "server",
  "network",
  "unknown",
]);

// Providers whose account-level restriction (Google eligibility / license
// gate) applies to the WHOLE connection — per-model retries cannot fix them.
export const ACCOUNT_GATED_PROVIDERS = Object.freeze(
  new Set(["antigravity", "gemini-cli"])
);

// Standard message prefix for the model-test guard. classifyTestError keys off
// it, so keep it in sync with testBatch.js.
export const PROVIDER_BLOCKED_PREFIX = "[provider blocked]";

const VALIDATION_BODY_MARKERS = [
  "validation_required",
  "verify your account",
  "valid license",
];

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9\-_]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  /(api[_-]?key|apikey|token|secret|password|cookie)\s*[:=]\s*["']?[^"'\s,}]{4,}/gi,
];

// Redact token-like material, keep the diagnostic text readable. Mirrors
// testBatch.sanitizeErrorMessage (kept local so this module has no deps).
export function sanitizeDetail(str) {
  let out = String(str || "");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.slice(0, 240);
}

export function sanitizeUpstreamCode(raw) {
  const s = String(raw || "").trim().toUpperCase();
  const m = s.match(/^[A-Z][A-Z0-9_]{2,39}/);
  return m ? m[0] : null;
}

// Pull the Google-rpc reason (e.g. VALIDATION_REQUIRED lives in
// error.details[].reason) or a plain-text marker from an upstream body.
// Never includes token material — sanitizeDetail runs on the message.
export function extractUpstreamCodeFromBody(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    const details = Array.isArray(data?.error?.details) ? data.error.details : [];
    for (const d of details) {
      const code = sanitizeUpstreamCode(d?.reason);
      if (code) return code;
    }
    const status = sanitizeUpstreamCode(data?.error?.status);
    if (status) return status;
  } catch { /* body is not JSON */ }
  return null;
}

export function extractDetailMessageFromBody(bodyStr) {
  if (!bodyStr) return "";
  try {
    const data = JSON.parse(bodyStr);
    const raw = data?.error?.message || data?.message || data?.error;
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return String(bodyStr);
  }
}

/**
 * Classify one upstream HTTP exchange.
 * probeMode: the request deliberately cannot satisfy the full request schema
 * (e.g. Antigravity login probe without a project envelope). In probeMode a
 * 400 means the request PASSED authentication and access control — Google
 * validates auth before schema — and is treated as `ok` (same policy as the
 * codex connection probe's acceptStatuses).
 */
export function classifyUpstreamHealth({
  status,
  body = "",
  provider,
  probeMode = false,
} = {}) {
  const httpStatus = Number.isFinite(Number(status)) && status !== null && status !== undefined
    ? Number(status)
    : null;
  const accountGated = ACCOUNT_GATED_PROVIDERS.has(provider);
  const bodyStr = typeof body === "string" ? body.slice(0, 4000) : "";
  const lower = bodyStr.toLowerCase();
  const upstreamCode = extractUpstreamCodeFromBody(bodyStr);

  const isValidationGate =
    httpStatus === 403 &&
    (upstreamCode === "VALIDATION_REQUIRED" ||
      VALIDATION_BODY_MARKERS.some((m) => lower.includes(m)));

  let category;
  let providerLevel = false;
  if (probeMode && httpStatus === 400) {
    category = "ok";
  } else if (isValidationGate) {
    category = "validation_required";
    providerLevel = true;
  } else if (httpStatus === 401) {
    category = "auth";
  } else if (httpStatus === 403) {
    category = "auth";
    providerLevel = accountGated; // gated providers fail connection-wide
  } else if (httpStatus === 402) {
    category = "billing";
  } else if (httpStatus === 429) {
    category = "rate_limited";
  } else if (httpStatus !== null && httpStatus >= 500) {
    category = "server";
  } else if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    category = "ok";
  } else if (httpStatus === null) {
    category = "network";
  } else {
    category = "unknown";
  }

  const detail = sanitizeDetail(extractDetailMessageFromBody(bodyStr));
  return { httpStatus, category, providerLevel, upstreamCode, detail };
}

export function recommendedActionFor(category) {
  switch (category) {
    case "auth":
      return "Re-authenticate: run Re-test after signing in again (or re-paste the API key).";
    case "validation_required":
      return "Verify your Google account for Antigravity eligibility in a browser, then run Re-test. A proxy cannot bypass Google's eligibility check.";
    case "billing":
      return "Check the account's plan, license or credits on the provider's site, then run Re-test.";
    case "rate_limited":
      return "Temporary rate limit — the connection is alive; retry after the limit resets.";
    case "server":
      return "Upstream server error — usually transient; retry later.";
    case "network":
      return "Could not reach the upstream endpoint — check network/proxy and DNS.";
    default:
      return "Run Re-test to refresh the classification.";
  }
}

/**
 * Turn an upstream classification into a connection-test verdict.
 * - 429: authentication passed and the upstream answered — the CONNECTION is
 *   alive; the account may be cooling down, which runtime routing handles.
 * - 500/unreachable: cannot be proven healthy → error.
 */
export function decideConnectionTestOutcome({
  status,
  body = "",
  provider,
  probeMode = false,
} = {}) {
  const cls = classifyUpstreamHealth({ status, body, provider, probeMode });
  let valid;
  let testStatus;
  switch (cls.category) {
    case "ok":
      valid = true;
      testStatus = "active";
      break;
    case "rate_limited":
      valid = true;
      testStatus = "active";
      break;
    case "validation_required":
      valid = false;
      testStatus = "action_required";
      break;
    default:
      valid = false;
      testStatus = "error";
  }
  return { ...cls, valid, testStatus, recommendedAction: recommendedActionFor(cls.category) };
}

export const CONNECTION_STATUS_FIELDS = Object.freeze([
  "testStatus",
  "lastError",
  "lastErrorAt",
  "lastErrorCategory",
  "lastErrorHttpStatus",
  "lastErrorUpstreamCode",
]);

/**
 * Provider-blocked connection-test outcome → the exact DB update to persist.
 * On success it CLEARS the diagnostics fields so a healed account removes the
 * blocked state (manual retry action = run Re-test / one-by-one).
 */
export function statusUpdateFromResult(result, { testedAt } = {}) {
  const at = testedAt || new Date().toISOString();
  if (result?.valid === true) {
    return {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      lastErrorCategory: null,
      lastErrorHttpStatus: null,
      lastErrorUpstreamCode: null,
    };
  }
  const testStatus = result?.testStatus
    || (result?.providerBlocked ? "action_required" : "error");
  const category = result?.category || result?.lastErrorCategory || null;
  return {
    testStatus,
    lastError: sanitizeDetail(result?.error || ""),
    lastErrorAt: at,
    lastErrorCategory: category,
    lastErrorHttpStatus: result?.httpStatus ?? null,
    lastErrorUpstreamCode: result?.upstreamCode ?? null,
  };
}

/**
 * Is this single connection provider-level blocked? Reads the diagnostics
 * written by statusUpdateFromResult, plus lastError text markers so a
 * connection tested before this fix still gets protected.
 */
export function isConnectionProviderBlocked(connection) {
  if (!connection || connection.isActive === false) return { blocked: false };
  if (connection.testStatus === "action_required") return { blocked: true };
  if (connection.lastErrorCategory === "validation_required") return { blocked: true };
  const err = String(connection.lastError || "").toLowerCase();
  if (
    err.includes("validation_required") ||
    err.includes("verify your account") ||
    err.includes(PROVIDER_BLOCKED_PREFIX.toLowerCase())
  ) {
    return { blocked: true };
  }
  return { blocked: false };
}

// Standard message for the model-test guard. classifyTestError keys off the
// prefix, so keep it in sync with testBatch.js.
export function providerBlockedMessage(provider) {
  // Keep the scope statement well inside testBatch's 240-char sanitize cap —
  // "affects the whole connection, not individual models" must never be
  // truncated away.
  return `${PROVIDER_BLOCKED_PREFIX} account-level restriction for ${provider}: affects the whole connection, not individual models. Model tests were skipped instead of repeated retries — verify the account upstream, then run Re-test to retry.`;
}

/**
 * Provider-level model-test guard: a provider is blocked when EVERY active
 * connection for it carries the account-level restriction. Retrying each of
 * its models cannot help (§2) — they are skipped with a clear reason, and the
 * manual retry path (single-model test or Re-test connection) stays open.
 *
 * Returns a Map providerId → { blocked, provider, message } for blocked
 * providers only.
 */
export function providerModelTestGuards(connections = []) {
  const byProvider = new Map();
  for (const conn of connections || []) {
    if (!conn?.provider) continue;
    byProvider.set(conn.provider, [...(byProvider.get(conn.provider) || []), conn]);
  }
  const guards = new Map();
  for (const [provider, list] of byProvider) {
    const actives = list.filter((c) => c.isActive !== false);
    if (actives.length === 0) continue;
    const blocked = actives.every((c) => isConnectionProviderBlocked(c).blocked);
    if (blocked) {
      guards.set(provider, {
        blocked: true,
        provider,
        message: providerBlockedMessage(provider),
      });
    }
  }
  return guards;
}
