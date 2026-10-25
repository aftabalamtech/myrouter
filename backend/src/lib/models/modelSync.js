import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { makeKv } from "../db/helpers/kvStore.js";
import { getProviderConnections } from "../localDb.js";
import { fetchConnectionModels, mergeConnectionModels } from "./modelDiscovery.js";
import { normalizeSyncSettings, normalizeAutoAddPolicy } from "./autoAdd.js";

export { normalizeSyncSettings, normalizeAutoAddPolicy };

export const SYNC_CONCURRENCY = 2;
export const SYNC_TIMEOUT_MS = 45000;
export const SYNC_MAX_CONNECTIONS = 20;
export const SYNC_JOB_TTL_MS = 30 * 60 * 1000;
export const AUTO_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

const settingsKv = makeKv("providerModelSync");
const syncedKv = makeKv("syncedModels");

export function syncedKey(storageAlias, modelId) {
  return `${storageAlias}|${modelId}`;
}

export async function getSyncSettings(providerId) {
  return normalizeSyncSettings(await settingsKv.get(providerId, null));
}

export async function updateSyncSettings(providerId, patch) {
  const current = await getSyncSettings(providerId);
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) clean[key] = value;
  }
  // lastSyncAt is append-only metadata: only markSyncTimestamp() may set it,
  // so a settings PATCH can never wipe or forge it.
  const next = normalizeSyncSettings({ ...current, ...clean, lastSyncAt: current.lastSyncAt || null });
  await settingsKv.set(providerId, next);
  return next;
}

export async function markSyncTimestamp(providerId) {
  const current = await getSyncSettings(providerId);
  const next = { ...current, lastSyncAt: new Date().toISOString() };
  await settingsKv.set(providerId, next);
  return next;
}

export async function getSyncedModels(storageAlias) {
  const all = await syncedKv.getAll();
  const out = {};
  if (storageAlias) {
    const prefix = `${storageAlias}|`;
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(prefix)) out[key] = value;
    }
    return out;
  }
  return all;
}

export async function clearSyncedModels(storageAlias) {
  if (!storageAlias) return 0;
  const existing = await getSyncedModels(storageAlias);
  let removed = 0;
  for (const key of Object.keys(existing)) {
    await syncedKv.remove(key);
    removed += 1;
  }
  return removed;
}

// Persist discovered models: add new, update changed metadata, mark stale ones
// that disappeared upstream. Manual stores (aliases/custom) are never touched.
export async function persistDiscovered({ storageAlias, discovered, manualIds, failedConnectionIds }) {
  const manual = new Set(manualIds || []);
  const failed = new Set(failedConnectionIds || []);
  const existing = await getSyncedModels(storageAlias);
  const seen = new Set();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;

  for (const m of discovered) {
    const key = syncedKey(storageAlias, m.id);
    seen.add(key);
    const record = {
      ...m,
      storageAlias,
      fullModel: `${storageAlias}/${m.id}`,
      source: "synced",
      manual: manual.has(m.id),
      stale: false,
      syncedAt: now,
    };
    const prev = existing[key];
    if (!prev) {
      added += 1;
      await syncedKv.set(key, record);
      existing[key] = record;
      continue;
    }
    // Idempotent update: a repeated sync with unchanged metadata is a no-op,
    // and any change is merged so fields owned by other paths (a manual flag,
    // an upstreamModelId captured earlier) are not silently dropped.
    const mergedRecord = { ...prev, ...record, manual: prev.manual || record.manual };
    if (JSON.stringify({ ...prev, syncedAt: null, stale: null }) !== JSON.stringify({ ...mergedRecord, syncedAt: null, stale: null })) {
      mergedRecord.syncedAt = now;
      await syncedKv.set(key, mergedRecord);
      existing[key] = mergedRecord;
      updated += 1;
    } else if (prev.stale) {
      // A model that reappears upstream must be revived (stale → false).
      mergedRecord.stale = false;
      mergedRecord.syncedAt = now;
      await syncedKv.set(key, mergedRecord);
      existing[key] = mergedRecord;
      updated += 1;
    }
  }

  let stale = 0;
  for (const [key, record] of Object.entries(existing)) {
    if (seen.has(key) || record?.stale) continue;
    if (record?.manual) continue;
    const recordConns = record?.connectionIds || (record?.connectionId ? [record.connectionId] : []);
    if (failed.size > 0 && recordConns.some((cid) => failed.has(cid))) continue;
    await syncedKv.set(key, { ...record, stale: true });
    stale += 1;
  }

  return { added, updated, stale };
}

const jobs = new Map();
const activeSyncs = new Map(); // lock key -> jobId (prevents overlapping syncs)

function sweepExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > SYNC_JOB_TTL_MS) {
      job.emitter.removeAllListeners();
      jobs.delete(id);
    }
  }
}

export function getSyncJob(jobId) {
  return jobs.get(jobId) || null;
}

export function syncJobSnapshot(job) {
  return {
    jobId: job.id,
    providerId: job.providerId,
    storageAlias: job.storageAlias,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    current: job.current,
    connections: job.connectionStates,
    summary: job.summary,
    error: job.error,
  };
}

function emptySummary() {
  return {
    discovered: 0, added: 0, updated: 0, stale: 0, failed: 0, connections: 0,
    partial: false, preserved: 0, lastSyncAt: null,
  };
}

async function discoverWithRetry(discoverFn, connectionId, isCancelled) {
  let last = { models: [], error: "unknown", status: null };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isCancelled()) return { ...last, cancelled: true };
    last = await discoverFn(connectionId);
    if (last.models.length > 0 || last.cancelled) return last;
    // Retry transient failures only: network/timeout, never auth errors.
    const transient = last.status === null || last.status === 429 || (last.status >= 500 && last.status < 600);
    if (!transient || isCancelled()) return last;
  }
  return last;
}

async function runSyncJob(job) {
  const startedAt = Date.now();
  try {
    const allConnections = await job.resolveConnections();
    let eligible = allConnections.filter((c) => c.provider === job.providerId && c.isActive !== false);
    if (job.connectionIds?.length) {
      const wanted = new Set(job.connectionIds);
      eligible = eligible.filter((c) => wanted.has(c.id));
    }
    eligible = eligible.slice(0, SYNC_MAX_CONNECTIONS);
    if (eligible.length === 0) {
      // Credential-free providers (opencode, local-device, local TTS, searxng)
      // have no connections by design. Fall back to their public catalog
      // instead of failing, otherwise their models can never be registered.
      if (job.noAuthDiscoverFn) {
        job.current = job.providerId;
        job.emitter.emit("update", syncJobSnapshot(job));
        const result = await job.noAuthDiscoverFn(job.providerId);
        if (result.models.length > 0) {
          const persist = await persistDiscovered({
            storageAlias: job.storageAlias,
            discovered: result.models,
            manualIds: job.manualIds,
          });
          job.summary.discovered = result.models.length;
          job.summary.added = persist.added;
          job.summary.updated = persist.updated;
          job.summary.stale = persist.stale;
          const stamped = await markSyncTimestamp(job.providerId);
          job.summary.lastSyncAt = stamped.lastSyncAt;
          job.summary.durationMs = Date.now() - startedAt;
        } else {
          job.summary.failed = 1;
          job.error = result.error || "No models discovered";
        }
      } else {
        job.error = "No active connections for this provider";
      }
      job.status = "done";
      job.current = null;
      job.finishedAt = Date.now();
      job.emitter.emit("update", syncJobSnapshot(job));
      job.emitter.emit("done", syncJobSnapshot(job));
      return;
    }

    job.summary.connections = eligible.length;
    const perConnection = [];
    const queue = [...eligible];
    const worker = async () => {
      while (queue.length && !job.cancelled) {
        const conn = queue.shift();
        const state = job.connectionStates.find((s) => s.connectionId === conn.id);
        state.status = "syncing";
        job.current = conn.name || conn.email || conn.id;
        job.emitter.emit("update", syncJobSnapshot(job));
        const result = await discoverWithRetry(job.discoverFn, conn.id, () => job.cancelled);
        if (result.cancelled || job.cancelled) {
          state.status = "cancelled";
        } else if (result.models.length > 0) {
          state.status = "done";
          state.discovered = result.models.length;
          perConnection.push({ connectionId: conn.id, models: result.models });
        } else {
          state.status = "failed";
          state.error = String(result.error || "Discovery failed").slice(0, 240);
          job.summary.failed += 1;
        }
        job.emitter.emit("update", syncJobSnapshot(job));
      }
    };
    const workers = Array.from(
      { length: Math.min(SYNC_CONCURRENCY, eligible.length) },
      () => worker()
    );
    await Promise.all(workers);

    if (job.cancelled) {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job.emitter.emit("done", syncJobSnapshot(job));
      return;
    }

    const merged = mergeConnectionModels(perConnection);
    job.summary.discovered = merged.length;

    const failedConnectionIds = job.connectionStates
      .filter((s) => s.status === "failed")
      .map((s) => s.connectionId);

    // Every connection failed / returned an empty catalog. Do NOT touch the
    // stored catalog: an unreachable or empty upstream (rate limit, auth
    // expiry, gateway outage, provider that simply has no /models endpoint)
    // must never be interpreted as "the user removed all these models".
    // Previously this path called persistDiscovered with an empty list, which
    // marked the ENTIRE existing catalog stale — i.e. a transient upstream
    // failure silently emptied the provider's model list.
    if (merged.length === 0) {
      job.summary.preserved = Object.keys(await getSyncedModels(job.storageAlias)).length;
      job.error = job.summary.failed > 0
        ? "No models discovered — every connection failed. Your existing models were kept."
        : "Upstream returned an empty model list. Your existing models were kept.";
      job.summary.durationMs = Date.now() - startedAt;
      job.status = "done";
      job.current = null;
      job.finishedAt = Date.now();
      job.emitter.emit("update", syncJobSnapshot(job));
      job.emitter.emit("done", syncJobSnapshot(job));
      return;
    }

    const persist = await persistDiscovered({
      storageAlias: job.storageAlias,
      discovered: merged,
      manualIds: job.manualIds,
      failedConnectionIds,
    });
    job.summary.added = persist.added;
    job.summary.updated = persist.updated;
    job.summary.stale = persist.stale;
    // A partial sync (some connections failed) still refreshes the catalog from
    // the connections that DID answer, so this is recorded explicitly.
    job.summary.partial = job.summary.failed > 0;
    const stamped = await markSyncTimestamp(job.providerId);
    job.summary.lastSyncAt = stamped.lastSyncAt;
    job.summary.durationMs = Date.now() - startedAt;
    job.status = "done";
    job.current = null;
    job.finishedAt = Date.now();
    job.emitter.emit("update", syncJobSnapshot(job));
    job.emitter.emit("done", syncJobSnapshot(job));
  } catch (err) {
    job.status = "done";
    job.error = String(err?.message || "Sync failed").slice(0, 240);
    job.finishedAt = Date.now();
    job.emitter.emit("done", syncJobSnapshot(job));
  } finally {
    if (activeSyncs.get(job.lockKey) === job.id) activeSyncs.delete(job.lockKey);
  }
}

