import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";

const POLL_INTERVAL_MS = 2000;

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── ModelBatchTest ─────────────────────────────────────────────
// Batch-tests a list of models with controlled concurrency.
// Props:
//   models: [{ id, fullModel, kind, isFree }]
//   disabled: true when testing is unavailable (e.g. no connections)
//   testResults: { [modelId]: "ok" | "error" } — for retry-failed
//   onResult(modelId, status): called per model ("testing" | "ok" | "error")
//   onBatchActiveChange(active): called when a batch starts/finishes
export default function ModelBatchTest({ models, disabled, testResults, onResult, onBatchActiveChange, onBatchEnd, scopeLocked }) {
  const [scope, setScope] = useState("all");
  const [timeoutMs, setTimeoutMs] = useState(15000);
  const [concurrency, setConcurrency] = useState(4);
  const [job, setJob] = useState(null); // { jobId, summary, current, startedAt }
  const [batchError, setBatchError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const activeRef = useRef(false);
  const cancelRef = useRef(false);
  const onResultRef = useRef(onResult);
  const onBatchActiveChangeRef = useRef(onBatchActiveChange);
  const onBatchEndRef = useRef(onBatchEnd);
  onResultRef.current = onResult;
  onBatchActiveChangeRef.current = onBatchActiveChange;
  onBatchEndRef.current = onBatchEnd;

  const stopTransports = useCallback(() => {
    if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopTransports(), [stopTransports]);

  // Elapsed timer while a batch is active
  useEffect(() => {
    if (!job) return;
    setElapsedMs(0);
    const t = setInterval(() => setJob((j) => (j ? { ...j, elapsedMs: Date.now() - j.startedAt } : j)), 1000);
    return () => clearInterval(t);
  }, [job?.jobId]);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    for (const r of snapshot.results || []) {
      if (r.status === "passed") onResultRef.current?.(r.modelId, "ok");
      else if (r.status === "failed") onResultRef.current?.(r.modelId, "error");
      else if (r.status === "inconclusive" || r.status === "timeout") onResultRef.current?.(r.modelId, "inconclusive");
      else if (r.status === "testing") onResultRef.current?.(r.modelId, "testing");
    }
    setJob((j) => (j ? {
      ...j,
      summary: snapshot.summary,
      current: snapshot.current,
      elapsedMs: snapshot.elapsedMs ?? j.elapsedMs,
      finished: snapshot.status !== "running",
      status: snapshot.status,
    } : j));
    if (snapshot.status !== "running") {
      activeRef.current = false;
      onBatchActiveChangeRef.current?.(false);
      onBatchEndRef.current?.(snapshot);
      stopTransports();
    }
  }, [stopTransports]);

  const pollSnapshot = useCallback(async (jobId) => {
    try {
      const res = await fetch(`/api/models/test-batch/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!res.ok) return;
      applySnapshot(await res.json());
    } catch { /* keep polling */ }
  }, [applySnapshot]);

  const startPolling = useCallback((jobId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (!activeRef.current) { clearInterval(pollRef.current); pollRef.current = null; return; }
      pollSnapshot(jobId);
    }, POLL_INTERVAL_MS);
  }, [pollSnapshot]);

  const subscribe = useCallback((jobId) => {
    stopTransports();
    let sseFailed = false;
    try {
      const es = new EventSource(`/api/models/test-batch/${encodeURIComponent(jobId)}/stream`);
      esRef.current = es;
      es.addEventListener("update", (e) => {
        try { applySnapshot(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("done", (e) => {
        try { applySnapshot(JSON.parse(e.data)); } catch {}
        stopTransports();
      });
      es.onerror = () => {
        if (sseFailed) return;
        sseFailed = true;
        try { es.close(); } catch {}
        esRef.current = null;
        startPolling(jobId); // SSE unavailable (proxy buffering?) — fall back to polling
      };
    } catch {
      startPolling(jobId);
    }
  }, [applySnapshot, startPolling, stopTransports]);

  // Resolves when a job leaves "running" (used to sequence >200-model chunks).
  const waitForJobDone = useCallback((jobId) => new Promise((resolve) => {
    const check = async () => {
      try {
        const res = await fetch(`/api/models/test-batch/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const snap = await res.json().catch(() => ({}));
        applySnapshot(snap);
        if (!activeRef.current || (snap && snap.status && snap.status !== "running")) return resolve();
      } catch { /* keep polling */ }
      setTimeout(check, 2000);
    };
    check();
  }), [applySnapshot]);

  const startBatch = useCallback(async (entries) => {
    if (activeRef.current || entries.length === 0) return;
    setBatchError("");
    activeRef.current = true;
    onBatchActiveChangeRef.current?.(true);
    setJob({ jobId: null, summary: null, current: null, startedAt: Date.now(), elapsedMs: 0, finished: false, status: "running" });
    // Backend caps a single job at 200 models: run larger lists as sequential chunks.
    const CHUNK = 200;
    const chunks = [];
    for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));
    let cancelled = false;
    cancelRef.current = false;
    try {
      for (const chunk of chunks) {
        if (cancelled || cancelRef.current) { cancelled = true; break; }
        activeRef.current = true; // applySnapshot flips it false at each chunk end
        const res = await fetch("/api/models/test-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            models: chunk.map((m) => ({ model: m.fullModel, kind: m.kind || "llm" })),
            concurrency,
            timeoutMs,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Failed to start batch (HTTP ${res.status})`);
        setJob((j) => ({ ...j, jobId: data.jobId, finished: false, status: "running", summary: null, current: null }));
        subscribe(data.jobId);
        await waitForJobDone(data.jobId);
        if (chunks.length > 1) pollSnapshot(data.jobId);
      }
    } catch (e) {
      if (activeRef.current) setBatchError(e.message);
      cancelled = true;
    } finally {
      if (cancelled || !activeRef.current) {
        activeRef.current = false;
        onBatchActiveChangeRef.current?.(false);
        if (cancelled) setJob(null);
      }
    }
  }, [pollSnapshot, subscribe, timeoutMs, concurrency]);

  const scopedModels = (s) => {
    if (s === "free") return models.filter((m) => m.isFree);
    if (s === "paid") return models.filter((m) => !m.isFree);
    return models;
  };

  const handleTestAll = () => startBatch(scopedModels(scope));

  const handleRetryFailed = () => {
    const failed = scopedModels(scope).filter((m) => testResults?.[m.id] === "error");
    startBatch(failed);
  };

  const handleCancel = async () => {
    const jobId = job?.jobId;
    cancelRef.current = true;
    if (!jobId) return;
    try {
      await fetch(`/api/models/test-batch/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    } catch {}
    pollSnapshot(jobId);
  };

  const failedCount = scopedModels(scope).filter((m) => testResults?.[m.id] === "error").length;
  const active = !!job && !job.finished;
  const summary = job?.summary;
  const done = summary ? (summary.passed + summary.failed + summary.skipped + summary.cancelled) : 0;
  const total = summary?.total ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="mb-4 rounded-lg border border-border bg-sidebar/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {!scopeLocked && (
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={active || disabled}
            className="text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:border-primary"
            title="Test scope"
          >
            <option value="all">All models</option>
            <option value="free">Free only</option>
            <option value="paid">Paid only</option>
          </select>
        )}
        <Button onClick={handleTestAll} disabled={active || disabled || scopedModels(scope).length === 0} variant="secondary">
          <span className="material-symbols-outlined text-sm mr-1">science</span>
          {active ? "Testing..." : `Test all (${scopedModels(scope).length})`}
        </Button>
        <select
          value={String(timeoutMs)}
          onChange={(e) => setTimeoutMs(Number(e.target.value))}
          disabled={active || disabled}
          className="text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:border-primary"
          title="Per-model timeout"
        >
          <option value="15000">15s timeout</option>
          <option value="30000">30s timeout</option>
          <option value="60000">60s timeout</option>
          <option value="120000">120s timeout</option>
        </select>
        <select
          value={String(concurrency)}
          onChange={(e) => setConcurrency(Number(e.target.value))}
          disabled={active || disabled}
          className="text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:border-primary"
          title="Parallel tests per batch (backend max 10)"
        >
          <option value="1">x1 serial</option>
          <option value="2">x2 parallel</option>
          <option value="4">x4 parallel</option>
          <option value="6">x6 parallel</option>
          <option value="10">x10 parallel</option>
        </select>
        {failedCount > 0 && !active && (
          <Button onClick={handleRetryFailed} disabled={disabled} variant="ghost">
            <span className="material-symbols-outlined text-sm mr-1">refresh</span>
            Retry failed ({failedCount})
          </Button>
        )}
        {active && (
          <Button onClick={handleCancel} variant="ghost">
            <span className="material-symbols-outlined text-sm mr-1">cancel</span>
            Cancel
          </Button>
        )}
        {active && summary && (
          <span className="text-xs text-text-muted ml-auto">
            {done} / {total} ({pct}%) · {formatElapsed(job.elapsedMs || 0)}
          </span>
        )}
      </div>

      {active && summary && (
        <div className="mt-2.5">
          <div className="h-1.5 rounded-full bg-background overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
            <span>Passed: <b className="text-green-500">{summary.passed}</b></span>
            <span>Failed: <b className="text-red-500">{summary.failed}</b></span>
            {summary.timeout > 0 && <span>Timeout: <b className="text-amber-500">{summary.timeout}</b></span>}
            {summary.cancelled > 0 && <span>Cancelled: <b>{summary.cancelled}</b></span>}
            {summary.testing > 0 && <span>Testing: <b>{summary.testing}</b></span>}
            <span>Pending: <b>{summary.pending}</b></span>
            {job.current && <span className="truncate max-w-full">Current: <code className="font-mono">{job.current}</code></span>}
          </div>
        </div>
      )}

      {job?.finished && summary && (
        <p className="mt-2 text-[11px] text-text-muted">
          Finished in {formatElapsed(job.elapsedMs || 0)} — {summary.passed} passed, {summary.failed} failed
          {summary.timeout > 0 && ` (${summary.timeout} timeout)`}
          {summary.cancelled > 0 && `, ${summary.cancelled} cancelled`} out of {summary.total}.
        </p>
      )}

      {batchError && <p className="mt-2 text-xs text-red-500 break-words">{batchError}</p>}
      {disabled && <p className="mt-2 text-[11px] text-text-muted">Add a connection for this provider to enable testing.</p>}
    </div>
  );
}

ModelBatchTest.propTypes = {
  models: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    fullModel: PropTypes.string.isRequired,
    kind: PropTypes.string,
    isFree: PropTypes.bool,
  })).isRequired,
  disabled: PropTypes.bool,
  testResults: PropTypes.object,
  onResult: PropTypes.func.isRequired,
  onBatchActiveChange: PropTypes.func,
  onBatchEnd: PropTypes.func,
  scopeLocked: PropTypes.bool,
};
