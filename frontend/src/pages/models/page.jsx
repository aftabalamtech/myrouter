import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { AI_PROVIDERS, getProviderAlias, getProviderByAlias } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { ConfirmModal, Modal } from "@/shared/components";
import { isModelBlocked, isModelHidden, matchesStatusFilter } from "@/shared/utils/modelEligibility";
import { modelPrimaryLabel, hasDistinctDisplayName } from "@/shared/utils/modelDisplay";
import { cachedJson, invalidateCache } from "@/shared/utils/cachedJson";
import ModelBatchTest from "../providers/components/ModelBatchTest";

function kindOf(m) {
  return m.type || m.kinds?.[0] || "llm";
}

// ── Compatibility modal: connections + cooldown locks for one model ──
function CompatibilityModal({ entry, onClose }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [connRes, availRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/models/availability", { cache: "no-store" }),
        ]);
        const conns = connRes.ok ? (await connRes.json().catch(() => ({}))).connections || [] : [];
        const avail = availRes.ok ? await availRes.json().catch(() => ({})) : {};
        const locks = Array.isArray(avail.models)
          ? avail.models.filter((l) => l.provider === entry.providerId
            && (l.model === entry.id || l.model === "__all" || l.model === entry.fullModel))
          : [];
        if (!cancelled) setInfo({
          connections: conns.filter((c) => c.provider === entry.providerId),
          locks,
        });
      } catch {
        if (!cancelled) setInfo({ connections: [], locks: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [entry]);

  return (
    <Modal isOpen title={`Compatibility — ${entry.fullModel}`} onClose={onClose}>
      {!info && <p className="text-xs text-text-muted">Loading...</p>}
      {info && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold mb-1">Connections ({info.connections.length})</p>
            {info.connections.length === 0 && <p className="text-xs text-text-muted">No connections for this provider.</p>}
            {info.connections.map((c) => (
              <div key={c.id} className="text-xs text-text-muted border border-border rounded-lg px-2 py-1.5 mb-1">
                <span className="font-mono">{c.name || c.email || c.id}</span>
                {" · "}status: {c.testStatus || "unknown"}
                {c.lastError && <span className="text-red-500 break-words"> · {String(c.lastError).slice(0, 160)}</span>}
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold mb-1">Cooldowns / locks</p>
            {info.locks.length === 0 && <p className="text-xs text-text-muted">No active cooldowns for this model.</p>}
            {info.locks.map((l, i) => (
              <div key={i} className="text-xs text-text-muted border border-border rounded-lg px-2 py-1.5 mb-1">
                <span className="font-mono">{l.model}</span> · {l.status}
                {l.until && ` until ${l.until}`}
                {l.lastError && <span className="text-red-500 break-words"> · {String(l.lastError).slice(0, 160)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Available Models page ────────────────────────────────────
export default function ModelsPage() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [syncedModels, setSyncedModels] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [disabledMap, setDisabledMap] = useState({});
  const [blocksMap, setBlocksMap] = useState({});
  const [testResults, setTestResults] = useState({});
  const [testingIds, setTestingIds] = useState([]);
  const [singleTestingIds, setSingleTestingIds] = useState([]);
  const inflightSingleRef = useRef(null);
  if (inflightSingleRef.current === null) inflightSingleRef.current = new Set();
  const [compatEntry, setCompatEntry] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [notice, setNotice] = useState(null); // { type: "success" | "error", text }

  const [providerFilter, setProviderFilter] = useState("connected");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const [visibility, setVisibility] = useState("all"); // all | visible | hidden
  const [statusFilter, setStatusFilter] = useState("all"); // all | working | error | hidden | disabled
  const [price, setPrice] = useState("all"); // all | free | paid | unknown
  const [freeFirst, setFreeFirst] = useState(false);
  const [autoHideFailed, setAutoHideFailed] = useState(false);

  const showNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const providerIds = useMemo(() => Object.keys(AI_PROVIDERS || {}), []);

  const refresh = useCallback(async ({ force = false } = {}) => {
    // cachedJson dedupes in-flight requests and reuses recent reads, so
    // remounting this page (every tab switch) does not refire all six GETs.
    const read = (url) => cachedJson(url, { force });
    try {
      const [connRes, customRes, disRes, blockRes, resRes, aliasRes, syncRes] = await Promise.all([
        read("/api/providers"),
        read("/api/models/custom"),
        read("/api/models/disabled"),
        read("/api/models/blocks"),
        read("/api/models/test-results"),
        read("/api/models/alias"),
        read("/api/models/synced"),
      ]);
      if (connRes.ok) setConnections(connRes.data.connections || []);
      if (customRes.ok) setCustomModels(customRes.data.models || []);
      if (syncRes.ok) setSyncedModels(syncRes.data.models || []);
      if (aliasRes.ok) setModelAliases(aliasRes.data.aliases || {});
      if (disRes.ok) setDisabledMap(disRes.data.disabled || {});
      if (blockRes.ok) setBlocksMap(blockRes.data.blocked || {});
      if (resRes.ok) {
        const all = resRes.data.results || {};
        const mapped = {};
        for (const [fullModel, r] of Object.entries(all)) {
          if (r?.status === "passed") mapped[fullModel] = "ok";
          else if (r?.status === "inconclusive") mapped[fullModel] = "inconclusive";
          else if (r?.status === "failed" || r?.status === "timeout") mapped[fullModel] = "error";
        }
        setTestResults(mapped);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Debounce the search box so filtering a huge catalog doesn't re-run per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to first page whenever the result set criteria change.
  useEffect(() => { setPage(1); }, [providerFilter, visibility, statusFilter, price, freeFirst]);

  // Providers that need no credentials (opencode, local-device, the local TTS
  // engines, searxng...). They are usable with zero connections, so they must
  // count as "connected" — otherwise the default Connected filter hides every
  // one of their models and the page renders "0/0 active".
  const noAuthProviderIds = useMemo(
    () => new Set(Object.entries(AI_PROVIDERS).filter(([, p]) => p.noAuth).map(([id]) => id)),
    []
  );

  const connectedProviders = useMemo(() => {
    const set = new Set(connections.filter((c) => c.isActive !== false).map((c) => c.provider));
    for (const id of noAuthProviderIds) set.add(id);
    return set;
  }, [connections, noAuthProviderIds]);

  const allEntries = useMemo(() => {
    const out = [];
    const ids = providerFilter === "all" ? providerIds
      : providerFilter === "connected" ? providerIds.filter((id) => connectedProviders.has(id))
      : [providerFilter];
    for (const providerId of ids) {
      let builtIn = [];
      try { builtIn = getModelsByProviderId(providerId) || []; } catch { builtIn = []; }
      const alias = getProviderAlias(providerId);
      const hiddenIds = new Set(disabledMap[alias] || []);
      for (const m of builtIn) {
        out.push({
          key: `${alias}/${m.id}`,
          providerId,
          providerAlias: alias,
          id: m.id,
          fullModel: `${alias}/${m.id}`,
          name: m.name || "",
          kind: kindOf(m),
          isFree: !!m.isFree,
          isCustom: false,
          hidden: hiddenIds.has(m.id),
          hasConnection: connectedProviders.has(providerId),
        });
      }
    }
    const hiddenByAlias = (a) => new Set(disabledMap[a] || []);

    // Static (built-in) model ids per storage alias, used to dedupe the
    // synced and alias-derived sources against the built-in catalog.
    const hardcodedByAlias = {};
    try {
      for (const pid of providerIds) {
        const a = getProviderAlias(pid);
        hardcodedByAlias[a] = new Set((getModelsByProviderId(pid) || []).map((m) => m.id));
      }
    } catch { /* ignore */ }
    const customKeys = new Set(customModels.map((m) => `${m.providerAlias}/${m.id}`));

    // Provider-sync discovered models. These are registered against their
    // storage alias and the exact upstream id, deduped against the static list
    // and against custom models so one model never appears twice.
    const syncedIds = new Set();
    for (const m of syncedModels) {
      const storageAlias = m.storageAlias || m.providerAlias;
      if (!storageAlias || !m.id) continue;
      const fullModel = m.fullModel || `${storageAlias}/${m.id}`;
      const provider = getProviderByAlias(storageAlias);
      const providerId = provider?.id || storageAlias;
      if (providerFilter !== "all" && providerFilter !== "connected") {
        if (storageAlias !== getProviderAlias(providerFilter)) continue;
      }
      if (providerFilter === "connected"
        && ![...connectedProviders].some((id) => getProviderAlias(id) === storageAlias)) continue;
      if (hardcodedByAlias[storageAlias]?.has(m.id)) continue;
      if (customKeys.has(`${storageAlias}/${m.id}`)) continue;
      syncedIds.add(fullModel);
      out.push({
        key: fullModel,
        providerId,
        providerAlias: storageAlias,
        id: m.id,
        fullModel,
        name: m.name || m.id,
        kind: kindOf(m),
        isFree: typeof m.isFree === "boolean" ? m.isFree : null,
        isCustom: true,
        hidden: hiddenByAlias(storageAlias).has(m.id),
        hasConnection: provider ? connectedProviders.has(providerId) : true,
      });
    }

    for (const m of customModels) {
      if (providerFilter !== "all" && providerFilter !== "connected") {
        if (m.providerAlias !== getProviderAlias(providerFilter)) continue;
      }
      if (providerFilter === "connected" && ![...connectedProviders].some((id) => getProviderAlias(id) === m.providerAlias)) continue;
      out.push({
        key: `${m.providerAlias}/${m.id}`,
        providerId: m.providerAlias,
        providerAlias: m.providerAlias,
        id: m.id,
        fullModel: `${m.providerAlias}/${m.id}`,
        name: m.name || "",
        kind: m.type || "llm",
        isFree: false,
        isCustom: true,
        hidden: hiddenByAlias(m.providerAlias).has(m.id),
        hasConnection: true,
      });
    }
    // Alias-added models (provider "Add Model" stores aliases like openrouter/deepseek/...).
    // These are NOT in /api/models/custom, so derive them here per provider.
      const aliasEntries = [];
    const aliasOwner = new Map(); // fullModel → alias name (first wins)
    const aliasNameOwner = new Map(); // alias name → fullModel (first wins)
    for (const [aliasName, fullModel] of Object.entries(modelAliases)) {
      if (typeof fullModel !== "string" || !fullModel.includes("/")) continue;
      const slash = fullModel.indexOf("/");
      const storageAlias = fullModel.slice(0, slash);
      const modelId = fullModel.slice(slash + 1);
      if (!modelId) continue;
      // Cross-provider alias collision: two providers may legitimately expose
      // the same short alias (e.g. both "qwen3.5-plus"). The FIRST alias
      // record keeps the name; later ones get a provider-scoped unique name so
      // selecting the short label never routes to the wrong provider.
      const aliasKey = aliasNameOwner.has(aliasName) ? `${storageAlias}/${aliasName}` : aliasName;
      aliasNameOwner.set(aliasKey, fullModel);
      if (!aliasOwner.has(fullModel)) aliasOwner.set(fullModel, aliasKey);
      if (hardcodedByAlias[storageAlias]?.has(modelId)) continue;
      // Also skip anything already covered by the static list or the synced
      // catalog so the same model never appears twice under one provider.
      if (syncedIds.has(`${storageAlias}/${modelId}`)) continue;
      const provider = getProviderByAlias(storageAlias);
      const providerId = provider?.id || storageAlias;
      if (providerFilter !== "all" && providerFilter !== "connected") {
        if (storageAlias !== getProviderAlias(providerFilter)) continue;
      }
      if (providerFilter === "connected"
        && ![...connectedProviders].some((id) => getProviderAlias(id) === storageAlias)) continue;
      aliasEntries.push({
        key: fullModel,
        providerId,
        providerAlias: storageAlias,
        id: modelId,
        fullModel,
        name: aliasKey,
        kind: "llm",
        isFree: /free/i.test(modelId),
        isCustom: true,
        hidden: hiddenByAlias(storageAlias).has(modelId),
        hasConnection: provider ? connectedProviders.has(providerId) : true,
      });
    }
    const seenKeys = new Set(out.map((e) => e.key));
    for (const e of aliasEntries) {
      if (!seenKeys.has(e.key)) { seenKeys.add(e.key); out.push(e); }
    }
    return out;
  }, [providerIds, providerFilter, connectedProviders, customModels, syncedModels, disabledMap, modelAliases]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    let list = allEntries.map((e) => {
      const ts = testResults[e.key];
      return {
        ...e,
        disabled: isModelBlocked(e.providerId, e.providerAlias, e.id, blocksMap),
        testStatus: ts === "ok" ? "ok" : ts === "error" ? "error" : ts === "inconclusive" ? "inconclusive" : "untested",
      };
    }).filter((e) => {
      if (statusFilter === "disabled") {
        // Disabled filter shows blocked models even when they are also hidden.
        if (!e.disabled) return false;
      } else {
        if (visibility === "visible" && e.hidden) return false;
        if (visibility === "hidden" && !e.hidden) return false;
      }
      if (!matchesStatusFilter({ testStatus: e.testStatus, hidden: e.hidden, blocked: e.disabled }, statusFilter)) return false;
      if (price === "free" && e.isFree !== true) return false;
      if (price === "paid" && e.isFree !== false) return false;
      if (price === "unknown" && typeof e.isFree === "boolean") return false;
      if (q && !`${e.fullModel} ${e.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (freeFirst) list = [...list].sort((a, b) => Number(b.isFree) - Number(a.isFree));
    return list;
  }, [allEntries, debouncedSearch, visibility, statusFilter, price, freeFirst, blocksMap, testResults]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = useMemo(() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filtered, safePage]);

  const visibleCount = allEntries.filter((e) => !e.hidden).length;

  const handleBatchResult = useCallback((fullModel, status) => {
    if (status === "testing") {
      setTestingIds((prev) => (prev.includes(fullModel) ? prev : [...prev, fullModel]));
      return;
    }
    setTestingIds((prev) => prev.filter((k) => k !== fullModel));
    setTestResults((prev) => ({ ...prev, [fullModel]: status }));
  }, []);

  const setHidden = useCallback(async (entry, hide) => {
    try {
      if (hide) {
        await fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerAlias: entry.providerAlias, ids: [entry.id] }),
        });
      } else {
        await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(entry.providerAlias)}&id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      }
      setDisabledMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        if (hide) cur.add(entry.id); else cur.delete(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
      invalidateCache("/api/models/disabled");
    } catch { /* ignore */ }
  }, []);

  const handleDisable = useCallback(async (entry) => {
    try {
      const res = await fetch("/api/models/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: entry.providerAlias, ids: [entry.id] }),
      });
      if (!res.ok) throw new Error("Disable failed");
      setBlocksMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        cur.add(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
      invalidateCache("/api/models/blocks");
      showNotice("success", `Disabled ${entry.fullModel}. It will no longer receive requests.`);
    } catch {
      showNotice("error", `Could not disable ${entry.fullModel}.`);
    } finally {
      setConfirmDisable(null);
    }
  }, [showNotice]);

  const handleEnable = useCallback(async (entry) => {
    try {
      const res = await fetch(`/api/models/blocks?providerAlias=${encodeURIComponent(entry.providerAlias)}&id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Enable failed");
      setBlocksMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        cur.delete(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
      showNotice("success", `Re-enabled ${entry.fullModel}.`);
    } catch {
      showNotice("error", `Could not re-enable ${entry.fullModel}.`);
    }
  }, [showNotice]);

  const handleHideAll = useCallback(async () => {
    const byAlias = {};
    for (const e of filtered.filter((e) => !e.hidden)) {
      (byAlias[e.providerAlias] = byAlias[e.providerAlias] || []).push(e.id);
    }
    await Promise.all(Object.entries(byAlias).map(([alias, ids]) =>
      fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: alias, ids }),
      }).catch(() => {})
    ));
    refresh({ force: true });
  }, [filtered, refresh]);

  const handleShowAll = useCallback(async () => {
    const hidden = allEntries.filter((e) => e.hidden);
    await Promise.all(hidden.map((e) =>
      fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(e.providerAlias)}&id=${encodeURIComponent(e.id)}`, { method: "DELETE" }).catch(() => {})
    ));
    refresh({ force: true });
  }, [allEntries, refresh]);

  const handleBatchEnd = useCallback(async (snapshot) => {
    refresh({ force: true });
    if (!autoHideFailed || !snapshot) return;
    const failed = (snapshot.results || []).filter((r) => r.status === "failed" || r.status === "timeout");
    if (failed.length === 0) return;
    const byAlias = {};
    for (const r of failed) {
      const slash = r.modelId.indexOf("/");
      if (slash < 0) continue;
      const alias = r.modelId.slice(0, slash);
      const id = r.modelId.slice(slash + 1);
      (byAlias[alias] = byAlias[alias] || []).push(id);
    }
    await Promise.all(Object.entries(byAlias).map(([alias, ids]) =>
      fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: alias, ids }),
      }).catch(() => {})
    ));
    refresh({ force: true });
  }, [autoHideFailed, refresh]);

  const handleSingleTest = useCallback(async (entry) => {
    if (entry.disabled) return;
    if (inflightSingleRef.current.has(entry.key)) return; // prevent duplicate tests
    inflightSingleRef.current.add(entry.key);
    setSingleTestingIds((prev) => (prev.includes(entry.key) ? prev : [...prev, entry.key]));
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: entry.fullModel, kind: entry.kind }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResults((prev) => ({ ...prev, [entry.key]: data.ok ? "ok" : "error" }));
    } catch {
      setTestResults((prev) => ({ ...prev, [entry.key]: "error" }));
    } finally {
      inflightSingleRef.current.delete(entry.key);
      setSingleTestingIds((prev) => prev.filter((k) => k !== entry.key));
    }
  }, []);

  const batchModels = useMemo(() => filtered
    .filter((e) => !e.hidden && !e.disabled && e.hasConnection)
    .map((e) => ({ id: e.key, fullModel: e.fullModel, kind: e.kind, isFree: e.isFree })),
    [filtered]);

  const providerOptions = useMemo(() => {
    // Count what the user would actually see for each provider: static models
    // plus the synced catalog and custom/alias models registered under its
    // alias. Counting only the static table hid OpenCode entirely.
    const extraByAlias = new Map();
    const bump = (alias, n = 1) => {
      if (!alias) return;
      extraByAlias.set(alias, (extraByAlias.get(alias) || 0) + n);
    };
    for (const m of syncedModels) bump(m.storageAlias || m.providerAlias);
    for (const m of customModels) bump(m.providerAlias);
    for (const fullModel of Object.values(modelAliases)) {
      if (typeof fullModel === "string" && fullModel.includes("/")) {
        bump(fullModel.slice(0, fullModel.indexOf("/")));
      }
    }

    const withCounts = providerIds.map((id) => {
      const alias = getProviderAlias(id);
      let n = 0;
      try { n = (getModelsByProviderId(id) || []).length; } catch { n = 0; }
      return { id, alias, count: n + (extraByAlias.get(alias) || 0), connected: connectedProviders.has(id) };
    }).filter((p) => p.count > 0);
    return withCounts;
  }, [providerIds, connectedProviders, syncedModels, customModels, modelAliases]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold mr-auto">Available Models</h1>
        <span className="text-xs text-text-muted">{visibleCount}/{allEntries.length} active</span>
        <button onClick={handleShowAll} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-muted hover:text-primary hover:border-primary/40 transition-colors" title="Show all models">
          <span className="material-symbols-outlined text-sm">visibility</span> All
        </button>
        <button onClick={handleHideAll} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-muted hover:text-red-500 hover:border-red-500/40 transition-colors" title="Hide all listed models">
          <span className="material-symbols-outlined text-sm">visibility_off</span> Hide all
        </button>
      </div>

      {notice ? (
        <div className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 ${notice.type === "success" ? "border-green-500/40 bg-green-500/10 text-green-500" : "border-red-500/40 bg-red-500/10 text-red-500"}`}>
          <span className="material-symbols-outlined text-sm">{notice.type === "success" ? "check_circle" : "error"}</span>
          {notice.text}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm text-text-muted">search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter models..."
            className="pl-8 pr-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:border-primary w-48"
          />
        </div>
        <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:border-primary">
          <option value="connected">Connected providers</option>
          <option value="all">All providers</option>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.alias} ({p.count}){p.connected ? "" : " — no connection"}</option>
          ))}
        </select>
        {[
          ["all", "All"], ["visible", "Visible only"], ["hidden", "Hidden only"],
        ].map(([v, label]) => (
          <button key={v} onClick={() => setVisibility(v)} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${visibility === v ? "bg-red-500 text-white border-red-500" : "border-border text-text-muted hover:text-primary"}`}>{label}</button>
        ))}
        <span className="text-text-muted/40 text-xs select-none">|</span>
        {[
          ["all", "All statuses"], ["working", "Working"], ["error", "Error"], ["inconclusive", "Inconclusive"], ["hidden", "Hidden"], ["disabled", "Disabled"],
        ].map(([v, label]) => (
          <button key={`status-${v}`} onClick={() => setStatusFilter(v)} title={v === "all" ? "Show all statuses" : `Show ${label.toLowerCase()} models`} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${statusFilter === v ? "bg-red-500 text-white border-red-500" : "border-border text-text-muted hover:text-primary"}`}>{label}</button>
        ))}
        {[
          ["all", "All"], ["free", "Free only"], ["paid", "Paid only"], ["unknown", "Unknown price"],
        ].map(([v, label]) => (
          <button key={v} onClick={() => setPrice(v)} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${price === v ? "bg-red-500 text-white border-red-500" : "border-border text-text-muted hover:text-primary"}`}>{label}</button>
        ))}
        <button onClick={() => setFreeFirst((v) => !v)} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${freeFirst ? "border-primary text-primary" : "border-border text-text-muted"}`}>
          <span className="material-symbols-outlined text-sm">sort</span> Free first
        </button>
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input type="checkbox" checked={autoHideFailed} onChange={(e) => setAutoHideFailed(e.target.checked)} className="accent-red-500" />
          Auto-hide failed models
        </label>
      </div>

      <ModelBatchTest
        models={batchModels}
        disabled={batchModels.length === 0}
        testResults={Object.fromEntries(batchModels.map((m) => [m.id, testResults[m.fullModel]]))}
        onResult={handleBatchResult}
        onBatchEnd={handleBatchEnd}
        scopeLocked
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {paged.map((entry) => {
          const status = entry.testStatus;
          const testing = testingIds.includes(entry.key) || singleTestingIds.includes(entry.key);
          // Primary label = the actual upstream model id (or a custom display
          // name). The full provider-prefixed identity stays one click away
          // via the tooltip and the copy button — never truncated away.
          const primaryLabel = modelPrimaryLabel(entry);
          const secondaryName = hasDistinctDisplayName(entry.name, { id: entry.id, fullModel: entry.fullModel })
            ? entry.name
            : "";
          return (
            <div key={entry.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border bg-card ${entry.disabled ? "border-amber-500/40 opacity-80" : status === "ok" ? "border-green-500/40" : status === "error" ? "border-red-500/40" : status === "inconclusive" ? "border-amber-500/40" : "border-border"}`}>
              <span className="material-symbols-outlined text-lg shrink-0" style={status === "ok" ? { color: "#22c55e" } : status === "error" ? { color: "#ef4444" } : status === "inconclusive" ? { color: "#f59e0b" } : undefined}>smart_toy</span>
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <span
                  className="text-xs text-text-muted font-mono truncate"
                  title={`${entry.fullModel}${secondaryName && secondaryName !== primaryLabel ? ` — ${secondaryName}` : ""}`}
                >
                  {primaryLabel}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sidebar text-text-muted">{entry.isCustom ? "CUSTOM" : "BUILT-IN"}</span>
                  {entry.isFree === true && <span className="text-[9px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">FREE</span>}
                  {entry.isFree === false && <span className="text-[9px] font-bold text-text-muted bg-sidebar px-1.5 py-0.5 rounded">PAID</span>}
                  {typeof entry.isFree !== "boolean" && <span className="text-[9px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">PRICE ?</span>}
                  {entry.disabled && <span className="text-[9px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">DISABLED</span>}
                  {entry.hidden && !entry.disabled && <span className="text-[9px] font-bold text-text-muted bg-sidebar px-1.5 py-0.5 rounded">HIDDEN</span>}
                  {secondaryName && <span className="text-[10px] text-text-muted/70 italic truncate">{secondaryName}</span>}
                  {status === "ok" && <span className="material-symbols-outlined text-sm" style={{ color: "#22c55e" }}>check_circle</span>}
                  {status === "error" && <span className="material-symbols-outlined text-sm" style={{ color: "#ef4444" }}>cancel</span>}
                  {status === "inconclusive" && <span className="material-symbols-outlined text-sm" style={{ color: "#f59e0b" }}>help</span>}
                </div>
              </div>
              <button onClick={() => handleSingleTest(entry)} disabled={testing || !entry.hasConnection || entry.disabled} title={entry.disabled ? "Disabled — re-enable to test" : entry.hasConnection ? "Test model" : "No connection"} className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar disabled:opacity-40">
                <span className="material-symbols-outlined text-base" style={testing ? { animation: "spin 1s linear infinite" } : undefined}>{testing ? "progress_activity" : "play_arrow"}</span>
              </button>
              <button onClick={() => setHidden(entry, !entry.hidden)} title={entry.hidden ? "Show" : "Hide"} className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar">
                <span className="material-symbols-outlined text-base">{entry.hidden ? "visibility_off" : "visibility"}</span>
              </button>
              {entry.disabled ? (
                <button onClick={() => handleEnable(entry)} title="Enable — allow this model again" className="p-1 rounded text-amber-500 hover:text-green-500 hover:bg-sidebar">
                  <span className="material-symbols-outlined text-base">undo</span>
                </button>
              ) : (
                <button onClick={() => setConfirmDisable(entry)} title="Disable — block this model from all requests" className="p-1 rounded text-text-muted hover:text-amber-500 hover:bg-sidebar">
                  <span className="material-symbols-outlined text-base">block</span>
                </button>
              )}
              <button
                onClick={() => copy(entry.fullModel, `avail-${entry.key}`)}
                title={`Copy full id: ${entry.fullModel}`}
                className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar"
              >
                <span className="material-symbols-outlined text-base">{copied === `avail-${entry.key}` ? "check" : "content_copy"}</span>
              </button>
              <button onClick={() => setCompatEntry(entry)} title="Compatibility" className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-primary hover:border-primary/40 whitespace-nowrap">
                <span className="material-symbols-outlined text-sm">tune</span> Compatibility
              </button>
            </div>
          );
        })}
      </div>
      {filtered.length === 0 && <p className="text-xs text-text-muted">No models match the current filters.</p>}
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} className="px-2.5 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:text-primary">Prev</button>
          <span>Page {safePage} of {pageCount} ({filtered.length} models)</span>
          <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={safePage >= pageCount} className="px-2.5 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:text-primary">Next</button>
        </div>
      )}

      {compatEntry && <CompatibilityModal entry={compatEntry} onClose={() => setCompatEntry(null)} />}
      {confirmDisable && (
        <ConfirmModal
          isOpen
          title="Disable model?"
          message={`${confirmDisable.fullModel} will stop receiving requests everywhere (API, Playground, Combos, tests). It stays stored and can be re-enabled later.`}
          confirmText="Disable"
          onClose={() => setConfirmDisable(null)}
          onConfirm={() => handleDisable(confirmDisable)}
        />
      )}
    </div>
  );
}
