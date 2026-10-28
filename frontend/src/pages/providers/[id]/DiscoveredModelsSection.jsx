import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import ModelBatchTest from "@/pages/providers/components/ModelBatchTest";
import {
  filterDiscovered,
  resolveBulkAdd,
  resolveDisableNotAdded,
  stableModelId,
} from "@/shared/utils/discoveredModels";

// ── DiscoveredModelsSection ──────────────────────────────────────
// Collapsible discovery panel for ONE provider. Holds the discovered (not yet
// added) upstream catalog only — added models live in the Added models list
// above, so a model is never rendered in both places.
//
// Contents: search, All/Working/Error/Disabled and Free/Paid filters with
// counts derived from the actual filtered set, "Add All Models" (respects the
// active filters), the "Disable models not added" checkbox, and "Test All"
// (the existing batch-test backend).
//
// Visibility is driven by the parent: Sync Now opens/expands the panel, results
// stay visible after a sync, and Close hides it WITHOUT deleting anything or
// changing any state — reopening shows the same persisted catalog.
//
// Props:
//   catalog: synced catalog entries [{ id, name, type, isFree, stale, manual ... }]
//   storageAlias: provider storage alias used for the full-model identity
//   modelAliases: { alias: fullModel } manual store (added models)
//   hardcodedIds: built-in model ids (treated as already added)
//   testResults: { [bareModelId]: "ok" | "error" } latest valid tests
//   disabledIds: model ids currently in the Disabled system
//   onAddOne(modelId): add a single discovered model (existing creation logic)
//   onTestResult(modelId, status): record a test outcome (parent owns the map)
//   canTest: false when the provider has no usable connection/credentials
//   onChanged(): refresh parent lists after bulk operations
//   onClose(): hide the panel (no data is removed)
const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "working", label: "Working" },
  { key: "error", label: "Error" },
  { key: "inconclusive", label: "Inconclusive" },
  { key: "disabled", label: "Disabled" },
];

const PRICE_TABS = [
  { key: "all", label: "All prices" },
  { key: "free", label: "Free" },
  { key: "paid", label: "Paid" },
  { key: "unknown", label: "Unknown price" },
];

const BULK_CHUNK = 50;
const PAGE_SIZE = 16;
const MAX_RENDERED = 2000;

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function statusBadge(row, testResults, disabledIds) {
  if (row.isAdded) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">added</span>
    );
  }
  if ((disabledIds || []).includes(row.id)) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">disabled</span>
    );
  }
  const s = testResults?.[row.id];
  if (s === "ok") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">working</span>
    );
  }
  if (s === "error") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500">error</span>
    );
  }
  if (s === "inconclusive") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">inconclusive</span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sidebar text-text-muted">untested</span>
  );
}

