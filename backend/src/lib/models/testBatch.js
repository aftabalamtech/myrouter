import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { pingModelByKind } from "../../routes/models/test/ping.js";
import { saveModelTestResult } from "./modelTestRepo.js";
import { providerModelTestGuards } from "./connectionHealth.js";
import { getProviderConnections } from "../localDb.js";
import { PROVIDER_ID_TO_ALIAS } from "../../../open-sse/config/providerModels.js";

export const DEFAULT_CONCURRENCY = 4;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 10;
export const DEFAULT_TIMEOUT_MS = 15000;
export const MIN_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 120000;
export const MAX_MODELS_PER_JOB = 200;
export const JOB_TTL_MS = 30 * 60 * 1000;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9-_]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  /(api[_-]?key|apikey|token|secret|password|cookie)\s*[:=]\s*['"]?[^'"\s,}]{4,}/gi,
];

export function sanitizeErrorMessage(message) {
  if (!message) return "";
  let out = String(message).slice(0, 240);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function classifyTestError({ status, error }) {
  const msg = String(error || "").toLowerCase();
  if (msg.includes("no active credentials") || msg.includes("all accounts unavailable")) return "no_connection";
  if (status === 408 || msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted") || msg.includes("timeouterror")) {
    return "timeout";
  }
  if (status === 401 || status === 403 || msg.includes("unauthorized") || msg.includes("invalid api key")
    || msg.includes("authentication") || msg.includes("forbidden")) {
    return "auth";
  }
  if (status === 429 || msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota")) {
    return "rate_limited";
  }
  if (status === 404 || msg.includes("not found") || msg.includes("no such model") || msg.includes("unknown model")) {
    return "not_found";
  }
  if (status >= 500 || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")
    || msg.includes("fetch failed") || msg.includes("socket") || msg.includes("econnreset") || msg.includes("etimedout")) {
    return "network";
  }
  if (status && status >= 400) return "provider";
  return "unknown";
}

export function isRetriableCode(code) {
  return code === "timeout" || code === "network" || code === "rate_limited";
}

export function normalizeModels(input) {
  const seen = new Set();
  const out = [];
  if (!Array.isArray(input)) return out;
  for (const entry of input) {
    const model = typeof entry === "string" ? entry : entry?.model;
    if (typeof model !== "string") continue;
    const trimmed = model.trim().slice(0, 200);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const kind = typeof entry?.kind === "string" ? entry.kind.trim().slice(0, 32) || "llm" : "llm";
    out.push({ model: trimmed, kind });
  }
  return out;
}

export function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(n)));
}

export function clampTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

function emptyCounters() {
  return { total: 0, pending: 0, testing: 0, passed: 0, failed: 0, inconclusive: 0, skipped: 0, cancelled: 0, timeout: 0 };
}

export function summarizeResults(results) {
  const counters = emptyCounters();
  counters.total = results.length;
  for (const r of results) {
    if (r.status === "passed") counters.passed += 1;
    else if (r.status === "failed") counters.failed += 1;
    else if (r.status === "inconclusive") counters.inconclusive += 1;
    else if (r.status === "timeout") { counters.timeout += 1; counters.inconclusive += 1; }
    else if (r.status === "skipped") counters.skipped += 1;
    else if (r.status === "cancelled") counters.cancelled += 1;
    else if (r.status === "testing") counters.testing += 1;
    else counters.pending += 1;
  }
  return counters;
}

const jobs = new Map();

function sweepExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      job.emitter.removeAllListeners();
      jobs.delete(id);
    }
  }
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function jobSnapshot(job) {
  return {
    jobId: job.id,
    status: job.status,
    concurrency: job.concurrency,
    timeoutMs: job.timeoutMs,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    current: job.current,
    summary: summarizeResults(job.results),
    results: job.results,
  };
}

async function runPingWithRetry({ pingFn, model, kind, timeoutMs, isCancelled }) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isCancelled()) return { cancelled: true, attempts };
    const outcome = await pingFn(model, kind, timeoutMs);
    attempts.push(outcome);
    const code = classifyTestError(outcome);
    if (outcome.ok) return { ok: true, outcome, code: null, attempts };
    if (attempt === 0 && isRetriableCode(code) && !isCancelled()) continue;
    return { ok: false, outcome, code, attempts };
  }
  return { ok: false, outcome: attempts[attempts.length - 1], code: "unknown", attempts };
}

function toResultRecord(entry, status, outcome, code) {
  return {
    modelId: entry.model,
    kind: entry.kind,
    status,
    latencyMs: outcome?.latencyMs ?? null,
    errorCode: status === "passed" ? null : (code || "unknown"),
    errorMessage: status === "passed" ? null : sanitizeErrorMessage(outcome?.error),
    testedAt: new Date().toISOString(),
  };
}

