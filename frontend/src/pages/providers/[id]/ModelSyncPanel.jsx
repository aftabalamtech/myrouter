import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import DiscoveredModelsSection from "./DiscoveredModelsSection";
import {
  AUTO_ADD_POLICIES,
  AUTO_ADD_POLICY_LABELS,
  AUTO_ADD_POLICY_DESCRIPTIONS,
  normalizeAutoAddPolicy,
  resolveAutoAdd,
  stableModelId,
} from "@/shared/utils/discoveredModels";

const POLL_INTERVAL_MS = 2500;
const AUTO_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

function formatTime(iso) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── ModelSyncPanel ─────────────────────────────────────────────
// Upstream discovery + sync controls for one provider.
// Props:
//   providerId, providerStorageAlias, providerLabel
//   connections: provider connections (active ones are eligible)
//   modelAliases: { alias: fullModel } (manual store — never modified here)
//   hardcodedIds: built-in model ids for this provider
//   testResults: { [bareModelId]: "ok" | "error" } latest valid tests
//   disabledIds: model ids currently in the Disabled system
//   onAddModel(modelId): add a discovered model (creates alias)
//   onCatalogChanged(): refresh parent lists after sync/clear
export default function ModelSyncPanel({
  providerId, providerStorageAlias, providerLabel,
  connections, modelAliases, hardcodedIds, testResults, disabledIds,
  isCustomProvider, onAddModel, onTestResult, onCatalogChanged,
}) {
  const [settings, setSettings] = useState({ autoFetch: false, autoSync: false, lastSyncAt: null, autoAdd: false, autoAddPolicy: "working-only", includeUntested: false });
  const [status, setStatus] = useState({ syncedCount: 0, staleCount: 0 });
  const [catalog, setCatalog] = useState([]);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [autoAddSummary, setAutoAddSummary] = useState(null);
  const [showAutoAddMenu, setShowAutoAddMenu] = useState(false);
  const autoAddAnchorRef = useRef(null);
  const autoAddMenuRef = useRef(null);
  // Discovery panel visibility. Opens on the first sync of a session and
  // reopens on demand; Close only hides it — the persisted catalog and every
  // model state are untouched, so reopening shows the same results.
  const [panelOpen, setPanelOpen] = useState(false);
  const [catalogSeen, setCatalogSeen] = useState(false);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const activeRef = useRef(false);
  const autoRanRef = useRef({ fetch: false, sync: false });
  const autoAppliedRef = useRef({}); // jobId -> true (auto-add runs once per sync)
  const onCatalogChangedRef = useRef(onCatalogChanged);
  onCatalogChangedRef.current = onCatalogChanged;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const base = `/api/providers/${encodeURIComponent(providerId)}/sync-models`;
  const storageQuery = `?storageAlias=${encodeURIComponent(providerStorageAlias)}`;

  const stopTransports = useCallback(() => {
    if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopTransports(), [stopTransports]);

  const refreshStatus = useCallback(async (withCatalog) => {
    try {
      const url = withCatalog ? `${base}${storageQuery}&include=catalog` : `${base}${storageQuery}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings) setSettings(data.settings);
      setStatus({ syncedCount: data.syncedCount || 0, staleCount: data.staleCount || 0 });
      if (Array.isArray(data.catalog)) setCatalog(data.catalog);
    } catch { /* ignore */ }
  }, [base, storageQuery]);

  useEffect(() => { refreshStatus(true); }, [refreshStatus]);

  // On mount, reveal the panel when a catalog already exists so a page refresh
  // shows the persisted discovery results instead of an empty-looking section.
  useEffect(() => {
    if (!catalogSeen && status.syncedCount > 0) {
      setPanelOpen(true);
      setCatalogSeen(true);
    }
  }, [status.syncedCount, catalogSeen]);

  const applyAutoAdd = useCallback(async (jobId) => {
    // Auto-Add runs once per finished sync job, using the latest persisted
    // test results (never force-testing the catalog here — that would hammer
    // upstream providers). Manual models and manual disables are preserved:
    // resolution only ever creates aliases or disables failed discoveries.
    if (!jobId || autoAppliedRef.current[jobId]) return;
    autoAppliedRef.current[jobId] = true;
    const s = settingsRef.current;
    if (!s.autoAdd) return;
    try {
      const res = await fetch(`/api/models/test-results?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      const persisted = data?.results || {};
      const bareResults = {};
      const prefix = `${providerStorageAlias}/`;
      for (const [full, rec] of Object.entries(persisted)) {
        const st = typeof rec === "string" ? rec : rec?.status;
        const id = typeof full === "string" && full.startsWith(prefix) ? full.slice(prefix.length) : null;
        if (!id) continue;
        if (st === "passed" || st === "ok") bareResults[id] = "ok";
        else if (st === "failed" || st === "timeout" || st === "error") bareResults[id] = "error";
      }
      // In-session results (parent) win over persisted ones.
      const merged = { ...bareResults, ...(testResultsRef.current || {}) };
      const addedFull = new Set(Object.values(modelAliasesRef.current || {}).filter((v) => typeof v === "string"));
      const hardcoded = new Set(hardcodedIdsRef.current || []);
      const seen = new Set();
      const unadded = [];
      for (const m of catalogRef.current || []) {
        const id = stableModelId(m?.id);
        if (!id || m?.stale || seen.has(id)) continue;
        seen.add(id);
        if (addedFull.has(`${providerStorageAlias}/${id}`) || hardcoded.has(id)) continue;
        unadded.push({ ...m, id, fullModel: `${providerStorageAlias}/${id}` });
      }
      // Rows carry bare ids; the resolver reads test status by bare id.
      const rowsForPolicy = unadded.map((r) => ({ id: r.id, isAdded: false }));
      const { toAdd, toDisable } = resolveAutoAdd({
        discoveredRows: rowsForPolicy,
        testResults: merged,
        disabledIds: disabledIdsRef.current || [],
        policy: normalizeAutoAddPolicy(s.autoAddPolicy),
        includeUntested: !!s.includeUntested,
      });
      let added = 0;
      let failed = 0;
      if (toAdd.length > 0) {
        const payload = toAdd.map((id) => ({
          model: `${providerStorageAlias}/${id}`,
          alias: String(id).split("/").pop() || id,
        }));
        try {
          const r = await fetch("/api/models/alias", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ models: payload }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || "Auto-add failed");
          added = d.added || 0;
          failed = d.failed || 0;
        } catch {
          // Fallback: existing single-add path, one by one.
          for (const id of toAdd) {
            try {
              await onAddModelRef.current?.(id);
              added += 1;
            } catch {
              failed += 1;
            }
          }
        }
      }
      let disabled = 0;
      if (toDisable.length > 0) {
        const r = await fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerAlias: providerStorageAlias, ids: toDisable }),
        });
        if (r.ok) disabled = toDisable.length;
      }
      if (toAdd.length > 0 || toDisable.length > 0) {
        setAutoAddSummary({ added, failed, disabled, policy: normalizeAutoAddPolicy(s.autoAddPolicy) });
        onCatalogChangedRef.current?.();
      }
    } catch (e) {
      setAutoAddSummary({ added: 0, failed: 0, disabled: 0, policy: normalizeAutoAddPolicy(settingsRef.current.autoAddPolicy), error: e?.message || "Auto-add failed" });
    }
  }, [providerStorageAlias]);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setJob((j) => (j ? { ...j, ...snapshot, finished: snapshot.status !== "running" } : j));
    if (snapshot.status !== "running") {
      activeRef.current = false;
      stopTransports();
      refreshStatus(true);
      onCatalogChangedRef.current?.();
      const finishedId = snapshot.jobId;
      if (settingsRef.current.autoAdd && finishedId) {
        // Defer one tick so the refreshed catalog state has landed.
        setTimeout(() => applyAutoAdd(finishedId), 0);
      }
    }
  }, [refreshStatus, stopTransports, applyAutoAdd]);

  const pollSnapshot = useCallback(async (jobId) => {
    try {
      const res = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!res.ok) return;
      applySnapshot(await res.json());
    } catch { /* keep polling */ }
  }, [applySnapshot, base]);

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
      const es = new EventSource(`${base}/jobs/${encodeURIComponent(jobId)}/stream`);
      esRef.current = es;
      es.addEventListener("update", (e) => { try { applySnapshot(JSON.parse(e.data)); } catch {} });
      es.addEventListener("done", (e) => { try { applySnapshot(JSON.parse(e.data)); } catch {} stopTransports(); });
      es.onerror = () => {
        if (sseFailed) return;
        sseFailed = true;
        try { es.close(); } catch {}
        esRef.current = null;
        startPolling(jobId);
      };
    } catch {
      startPolling(jobId);
    }
  }, [applySnapshot, startPolling, stopTransports, base]);

  const manualIds = useManualIds(modelAliases, providerStorageAlias);

  // Refs for async callbacks (avoid stale closures across long sync jobs).
  const modelAliasesRef = useRef(modelAliases);
  modelAliasesRef.current = modelAliases;
  const onAddModelRef = useRef(onAddModel);
  onAddModelRef.current = onAddModel;
  const testResultsRef = useRef(testResults);
  testResultsRef.current = testResults;
  const disabledIdsRef = useRef(disabledIds);
  disabledIdsRef.current = disabledIds;
  const hardcodedIdsRef = useRef(hardcodedIds);
  hardcodedIdsRef.current = hardcodedIds;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const startSync = useCallback(async () => {
    if (activeRef.current) return null;
    setError("");
    setAutoAddSummary(null);
    // Sync Now opens/expands the discovery panel so the user can review the
    // results as soon as they land.
    setPanelOpen(true);
    activeRef.current = true;
    setJob({ status: "running", summary: null, connections: [], current: null, startedAt: Date.now(), finished: false });
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageAlias: providerStorageAlias, manualIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Sync failed (HTTP ${res.status})`);
      setJob((j) => ({ ...j, jobId: data.jobId }));
      subscribe(data.jobId);
      pollSnapshot(data.jobId);
      return data.jobId;
    } catch (e) {
      setError(e.message);
      activeRef.current = false;
      setJob(null);
      return null;
    }
  }, [base, providerStorageAlias, manualIds, subscribe, pollSnapshot]);

  const handleCancel = useCallback(async () => {
    const jobId = job?.jobId;
    if (!jobId) return;
    try {
      await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    } catch {}
    pollSnapshot(jobId);
  }, [base, job?.jobId, pollSnapshot]);

  // NOTE: the "Clear All Models" button and its handler were removed from this
  // panel. The button was destructive and misleadingly named — it only cleared
  // the synced catalog while leaving added models untouched — and it sat among
  // the ON/OFF toggles where it read like one of them. Individual model
  // removal stays available on each row of the Added models list, and
  // `DELETE /api/providers/[id]/sync-models` remains available for scripted
  // use; the Undo-free bulk path is deliberately not offered in the UI.

  const toggleSetting = useCallback(async (key) => {
    const next = !settings[key];
    setSettings((s) => ({ ...s, [key]: next }));
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.settings) setSettings((s) => ({ ...s, ...data.settings }));
    } catch {
      setSettings((s) => ({ ...s, [key]: !next }));
    }
  }, [base, settings]);

  const setAutoAddPolicy = useCallback(async (policy) => {
    const value = normalizeAutoAddPolicy(policy);
    setSettings((s) => ({ ...s, autoAddPolicy: value }));
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoAddPolicy: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.settings) setSettings((s) => ({ ...s, ...data.settings }));
    } catch { /* keep optimistic value */ }
  }, [base]);

  // ── Auto-Add policy dropdown positioning ─────────────────────────
  // Rendered through a PORTAL at <body> level with FIXED coordinates computed
  // from the toggle button's rect. Root cause of the old overlap bug: an
  // `absolute z-50` menu inside the panel card got clipped by ancestor
  // `overflow` rules and painted UNDER sibling provider cards — those cards
  // create their own stacking contexts (borders/opacity/hover), so no local
  // z-index could ever win. A body-level portal escapes every ancestor
  // stacking context and overflow clip at once — not a z-index arms race.
  const [menuPos, setMenuPos] = useState(null); // { top, left, maxHeight } | null
  useLayoutEffectForMenu(showAutoAddMenu, autoAddAnchorRef, setMenuPos);

  // Close on Escape and on scroll/resize (fixed position does not follow the
  // anchor); outside mousedown is handled by the portal backdrop.
  useEffect(() => {
    if (!showAutoAddMenu) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowAutoAddMenu(false);
        autoAddAnchorRef.current?.focus?.();
      }
    };
    const onReposition = () => setShowAutoAddMenu(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [showAutoAddMenu]);

  const activeConnections = (connections || []).filter((c) => c.isActive !== false);
  // Credential-free providers (opencode, local-device, local TTS, searxng) are
  // synced from their public catalog and have no connections by design, so they
  // must not be blocked by the connection requirement.
  const isNoAuth = Boolean(AI_PROVIDERS[providerId]?.noAuth);
  const canSync = (activeConnections.length > 0 || isNoAuth) && !job?.jobId;
  const running = !!job && !job.finished;
  const summary = job?.summary;

  // Auto-fetch: catalog empty + nothing added yet → sync once (opt-in only).
  useEffect(() => {
    if (!settings.autoFetch || autoRanRef.current.fetch || activeRef.current) return;
    if (activeConnections.length === 0 && !isNoAuth) return;
    if (status.syncedCount > 0) return;
    const prefix = `${providerStorageAlias}/`;
    const hasAdded = Object.values(modelAliases || {}).some((f) => typeof f === "string" && f.startsWith(prefix));
    if (hasAdded) return;
    autoRanRef.current.fetch = true;
    startSync();
  }, [settings.autoFetch, activeConnections.length, isNoAuth, status.syncedCount, modelAliases, providerStorageAlias, startSync]);

  // Auto-sync: refresh when never synced or cooldown elapsed (opt-in only).
  useEffect(() => {
    if (!settings.autoSync || autoRanRef.current.sync || activeRef.current) return;
    if (activeConnections.length === 0 && !isNoAuth) return;
    const last = settings.lastSyncAt ? new Date(settings.lastSyncAt).getTime() : 0;
    if (Date.now() - last < AUTO_SYNC_COOLDOWN_MS) return;
    autoRanRef.current.sync = true;
    startSync();
  }, [settings.autoSync, settings.lastSyncAt, activeConnections.length, isNoAuth, startSync]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-sidebar/30 px-3 py-2.5 mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => toggleSetting("autoFetch")}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${settings.autoFetch ? "border-primary text-primary" : "border-border text-text-muted"}`}
          title="Automatically discover upstream models when the catalog is empty"
        >
          <span className={`w-6 h-3.5 rounded-full relative transition-colors ${settings.autoFetch ? "bg-primary" : "bg-border"}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${settings.autoFetch ? "left-3" : "left-0.5"}`} />
          </span>
          Auto-fetch upstream models
        </button>
        <button
          onClick={() => toggleSetting("autoSync")}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${settings.autoSync ? "border-primary text-primary" : "border-border text-text-muted"}`}
          title="Refresh upstream models automatically (at most once per hour)"
        >
          <span className={`w-6 h-3.5 rounded-full relative transition-colors ${settings.autoSync ? "bg-primary" : "bg-border"}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${settings.autoSync ? "left-3" : "left-0.5"}`} />
          </span>
          Auto-Sync
        </button>
        <div className="relative">
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${settings.autoAdd ? "border-primary text-primary" : "border-border text-text-muted"}`}
            title="Automatically add newly discovered models after each sync, using the selected policy"
          >
            <button
              onClick={() => toggleSetting("autoAdd")}
              className="flex items-center gap-1.5"
              aria-label="Toggle auto-add models"
            >
              <span className={`w-6 h-3.5 rounded-full relative transition-colors ${settings.autoAdd ? "bg-primary" : "bg-border"}`}>
                <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${settings.autoAdd ? "left-3" : "left-0.5"}`} />
              </span>
              Auto-Add Models
            </button>
            <button
              ref={autoAddAnchorRef}
              onClick={() => setShowAutoAddMenu((v) => !v)}
              className="pl-1 text-text-muted hover:text-primary"
              title="Auto-Add policy settings"
              aria-label="Auto-Add policy settings"
              aria-haspopup="menu"
              aria-expanded={showAutoAddMenu}
            >
              <span className={`material-symbols-outlined text-sm transition-transform ${showAutoAddMenu ? "rotate-180" : ""}`}>expand_more</span>
            </button>
          </div>
          {showAutoAddMenu && menuPos && createPortal(
            <>
              {/* Full-viewport backdrop: catches outside clicks at ANY depth
                  (sibling cards, page shell) and closes the menu. */}
              <div
                className="fixed inset-0"
                style={{ zIndex: 90 }}
                onMouseDown={() => setShowAutoAddMenu(false)}
                aria-hidden="true"
              />
              <div
                ref={autoAddMenuRef}
                role="menu"
                aria-label="Auto-Add policy"
                className="fixed w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-background shadow-xl"
                style={{
                  zIndex: 91,
                  top: menuPos.top,
                  left: menuPos.left,
                  maxHeight: menuPos.maxHeight,
                  overflowY: "auto",
                }}
              >
                <div className="sticky top-0 bg-background px-3 pt-3 pb-2 border-b border-border/60">
                  <p className="text-[11px] font-semibold text-text-main">
                    Auto-Add policy
                  </p>
                  <p className="text-[10px] text-text-muted mt-0.5">
                    Currently: {AUTO_ADD_POLICY_LABELS[normalizeAutoAddPolicy(settings.autoAddPolicy)]}
                  </p>
                </div>
                <div className="flex flex-col gap-1 p-2">
                  {AUTO_ADD_POLICIES.map((p) => {
                    const selected = normalizeAutoAddPolicy(settings.autoAddPolicy) === p;
                    return (
                      <button
                        key={p}
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => setAutoAddPolicy(p)}
                        className={`text-left px-2.5 py-2 rounded-lg border text-[11px] transition-colors ${selected ? "border-primary text-primary bg-primary/5" : "border-transparent text-text-muted hover:text-text-main hover:bg-sidebar"}`}
                      >
                        <span className="font-medium flex items-center gap-1.5">
                          {selected && <span className="material-symbols-outlined text-[13px]">check</span>}
                          {AUTO_ADD_POLICY_LABELS[p]}
                        </span>
                        <span className="block opacity-80 mt-0.5">{AUTO_ADD_POLICY_DESCRIPTIONS[p]}</span>
                      </button>
                    );
                  })}
                </div>
                <label
                  className="flex items-start gap-1.5 px-3 pb-2 text-[11px] text-text-muted cursor-pointer"
                  title="Off by default. When on, discovered models with no test result are also added as working models."
                >
                  <input
                    type="checkbox"
                    checked={!!settings.includeUntested}
                    onChange={() => toggleSetting("includeUntested")}
                    className="mt-0.5 accent-[var(--color-primary)]"
                  />
                  <span>Also add untested models <span className="opacity-70">(off by default)</span></span>
                </label>
                <p className="px-3 pb-3 text-[10px] text-text-muted">
                  Applies after each sync using the latest test results. Never duplicates, never re-enables manually disabled models.
                </p>
              </div>
            </>,
            document.body
          )}
        </div>
        {/* NOTE: "Clear All Models" was intentionally removed. It was a
            destructive, ambiguously-named action (it only cleared the synced
            catalog while leaving added models in place), and it sat next to the
            other ON/OFF controls where it read like a normal toggle. Removal of
            a single model remains available on its row in the Added models
            list, and stale upstream entries drop out of the discovered catalog
            on the next sync. */}
        <span className="text-[11px] text-text-muted ml-auto">
          Synced: {status.syncedCount}{status.staleCount > 0 && ` (${status.staleCount} stale)`} · Last sync: {formatTime(settings.lastSyncAt)}
        </span>
      </div>

      <p className="text-[11px] text-text-muted">
        {providerLabel || providerId} — sync upstream models, then add the ones you
        need. Added models, manual models and disabled models are never removed by
        a sync, and a failed or empty upstream leaves the catalog untouched.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon="sync" onClick={() => startSync()} disabled={!canSync || running}>
          {running ? "Syncing..." : "Sync now"}
        </Button>
        {running && (
          <Button size="sm" variant="ghost" onClick={handleCancel}>Cancel</Button>
        )}
        {running && job?.current && (
          <span className="text-[11px] text-text-muted truncate">Current: <code className="font-mono">{job.current}</code></span>
        )}
      </div>

      {running && job?.connections?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {job.connections.map((c) => (
            <span key={c.connectionId} className="text-[10px] px-1.5 py-0.5 rounded bg-background border border-border text-text-muted">
              {c.name}: {c.status}{c.discovered > 0 && ` (${c.discovered})`}
            </span>
          ))}
        </div>
      )}

      {job?.finished && summary && (
        <div className="text-[11px] text-text-muted">
          <p>
            Finished in {formatElapsed(job.elapsedMs)} — {summary.discovered} discovered upstream, {summary.added} new catalog record(s), {summary.updated} catalog record(s) refreshed
            {summary.stale > 0 && `, ${summary.stale} stale`}{summary.failed > 0 && `, ${summary.failed} failed`}.
          </p>
          <p className="opacity-70">
            Counters describe the discovered catalog only — "new/refreshed" does NOT add models to your model list. Use Add models below to enable them.
          </p>
          {summary.partial && (
            <p className="text-amber-600 dark:text-amber-400">
              Partial sync: {summary.failed} connection(s) failed, so the catalog reflects only the
              connections that answered. Models already added were kept.
            </p>
          )}
          {summary.preserved > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              Nothing was changed — {summary.preserved} existing model(s) preserved.
            </p>
          )}
        </div>
      )}
      {autoAddSummary && (
        <p className="text-[11px] text-text-muted">
          Auto-Add ({AUTO_ADD_POLICY_LABELS[normalizeAutoAddPolicy(autoAddSummary.policy)]}): added {autoAddSummary.added}
          {autoAddSummary.failed > 0 && `, ${autoAddSummary.failed} failed`}
          {autoAddSummary.disabled > 0 && `, disabled ${autoAddSummary.disabled}`}
          {autoAddSummary.added === 0 && autoAddSummary.disabled === 0 && !autoAddSummary.error && " — nothing new to add"}.
          {autoAddSummary.error && <span className="text-red-500"> {autoAddSummary.error}</span>}
        </p>
      )}
      {job?.error && <p className="text-[11px] text-amber-500 break-words">{job.error}</p>}
      {error && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-red-500 break-words flex-1">{error}</p>
          <Button size="sm" variant="ghost" onClick={() => startSync()}>Retry</Button>
        </div>
      )}

      {/* Discovered upstream catalog — strictly separate from added models.
          Added/manual/built-in models render in the Added list; only
          not-yet-added discoveries appear here. The panel is collapsible: it
          opens on Sync now (and after a reload when a catalog exists) and its
          Close button only hides it. */}
      {panelOpen ? (
        <DiscoveredModelsSection
          catalog={catalog}
          storageAlias={providerStorageAlias}
          modelAliases={modelAliases}
          hardcodedIds={hardcodedIds}
          testResults={testResults}
          disabledIds={disabledIds}
          canTest={canSync}
          onAddOne={onAddModel}
          onTestResult={(modelId, status) => onTestResult?.(modelId, status)}
          onClose={() => setPanelOpen(false)}
          onChanged={() => {
            refreshStatus(true);
            onCatalogChangedRef.current?.();
          }}
        />
      ) : (
        <div className="w-full mt-1 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setPanelOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-border text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
            title="Show the discovered models from the last sync"
          >
            <span className="material-symbols-outlined text-sm">travel_explore</span>
            Show discovered models
            {status.syncedCount > 0 && (
              <span className="text-[10px] bg-sidebar px-1.5 py-0.5 rounded-full">{status.syncedCount}</span>
            )}
          </button>
          {running && (
            <span className="text-[11px] text-text-muted">Syncing…</span>
          )}
        </div>
      )}
    </div>
  );
}

function useManualIds(modelAliases, providerStorageAlias) {
  // Manual ids under this storage alias (for preservation during sync).
  return useMemo(() => {
    const prefix = `${providerStorageAlias}/`;
    const out = [];
    for (const full of Object.values(modelAliases || {})) {
      if (typeof full === "string" && full.startsWith(prefix)) {
        const id = full.slice(prefix.length);
        if (id && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }, [modelAliases, providerStorageAlias]);
}

// Position the Auto-Add policy menu under its toggle button using a portal +
// fixed coordinates. Flips ABOVE the anchor when there is no room below,
// clamps to the viewport, and caps the height so the menu scrolls instead of
// overflowing. Runs in useLayoutEffect so the menu never paints at (0,0).
function useLayoutEffectForMenu(open, anchorRef, setMenuPos) {
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const compute = () => {
      const rect = anchorRef.current?.getBoundingClientRect?.();
      if (!rect) return;
      const margin = 8;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      // Estimate menu height before it is measured; clamped by maxHeight anyway.
      const estimatedH = Math.min(420, viewportH - margin * 2);
      const spaceBelow = viewportH - rect.bottom - margin;
      const openUp = spaceBelow < Math.min(estimatedH, 240) && rect.top > estimatedH;
      const top = openUp
        ? Math.max(margin, rect.top - estimatedH - 6)
        : rect.bottom + 6;
      const left = Math.min(
        Math.max(margin, rect.right - 320), // right-align to the toggle (menu ≈ 320px)
        Math.max(margin, viewportW - 320 - margin)
      );
      const maxHeight = openUp
        ? Math.min(420, rect.top - margin * 2)
        : Math.min(420, viewportH - rect.bottom - margin * 2);
      setMenuPos({ top, left, maxHeight: Math.max(180, maxHeight) });
    };
    compute();
    // Re-measure once the menu has rendered (real height may differ).
    const raf = requestAnimationFrame(compute);
    return () => cancelAnimationFrame(raf);
  }, [open, anchorRef, setMenuPos]);
}

ModelSyncPanel.propTypes = {
  providerId: PropTypes.string.isRequired,
  providerStorageAlias: PropTypes.string.isRequired,
  providerLabel: PropTypes.string,
  connections: PropTypes.array,
  modelAliases: PropTypes.object,
  hardcodedIds: PropTypes.array,
  testResults: PropTypes.object,
  disabledIds: PropTypes.array,
  isCustomProvider: PropTypes.bool,
  onAddModel: PropTypes.func.isRequired,
  onTestResult: PropTypes.func,
  onCatalogChanged: PropTypes.func,
};