export default function DiscoveredModelsSection({
  catalog,
  storageAlias,
  modelAliases,
  hardcodedIds,
  testResults,
  disabledIds,
  onAddOne,
  onTestResult,
  onChanged,
  canTest = true,
  onClose,
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [price, setPrice] = useState("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [disableRest, setDisableRest] = useState(false);
  const [bulk, setBulk] = useState(null); // { running, done, total, added, skipped, failed, disabled, error }
  const [rowError, setRowError] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);

  // Local mirror of the parent's test results so a Test All run inside this
  // panel updates the badges immediately, while the parent stays the single
  // source of truth (it also persists results via the shared batch endpoint).
  const [localTestResults, setLocalTestResults] = useState({});
  const batchActiveRef = useRef(false);
  useEffect(() => {
    if (!batchActiveRef.current) setLocalTestResults({});
  }, [testResults]);
  const effectiveTestResults = { ...localTestResults, ...(testResults || {}) };

  const recordTest = (modelId, value) => {
    setLocalTestResults((prev) => ({ ...prev, [modelId]: value }));
    onTestResult?.(modelId, value);
  };

  // Discovered-only: synced entries that have NOT been added yet. Added,
  // manual and built-in models live in the Added list above — never here.
  const discovered = useMemo(() => {
    const addedFull = new Set(
      Object.values(modelAliases || {}).filter((v) => typeof v === "string")
    );
    const hardcoded = new Set(hardcodedIds || []);
    const seen = new Set();
    const out = [];
    for (const m of catalog || []) {
      const id = stableModelId(m?.id);
      if (!id || m?.stale || seen.has(id)) continue;
      seen.add(id);
      if (addedFull.has(`${storageAlias}/${id}`) || hardcoded.has(id)) continue;
      out.push({ ...m, id });
    }
    return out;
  }, [catalog, storageAlias, modelAliases, hardcodedIds]);

  const { rows, counts } = useMemo(
    () => filterDiscovered(discovered, { search, status, price, testResults: effectiveTestResults, disabledIds }),
    [discovered, search, status, price, effectiveTestResults, disabledIds]
  );

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, status, price, discovered.length]);

  const visible = rows.slice(0, Math.min(visibleCount, MAX_RENDERED));

  // "Test All" covers the currently FILTERED discovered models, so the
  // Working/Error/Disabled counts update right after the run finishes.
  // ModelBatchTest is the existing batch-test UI (SSE + polling fallback,
  // configurable timeout/concurrency, cancel, retry-failed) — no new test
  // logic is introduced here.
  const testableModels = useMemo(
    () => discovered.map((m) => ({
      id: m.id,
      fullModel: `${storageAlias}/${m.id}`,
      kind: m.type || "llm",
      isFree: typeof m.isFree === "boolean" ? m.isFree : null,
    })),
    [discovered, storageAlias]
  );
  const filteredTestable = useMemo(
    () => new Set(rows.map((r) => r.id)),
    [rows]
  );
  const filteredTestableModels = useMemo(
    () => testableModels.filter((m) => filteredTestable.has(m.id)),
    [testableModels, filteredTestable]
  );

  const defaultAliasFor = (modelId) => {
    const parts = String(modelId).split("/");
    return parts[parts.length - 1] || modelId;
  };

  const addMany = async (ids) => {
    // Prefer the bulk endpoint (one round-trip, idempotent skip-existing);
    // fall back to the existing single-add path for older servers.
    const payload = ids.map((id) => ({
      model: `${storageAlias}/${id}`,
      alias: defaultAliasFor(id),
    }));
    try {
      const res = await fetch("/api/models/alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: payload }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return {
          added: data.added || 0,
          skipped: data.skipped || 0,
          failed: data.failed || 0,
        };
      }
      if (res.status !== 404 && res.status !== 405) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Bulk add failed (HTTP ${res.status})`);
      }
    } catch (e) {
      if (e?.message && !e.message.includes("Failed to fetch")) throw e;
      // fall through to sequential fallback on network-level errors too
    }
    let added = 0;
    let skipped = 0;
    let failed = 0;
    const known = new Set(
      Object.values(modelAliases || {}).filter((v) => typeof v === "string")
    );
    for (const id of ids) {
      if (known.has(`${storageAlias}/${id}`)) {
        skipped += 1;
        continue;
      }
      try {
        await onAddOne?.(id);
        known.add(`${storageAlias}/${id}`);
        added += 1;
      } catch {
        failed += 1;
      }
    }
    return { added, skipped, failed };
  };

  // Server-side discovered scope: the backend re-reads the persisted catalog,
  // so the browser's visible page (16 rows) can never limit the operation.
  const addDiscoveredOnServer = async () => {
    try {
      const res = await fetch("/api/models/alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "discovered",
          providerAlias: storageAlias,
          hardcodedIds,
          filters: { search, status, price },
        }),
      });
      if (res.status === 404 || res.status === 405) return null;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Bulk add failed (HTTP ${res.status})`);
      return {
        added: data.added || 0,
        skipped: data.skipped || 0,
        failed: data.failed || 0,
        total: data.total || 0,
        results: Array.isArray(data.results) ? data.results : [],
      };
    } catch (e) {
      if (e?.message && !e.message.includes("Failed to fetch")) throw e;
      return null;
    }
  };

  // Adding many models is irreversible in bulk, so confirm above a threshold
  // rather than silently writing dozens of alias records.
  const CONFIRM_THRESHOLD = 25;
  const runAddAll = async () => {
    if (bulk?.running || rows.length === 0) return;
    setRowError("");
    setBulk({ running: true, done: 0, total: rows.length, added: 0, skipped: 0, failed: 0, disabled: 0, error: "" });
    try {
      const server = await addDiscoveredOnServer();
      if (server) {
        const failureReasons = server.results
          .filter((r) => r.status === "failed" && r.reason)
          .slice(0, 3)
          .map((r) => `${r.model}: ${r.reason}`);
        setBulk({
          running: false,
          done: server.total,
          total: server.total,
          added: server.added,
          skipped: server.skipped,
          failed: server.failed,
          disabled: 0,
          error: failureReasons.join(" · "),
        });
        onChanged?.();
        return;
      }

      const { targets, skipped } = resolveBulkAdd(rows.map((r) => ({ ...r, isAdded: false })));
      if (targets.length === 0) {
        setBulk({ running: false, done: 0, total: 0, added: 0, skipped, failed: 0, disabled: 0, error: "" });
        return;
      }
      let added = 0;
      let skippedTotal = skipped.length;
      let failed = 0;
      // Chunked with UI yields so large catalogs never freeze the page.
      for (let i = 0; i < targets.length; i += BULK_CHUNK) {
        const chunk = targets.slice(i, i + BULK_CHUNK);
        const r = await addMany(chunk);
        added += r.added;
        skippedTotal += r.skipped;
        failed += r.failed;
        setBulk((b) => (b ? { ...b, done: Math.min(targets.length, i + chunk.length), added, skipped: skippedTotal, failed } : b));
        await yieldToUI();
      }
      let disabledCount = 0;
      if (disableRest) {
        // Eligible discovered models matching the current filters that were
        // NOT added go into the existing Disabled system (never routable,
        // never deleted). Manual/added models are untouched.
        const addedSet = new Set(targets.slice(0, added));
        const rest = resolveDisableNotAdded(
          rows.filter((r) => !addedSet.has(r.id)),
          { disabledIds, hardcodedIds }
        );
        if (rest.length > 0) {
          const res = await fetch("/api/models/disabled", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: storageAlias, ids: rest }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Failed to disable remaining models");
          disabledCount = rest.length;
        }
      }
      setBulk({
        running: false,
        done: targets.length,
        total: targets.length,
        added,
        skipped: skippedTotal,
        failed,
        disabled: disabledCount,
        error: "",
      });
      onChanged?.();
    } catch (e) {
      setBulk((b) => ({ ...(b || {}), running: false, error: e?.message || "Bulk add failed" }));
      onChanged?.();
    }
  };

  const handleAddAll = async () => {
    if (bulk?.running || rows.length === 0) return;
    if (rows.length > CONFIRM_THRESHOLD) {
      setConfirmBulk(true);
      return;
    }
    await runAddAll();
  };

  const tabClass = (active) =>
    `px-2 py-1 rounded-lg text-[11px] border transition-colors ${
      active
        ? "border-primary text-primary bg-primary/5"
        : "border-border text-text-muted hover:text-text-main"
    }`;

  return (
    <div className="w-full mt-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="material-symbols-outlined text-base text-text-muted">travel_explore</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Discovered models
        </span>
        <span className="text-[10px] text-text-muted/70 bg-sidebar px-1.5 py-0.5 rounded-full">
          {discovered.length}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
            title="Hide this panel — discovered models are kept and shown again next time"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
            Close
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search discovered models…"
          aria-label="Search discovered models"
          className="min-w-[180px] flex-1 px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
        />
        <Button
          size="sm"
          variant="secondary"
          icon="add"
          onClick={handleAddAll}
          disabled={bulk?.running || rows.length === 0}
          title={rows.length === 0 ? "No discovered models match the current filters" : `Add ${rows.length} filtered model(s)`}
        >
          {bulk?.running ? `Adding ${bulk.done}/${bulk.total}…` : `Add All Models${rows.length > 0 ? ` (${rows.length})` : ""}`}
        </Button>
        <label
          className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer select-none"
          title="When checked, discovered models matching the current filters that were not added are placed in Disabled models (excluded from routing and the Playground). Unchecked: only add, never disable. Previously disabled models are never re-enabled automatically."
        >
          <input
            type="checkbox"
            checked={disableRest}
            onChange={(e) => setDisableRest(e.target.checked)}
            className="accent-[var(--color-primary)]"
          />
          Disable models not added
        </label>
      </div>

      {canTest && filteredTestableModels.length > 0 && (
        <div className="mt-2">
          <ModelBatchTest
            models={filteredTestableModels}
            disabled={false}
            testResults={effectiveTestResults}
            onBatchActiveChange={(active) => { batchActiveRef.current = active; }}
            onResult={(fullModel, value) => {
              const prefix = `${storageAlias}/`;
              const id = String(fullModel).startsWith(prefix)
                ? String(fullModel).slice(prefix.length)
                : fullModel;
              if (value === "testing") return; // not a result yet
              recordTest(id, value);
            }}
            onBatchEnd={() => onChanged?.()}
            scopeLocked
          />
        </div>
      )}
      {!canTest && (
        <p className="text-[11px] text-text-muted mt-2">
          Add a connection with a key to enable testing these models.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={tabClass(status === t.key)}
            title={t.key === "working" ? "Latest test passed" : t.key === "error" ? "Latest test failed" : t.key === "disabled" ? "In Disabled models" : "All discovered models"}
          >
            {t.label} ({counts[t.key] ?? 0})
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {PRICE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setPrice(t.key)}
            className={tabClass(price === t.key)}
          >
            {t.label} ({t.key === "all" ? counts.all : counts[t.key] ?? 0})
          </button>
        ))}
        <span className="text-[11px] text-text-muted ml-auto">
          Discovered upstream ({discovered.length})
        </span>
      </div>

      {bulk && !bulk.running && (bulk.added > 0 || bulk.skipped > 0 || bulk.failed > 0 || bulk.disabled > 0 || bulk.error) && (
        <p className="text-[11px] text-text-muted mt-2">
          {bulk.error ? (
            <span className="text-red-500">{bulk.error} </span>
          ) : null}
          Added {bulk.added}, skipped {bulk.skipped}, failed {bulk.failed}
          {bulk.disabled > 0 && `, disabled ${bulk.disabled}`}.
        </p>
      )}
      {confirmBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-xl">
            <h3 className="text-sm font-semibold mb-1">Add {rows.length} models?</h3>
            <p className="text-xs text-text-muted mb-3">
              This adds every discovered model matching the current filters
              ({STATUS_TABS.find((t) => t.key === status)?.label} ·{" "}
              {PRICE_TABS.find((t) => t.key === price)?.label}
              {search.trim() ? ` · “${search.trim()}”` : ""}).
              {disableRest ? " Models left out will be moved to Disabled models." : ""}
            </p>
            <div className="flex gap-2">
              <Button size="sm" fullWidth onClick={async () => { setConfirmBulk(false); await runAddAll(); }}>
                Add {rows.length}
              </Button>
              <Button size="sm" variant="ghost" fullWidth onClick={() => setConfirmBulk(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {rowError && <p className="text-[11px] text-red-500 mt-2">{rowError}</p>}

      {visible.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto mt-2">
          {visible.map((m) => (
            <span
              key={m.id}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-black/10 dark:border-white/10 text-[11px] text-text-muted"
              title={[
                m.name && m.name !== m.id ? m.name : null,
                m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : null,
                m.isFree ? "free" : null,
              ].filter(Boolean).join(" · ") || m.id}
            >
              {statusBadge(m, effectiveTestResults, disabledIds)}
              <span className="max-w-[220px] truncate">{m.id}</span>
              <button
                onClick={async () => {
                  setRowError("");
                  try {
                    await onAddOne?.(m.id);
                    onChanged?.();
                  } catch (e) {
                    setRowError(e?.message || "Failed to add model");
                  }
                }}
                className="flex items-center text-text-muted hover:text-primary"
                title={`Add ${m.id}`}
                aria-label={`Add ${m.id}`}
              >
                <span className="material-symbols-outlined text-[14px]">add</span>
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-text-muted mt-2">
          {discovered.length === 0
            ? "No discovered models yet. Run Sync now to fetch the upstream catalog."
            : "No discovered models match the current filters."}
        </p>
      )}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <span className="text-[10px] text-text-muted">
            Showing {visible.length} of {rows.length}
            {discovered.length !== rows.length ? ` (filtered from ${discovered.length})` : ""}
          </span>
          {visible.length < rows.length && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVisibleCount((n) => Math.min(rows.length, n + PAGE_SIZE))}
              >
                Load {Math.min(PAGE_SIZE, rows.length - visible.length)} more
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVisibleCount(Math.min(MAX_RENDERED, rows.length))}
              >
                Show all {Math.min(MAX_RENDERED, rows.length)}
              </Button>
            </>
          )}
          {rows.length > MAX_RENDERED && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              Rendering first {MAX_RENDERED}; Add All still applies to all {rows.length}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

DiscoveredModelsSection.propTypes = {
  catalog: PropTypes.array,
  storageAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object,
  hardcodedIds: PropTypes.array,
  testResults: PropTypes.object,
  disabledIds: PropTypes.array,
  onAddOne: PropTypes.func,
  onTestResult: PropTypes.func,
  onChanged: PropTypes.func,
  canTest: PropTypes.bool,
  onClose: PropTypes.func,
};
