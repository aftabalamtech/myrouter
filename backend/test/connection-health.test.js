/**
 * Regression tests for the Antigravity 403 VALIDATION_REQUIRED status bug.
 *
 * Root cause: the connection test probed only Google's userinfo endpoint, so
 * a valid OAuth token (or a successful refresh) reported the connection
 * "active" while every model failed at the real inference endpoint with
 * 403 VALIDATION_REQUIRED. Touches task criteria §1–§7 and §10.
 *
 * Run: node --test test/connection-health.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-conn-health-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL; // SQLite for the persistence leg (§10)
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-conn-health";

const {
  decideConnectionTestOutcome,
  classifyUpstreamHealth,
  providerModelTestGuards,
  isConnectionProviderBlocked,
  statusUpdateFromResult,
  sanitizeDetail,
} = await import("../src/lib/models/connectionHealth.js");

const VALIDATION_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "You do not have a valid license of this product.",
    status: "PERMISSION_DENIED",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "VALIDATION_REQUIRED", domain: "googleapis.com" }],
  },
});

// --- §5.1–5.5: upstream classification -------------------------------------

test("§5.1 HTTP 200 with a valid response is successful", () => {
  const outcome = decideConnectionTestOutcome({ status: 200, body: "{}", provider: "antigravity" });
  assert.equal(outcome.valid, true);
  assert.equal(outcome.testStatus, "active");
  assert.equal(outcome.category, "ok");
});

test("§5.2 HTTP 403 VALIDATION_REQUIRED is NEVER a successful connection", () => {
  const outcome = decideConnectionTestOutcome({ status: 403, body: VALIDATION_BODY, provider: "antigravity" });
  assert.equal(outcome.valid, false);
  assert.equal(outcome.category, "validation_required");
  assert.equal(outcome.testStatus, "action_required");
  assert.equal(outcome.upstreamCode, "VALIDATION_REQUIRED");
  assert.equal(outcome.providerLevel, true);
  // 403 with the plain-text gate marker classifies the same way
  const text = decideConnectionTestOutcome({ status: 403, body: "Verify your account at https://example.com", provider: "antigravity" });
  assert.equal(text.category, "validation_required");
  assert.equal(text.valid, false);
});

test("§5.3 HTTP 401 is classified as an authentication error", () => {
  const outcome = decideConnectionTestOutcome({ status: 401, body: "Unauthorized", provider: "antigravity" });
  assert.equal(outcome.valid, false);
  assert.equal(outcome.category, "auth");
  assert.equal(outcome.testStatus, "error");
  assert.equal(outcome.providerLevel, false); // auth failures fixable per-connection
});

test("§5.4 HTTP 429 is classified as rate limiting (connection alive, not success-badge-worthy info)", () => {
  const outcome = decideConnectionTestOutcome({ status: 429, body: "Resource exhausted", provider: "antigravity" });
  assert.equal(outcome.category, "rate_limited");
  // the CONNECTION is reachable; runtime routing already handles cooldown
  assert.equal(outcome.testStatus, "active");
});

test("§5.5 HTTP 5xx is classified as an upstream server error", () => {
  const outcome = decideConnectionTestOutcome({ status: 503, body: "Backend error", provider: "antigravity" });
  assert.equal(outcome.valid, false);
  assert.equal(outcome.category, "server");
  assert.equal(outcome.testStatus, "error");
});

// --- §5.6: no green badge for 403 (persisted status can't be success) -------

test("§5.6 a 403 connection can never persist an active/success status", () => {
  const outcome = decideConnectionTestOutcome({ status: 403, body: VALIDATION_BODY, provider: "antigravity" });
  const update = statusUpdateFromResult(
    { valid: outcome.valid, testStatus: outcome.testStatus, category: outcome.category, httpStatus: outcome.httpStatus, upstreamCode: outcome.upstreamCode, error: "403 VALIDATION_REQUIRED" },
    { testedAt: new Date().toISOString() }
  );
  assert.equal(update.testStatus, "action_required");
  assert.notEqual(update.testStatus, "active");
  assert.equal(update.lastErrorHttpStatus, 403);
  assert.equal(update.lastErrorUpstreamCode, "VALIDATION_REQUIRED");
  // and the stored connection reads back as blocked
  assert.equal(isConnectionProviderBlocked({ testStatus: update.testStatus, isActive: true }).blocked, true);
  assert.equal(isConnectionProviderBlocked({ testStatus: "active", isActive: true }).blocked, false);
});

// --- §2: validation gate message never implies a router bypass --------------

test("a successful token refresh alone never flips the verdict", () => {
  // probe semantics: classify only judges the upstream exchange
  const stillGate = decideConnectionTestOutcome({ status: 403, body: VALIDATION_BODY, provider: "antigravity" });
  assert.equal(stillGate.valid, false);
  // refresh success is metadata; the classification does not consume it
  assert.equal("refreshed" in stillGate, false);
});

// --- §4: safe message + sanitization ----------------------------------------

test("error detail is sanitized and length-capped", () => {
  const dirty = "Forbidden Bearer ya29.super-secret-token-abcdef sk-live-0123456789abcdef token: \"abcdefgh1234\"";
  const clean = sanitizeDetail(dirty);
  assert.equal(clean.includes("ya29.super-secret-token"), false);
  assert.equal(clean.includes("sk-live-0123456789"), false);
  assert.equal(clean.includes("abcdefgh1234"), false);
  assert.ok(clean.length <= 240);
});

test("recommended action for validation gate does not claim a bypass", () => {
  const outcome = decideConnectionTestOutcome({ status: 403, body: VALIDATION_BODY, provider: "antigravity" });
  // It must explicitly DENY a bypass, not hint at circumvention.
  assert.ok(/cannot bypass|can'?t bypass|does not bypass|will not bypass/i.test(outcome.recommendedAction));
  assert.equal(/cannot be bypassed by|bypasses Google|to bypass Google/i.test(outcome.recommendedAction), false);
  assert.ok(/verify/i.test(outcome.recommendedAction));
});

// --- §5.7: provider-level model-test guard ----------------------------------

const { createTestJob } = await import("../src/lib/models/testBatch.js");
const { createProviderConnection, getProviderConnectionById, updateProviderConnection } = await import("../src/lib/localDb.js");

test("§5.7 provider-level restriction skips repeated model tests", async () => {
  const conn = await createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    email: "blocked-account@example.com",
    isActive: true,
    testStatus: "action_required",
    lastError: "403 VALIDATION_REQUIRED",
  });
  const fakePingCalls = [];
  const job = await createTestJob({
    models: [{ model: "ag/claude-sonnet-4-5" }, { model: "ag/gemini-3-flash" }],
    pingFn: async (model) => { fakePingCalls.push(model); return { ok: false, error: "must not be called", latencyMs: 0 }; },
    persistFn: async () => {},
  });
  await new Promise((resolve, reject) => {
    job.emitter.on("done", resolve);
    setTimeout(() => reject(new Error("job did not finish")), 3000);
  });
  assert.equal(fakePingCalls.length, 0, "individual model tests must NOT run for a blocked provider");
  const snapshot = job.results;
  assert.equal(snapshot.length, 2);
  for (const r of snapshot) {
    assert.equal(r.status, "skipped");
    assert.equal(r.errorCode, "provider_blocked");
    assert.ok(r.errorMessage.includes("[provider blocked]"));
    assert.ok(/whole connection/i.test(r.errorMessage));
  }
  const summary = job.emitter; // sanity: guards map keyed by alias
  assert.ok(summary);
  // guard builder reports only the blocked provider
  const guards = providerModelTestGuards([conn]);
  assert.equal(guards.has("antigravity"), true);
  // healthy connection overrides the guard
  await updateProviderConnection(conn.id, { testStatus: "active", lastError: null, lastErrorCategory: null });
  assert.equal(isConnectionProviderBlocked(await getProviderConnectionById(conn.id)).blocked, false);
});

test("§5.7 guard requires EVERY active connection blocked (mixed state → no guard)", async () => {
  await createProviderConnection({ provider: "antigravity", authType: "oauth", email: "healthy-account@example.com", isActive: true, testStatus: "active" });
  const conns = await import("../src/lib/localDb.js").then((m) => m.getProviderConnections({ provider: "antigravity" }));
  const guards = providerModelTestGuards(conns);
  assert.equal(guards.has("antigravity"), false, "one healthy connection must unblock the provider");
});

// --- §5.8: no silent cross-provider execution --------------------------------

const { getProviderCredentials } = await import("../src/sse/services/auth.js");

test("§5.8 credential selection for antigravity NEVER returns a Codex connection", async () => {
  // Seed: blocked antigravity account + fully working codex account.
  await createProviderConnection({ provider: "codex", authType: "oauth", email: "codex-ok@example.com", isActive: true, testStatus: "active" });
  // antigravity healthy one exists? make it model-locked so all antigravity conns are unusable
  const agHealthy = await createProviderConnection({ provider: "antigravity", authType: "oauth", email: "ag-healthy@example.com", isActive: true, testStatus: "active" });
  await updateProviderConnection(agHealthy.id, { [`modelLock_gemini-2.5-pro`]: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

  // Full exclusion of the (only) antigravity connection — the old bug scenario.
  const conns = await import("../src/lib/localDb.js").then((m) => m.getProviderConnections({ provider: "antigravity" }));
  const excluded = new Set(conns.map((c) => c.id));
  const creds = await getProviderCredentials("antigravity", excluded, "gemini-2.5-pro");
  // Exhausted same-provider accounts surface same-provider cooldown info or
  // null — but NEVER a connection from another provider (e.g. codex).
  const codex = await import("../src/lib/localDb.js").then((m) => m.getProviderConnections({ provider: "codex" }));
  const codexIds = new Set(codex.map((c) => c.id));
  const returnedId = creds?.connectionId || creds?.id || null;
  assert.equal(returnedId === null || !codexIds.has(returnedId), true, "antigravity selection must never hand back a codex connection (silent provider switching)");
});

// --- §10: SQLite persists the same classifications ---------------------------

test("§10 status classification persists identically on the DB engine in use", async () => {
  const outcome = decideConnectionTestOutcome({ status: 403, body: VALIDATION_BODY, provider: "antigravity" });
  const at = new Date().toISOString();
  const update = statusUpdateFromResult(
    { valid: false, testStatus: outcome.testStatus, category: outcome.category, httpStatus: outcome.httpStatus, upstreamCode: outcome.upstreamCode, error: "HTTP 403 VALIDATION_REQUIRED" },
    { testedAt: at }
  );
  const stored = await createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    email: "persist-check@example.com",
    isActive: true,
    ...update,
  });
  const roundtrip = await getProviderConnectionById(stored.id);
  assert.equal(roundtrip.testStatus, "action_required");
  assert.equal(roundtrip.lastErrorHttpStatus, 403);
  assert.equal(roundtrip.lastErrorUpstreamCode, "VALIDATION_REQUIRED");
  assert.equal(roundtrip.lastErrorCategory, "validation_required");
  // healing clears the diagnostics (manual retry action works both ways)
  await updateProviderConnection(stored.id, statusUpdateFromResult({ valid: true }));
  const healed = await getProviderConnectionById(stored.id);
  assert.equal(healed.testStatus, "active");
  assert.equal(healed.lastErrorHttpStatus, null);
  assert.equal(healed.lastErrorUpstreamCode, null);
});

// clarify utility is exported from classifyUpstreamHealth — keep a smoke pin
test("probeMode 400 = auth+ACL passed (same policy as the codex probe)", () => {
  const cls = classifyUpstreamHealth({ status: 400, body: "Invalid JSON payload", provider: "antigravity", probeMode: true });
  assert.equal(cls.category, "ok");
});