async function workerLoop(job) {
  while (true) {
    if (job.cancelled) return;
    const entry = job.queue.shift();
    if (!entry) return;
    const record = job.results.find((r) => r.modelId === entry.model);

    // Provider-level guard (task §2): a provider whose EVERY active
    // connection carries an account-level restriction (e.g. Google's
    // VALIDATION_REQUIRED eligibility gate) cannot succeed per-model.
    // Mark skipped with the shared reason instead of re-pinging each model.
    const providerAlias = String(entry.model).split("/")[0];
    const guard = job.providerGuards?.get(providerAlias);
    if (guard?.blocked) {
      record.status = "skipped";
      record.errorCode = "provider_blocked";
      record.errorMessage = sanitizeErrorMessage(guard.message);
      record.testedAt = new Date().toISOString();
      job.current = null;
      job.emitter.emit("update", jobSnapshot(job));
      continue;
    }

    record.status = "testing";
    job.current = entry.model;
    job.emitter.emit("update", jobSnapshot(job));

    let finalRecord;
    try {
      const { cancelled, ok, outcome, code } = await runPingWithRetry({
        pingFn: job.pingFn,
        model: entry.model,
        kind: entry.kind,
        timeoutMs: job.timeoutMs,
        isCancelled: () => job.cancelled,
      });
      if (cancelled || job.cancelled) {
        finalRecord = { ...record, status: "cancelled", testedAt: new Date().toISOString() };
      } else if (ok) {
        finalRecord = toResultRecord(entry, "passed", outcome, null);
      } else if (code === "no_connection") {
        finalRecord = toResultRecord(entry, "skipped", outcome, code);
      } else if (code === "timeout" || code === "network" || code === "rate_limited") {
        finalRecord = toResultRecord(entry, "inconclusive", outcome, code);
      } else {
        finalRecord = toResultRecord(entry, "failed", outcome, code);
      }
    } catch (err) {
      const message = err?.message || String(err);
      const code = classifyTestError({ status: null, error: message });
      const status = code === "timeout" || code === "network" || code === "rate_limited" ? "inconclusive" : "failed";
      finalRecord = toResultRecord(entry, status, { error: message }, code);
    }

    Object.assign(record, finalRecord);
    job.current = null;
    if (finalRecord.status === "passed" || finalRecord.status === "failed" || finalRecord.status === "inconclusive") {
      try {
        await job.persistFn(entry.model, finalRecord);
      } catch (err) {
        console.error("[test-batch] persist failed:", err?.message || err);
      }
    }
    job.emitter.emit("update", jobSnapshot(job));
  }
}

export async function createTestJob({ models, concurrency, timeoutMs, pingFn, persistFn }) {
  const entries = normalizeModels(models);
  if (entries.length === 0) {
    throw Object.assign(new Error("At least one model is required"), { statusCode: 400 });
  }
  if (entries.length > MAX_MODELS_PER_JOB) {
    throw Object.assign(new Error(`Too many models (max ${MAX_MODELS_PER_JOB})`), { statusCode: 400 });
  }
  sweepExpiredJobs();

  // Provider-level guards, keyed by model-string alias (e.g. "ag" →
  // antigravity guard). DB hiccups fail open: no guard, normal per-model
  // tests still run (task §2 guard is an optimization with safe fallback).
  let providerGuards = new Map();
  try {
    const connections = await getProviderConnections();
    const guards = providerModelTestGuards(connections);
    for (const [provider, g] of guards) {
      providerGuards.set(PROVIDER_ID_TO_ALIAS[provider] || provider, g);
    }
  } catch { /* no DB → no guards */ }

  const job = {
    id: randomUUID(),
    status: "running",
    concurrency: clampConcurrency(concurrency),
    timeoutMs: clampTimeoutMs(timeoutMs),
    queue: [...entries],
    results: entries.map((e) => ({
      modelId: e.model,
      kind: e.kind,
      status: "pending",
      latencyMs: null,
      errorCode: null,
      errorMessage: null,
      testedAt: null,
    })),
    current: null,
    cancelled: false,
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    finishedAt: null,
    emitter: new EventEmitter(),
    providerGuards,
    pingFn: pingFn || ((model, kind, ms) => pingModelByKind(model, kind, undefined, ms)),
    persistFn: persistFn || saveModelTestResult,
  };
  jobs.set(job.id, job);

  const workers = Array.from({ length: Math.min(job.concurrency, entries.length) }, () => workerLoop(job));
  Promise.all(workers).then(() => {
    if (job.cancelled) {
      for (const r of job.results) {
        if (r.status === "pending" || r.status === "testing") {
          r.status = "cancelled";
          r.testedAt = new Date().toISOString();
        }
      }
      job.status = "cancelled";
    } else {
      job.status = "done";
    }
    job.current = null;
    job.finishedAt = Date.now();
    job.emitter.emit("update", jobSnapshot(job));
    job.emitter.emit("done", jobSnapshot(job));
  }).catch((err) => {
    console.error("[test-batch] worker error:", err?.message || err);
    job.status = "done";
    job.finishedAt = Date.now();
    job.emitter.emit("done", jobSnapshot(job));
  });

  return job;
}

export function cancelTestJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status !== "running") return job;
  job.cancelled = true;
  return job;
}