function validateId(value, label) {
  if (typeof value !== "string" || !value || value.length > 200) {
    throw Object.assign(new Error(`${label} is required`), { statusCode: 400 });
  }
  return value;
}

export async function createSyncJob({ providerId, storageAlias, connectionIds, manualIds, discoverFn, resolveConnections, noAuthDiscoverFn }) {
  validateId(providerId, "providerId");
  validateId(storageAlias, "storageAlias");
  sweepExpiredJobs();
  // Overlap prevention is scoped to provider+connection set so parallel
  // providers never block each other.
  const keyParts = [providerId, ...[...(connectionIds || [])].sort()];
  const lockKey = keyParts.join("|");
  const existing = activeSyncs.get(lockKey);
  if (existing && jobs.get(existing)?.status === "running") {
    throw Object.assign(new Error("A sync is already running for this scope"), { statusCode: 409 });
  }

  const job = {
    id: randomUUID(),
    providerId,
    storageAlias,
    connectionIds: Array.isArray(connectionIds) ? connectionIds.filter((c) => typeof c === "string").slice(0, SYNC_MAX_CONNECTIONS) : null,
    manualIds: Array.isArray(manualIds) ? manualIds : [],
    status: "running",
    cancelled: false,
    current: null,
    connectionStates: [],
    summary: emptySummary(),
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    finishedAt: null,
    emitter: new EventEmitter(),
    lockKey,
    discoverFn: discoverFn || ((connectionId) => fetchConnectionModels(connectionId)),
    // Only meaningful for noAuth providers; keeps the dependency lazy so the
    // suggested-models filter table is not pulled into every sync import path.
    noAuthDiscoverFn: noAuthDiscoverFn || null,
    resolveConnections: resolveConnections || (() => getProviderConnections({ isActive: true })),
  };
  jobs.set(job.id, job);
  activeSyncs.set(lockKey, job.id);

  // Seed connection states lazily once eligible connections resolve; run async.
  job.resolveConnections().then((all) => {
    let eligible = all.filter((c) => c.provider === providerId && c.isActive !== false);
    if (job.connectionIds?.length) {
      const wanted = new Set(job.connectionIds);
      eligible = eligible.filter((c) => wanted.has(c.id));
    }
    job.connectionStates = eligible.slice(0, SYNC_MAX_CONNECTIONS).map((c) => ({
      connectionId: c.id,
      name: c.name || c.email || c.id,
      status: "pending",
      discovered: 0,
      error: null,
    }));
    runSyncJob(job);
  }).catch((err) => {
    job.status = "done";
    job.error = String(err?.message || "Sync failed").slice(0, 240);
    job.finishedAt = Date.now();
    activeSyncs.delete(lockKey);
    job.emitter.emit("done", syncJobSnapshot(job));
  });

  return job;
}

export function cancelSyncJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === "running") job.cancelled = true;
  return job;
}
