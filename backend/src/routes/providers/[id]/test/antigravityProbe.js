// Antigravity connection probe — REAL inference path, not the token table.
//
// Root cause (task §1): the connection test used to hit Google's userinfo
// endpoint only. A valid OAuth token (or a successful token refresh) made the
// connection "active" while every model failed at the actual inference
// endpoint with 403 VALIDATION_REQUIRED — the eligibility/license gate that
// userinfo cannot see. This probe calls cloudcode-pa directly so the verdict
// matches the model tests.
//
// Design: no "@" aliases, no DB, no network imports — runAntigravityProbe()
// takes its fetch and refresh implementations as parameters, so the whole
// decision path is unit-testable with node --test.
import { decideConnectionTestOutcome } from "../../../../lib/models/connectionHealth.js";

// Minimal probe that cannot satisfy the request schema → upstream replies 400
// AFTER authentication/access control passes (probeMode treats 400 as ok).
// A 403 VALIDATION_REQUIRED / PERMISSION_DENIED still surfaces the gate.
const PROBE_URL = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const PROBE_BODY = JSON.stringify({
  model: "connection-probe",
  request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
});

function probeHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "antigravity",
  };
}

async function sendProbe(fetchFn, token) {
  const res = await fetchFn(PROBE_URL, {
    method: "POST",
    headers: probeHeaders(token),
    body: PROBE_BODY,
  });
  let body = "";
  try { body = await res.text(); } catch { body = ""; }
  return { resStatus: res.status, body };
}

function enrich(o, extra = {}) {
  return {
    valid: o.valid,
    testStatus: o.testStatus,
    category: o.category,
    httpStatus: o.httpStatus,
    upstreamCode: o.upstreamCode,
    detail: o.detail,
    providerBlocked: o.providerLevel === true || o.testStatus === "action_required",
    recommendedAction: o.recommendedAction,
    refreshed: extra.refreshed ?? extra.base?.refreshed ?? false,
    newTokens: extra.newTokens ?? extra.base?.newTokens ?? null,
  };
}

function validationGateMessage(detail) {
  return `${detail || "HTTP 403"} — Google account verification or eligibility is required for this Antigravity session. Verify the account in a browser, then run Re-test. A proxy cannot bypass Google's eligibility check.`;
}

function classifyByStatus(resStatus, body) {
  return decideConnectionTestOutcome({
    status: resStatus,
    body,
    provider: "antigravity",
    probeMode: true,
  });
}

/**
 * Probe the actual Antigravity upstream with the connection's token.
 *
 * Returns:
 * { valid, testStatus, category, httpStatus, upstreamCode, detail,
 *   providerBlocked, recommendedAction, refreshed, newTokens, error }
 *
 * - 401 (auth) with a refreshable token → refresh once and re-probe; the
 *   refresh success alone never flips the verdict.
 * - probeMode 400 ⇒ authentication + ACL passed ⇒ healthy (schema rejected
 *   the deliberately-minimal probe body, exactly like the codex probe).
 */
export async function runAntigravityProbe({
  connection,
  accessToken,
  refreshFn,
  fetchFn,
  refreshed = false,
  newTokens = null,
} = {}) {
  const base = {
    refreshed: !!refreshed,
    newTokens: newTokens || null,
  };

  let token = accessToken || null;

  // Token table empty but a refresh token exists — mint one; the PROBE
  // verdict (not the refresh success) decides health.
  if (!token && connection?.refreshToken && typeof refreshFn === "function") {
    const tokens = await refreshFn(connection);
    if (tokens?.accessToken) {
      token = tokens.accessToken;
      base.refreshed = true;
      base.newTokens = tokens;
    }
  }

  if (!token) {
    return {
      valid: false,
      error: "No access token",
      refreshed: false,
      newTokens: null,
      category: "auth",
      httpStatus: null,
      upstreamCode: null,
      detail: "",
      providerBlocked: true,
      recommendedAction: "Sign in again to obtain an access token.",
      testStatus: "error",
    };
  }

  let outcome;
  try {
    const { resStatus, body } = await sendProbe(fetchFn, token);
    outcome = classifyByStatus(resStatus, body);
  } catch (err) {
    outcome = classifyByStatus(null, `Network error: ${err?.message || String(err)}`);
  }

  // 401 → maybe a stale token: refresh exactly once and re-probe.
  if (outcome.category === "auth" && !base.refreshed && connection?.refreshToken && typeof refreshFn === "function") {
    const tokens = await refreshFn(connection);
    if (tokens?.accessToken) {
      try {
        const { resStatus, body } = await sendProbe(fetchFn, tokens.accessToken);
        // The retry's own verdict decides health — the refresh success
        // by itself never flips the result (task §1).
        outcome = classifyByStatus(resStatus, body);
        base.refreshed = true;
        base.newTokens = tokens;
      } catch { /* refresh re-probe failed: keep the first verdict */ }
    }
  }

  const final = {
    ...enrich(outcome, base),
    error: outcome.valid
      ? null
      : outcome.category === "validation_required"
        ? `HTTP ${outcome.httpStatus} ${outcome.upstreamCode || ""}: ${outcome.detail || "Google requires account verification."} — ${outcome.recommendedAction}`
        : outcome.detail || (outcome.recommendedAction ? `HTTP ${outcome.httpStatus || "unreachable"}: ${outcome.recommendedAction}` : `HTTP ${outcome.httpStatus || "error"}`),
  };
  return final;
}
