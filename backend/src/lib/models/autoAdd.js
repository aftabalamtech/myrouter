// Unified model sync & auto-add helpers (pure, dependency-free).
//
// Single source of truth for the discovered-vs-added workflow used by the
// provider sync panel. Everything here is intentionally side-effect free so it
// runs identically on SQLite/PostgreSQL deployments and is unit-testable with
// `node --test` (no DB imports allowed in this file).
//
// Stable identity: provider storage alias (providerId for OpenAI/Anthropic-
// compatible nodes, provider alias otherwise) + trimmed upstream model id.
// Syncing refreshes the discovered catalog; added models (aliases) are never
// recreated or deleted by these helpers.

// Auto-Add policies.
//
// AUTO_ADD_POLICIES is what the UI offers. Every entry produces a DISTINCT
// outcome — the requirement is to avoid options that silently behave the same.
//
// AUTO_ADD_POLICY_ALIASES keeps previously-persisted settings working.
// "working-ignore-failed" was an earlier id whose behaviour is exactly
// "working-only" (add working, touch nothing else); it is accepted on read and
// normalized, but is NOT offered in the dropdown so users never see two
// identical choices.
export const AUTO_ADD_POLICIES = Object.freeze([
  "working-only",
  "working-disable-failed",
  "working-untested",
  "all",
]);

export const AUTO_ADD_POLICY_ALIASES = Object.freeze({
  "working-ignore-failed": "working-only",
});

export const AUTO_ADD_POLICY_LABELS = Object.freeze({
  "working-only": "Working models only",
  "working-disable-failed": "Working models + failed disabled",
  "working-untested": "Working models + untested models",
  all: "All discovered models",
});

export const AUTO_ADD_POLICY_DESCRIPTIONS = Object.freeze({
  "working-only":
    "Add models whose latest test passed. Untested and failed models stay in the discovered catalog for manual review.",
  "working-disable-failed":
    "Add working models. Failed models stay in the catalog but are placed in Disabled models, so they can never be routed to.",
  "working-untested":
    "Add working models and untested models. Failed models stay in the catalog and are placed in Disabled models.",
  all: "Add every eligible discovered model, whatever its test status.",
});

export const DEFAULT_SYNC_SETTINGS = Object.freeze({
  autoFetch: false,
  autoSync: false,
  lastSyncAt: null,
  autoAdd: false,
  autoAddPolicy: "working-only",
  includeUntested: false,
});

// Discovered-section filters (mirror of the Models tab vocabulary).
export const DISCOVERED_STATUS_FILTERS = Object.freeze([
  "all",
  "working",
  "error",
  "disabled",
]);

export const DISCOVERED_PRICE_FILTERS = Object.freeze(["all", "free", "paid"]);

export function normalizeAutoAddPolicy(value, fallback = "working-only") {
  const resolved = AUTO_ADD_POLICY_ALIASES[value] || value;
  return AUTO_ADD_POLICIES.includes(resolved) ? resolved : fallback;
}

// Merge stored sync settings with defaults so records written before Auto-Add
// existed keep working. Never throws; unknown fields are dropped.
export function normalizeSyncSettings(raw) {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    autoFetch: typeof base.autoFetch === "boolean" ? base.autoFetch : false,
    autoSync: typeof base.autoSync === "boolean" ? base.autoSync : false,
    lastSyncAt:
      typeof base.lastSyncAt === "string" || base.lastSyncAt === null
        ? base.lastSyncAt ?? null
        : null,
    autoAdd: typeof base.autoAdd === "boolean" ? base.autoAdd : false,
    autoAddPolicy: normalizeAutoAddPolicy(
      base.autoAddPolicy,
      DEFAULT_SYNC_SETTINGS.autoAddPolicy
    ),
    includeUntested:
      typeof base.includeUntested === "boolean" ? base.includeUntested : false,
  };
}

export function stableModelId(id) {
  if (typeof id !== "string") return "";
  return id.trim().slice(0, 200);
}

// Dedupe upstream entries by stable id (first-seen wins, connectionIds merged).
// Handles duplicate upstream entries safely without inventing identities.
export function dedupeDiscovered(entries) {
  const byId = new Map();
  for (const entry of entries || []) {
    const id = stableModelId(entry?.id);
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      const seen = new Set(existing.connectionIds || []);
      for (const cid of entry?.connectionIds || []) {
        if (cid && !seen.has(cid)) {
          seen.add(cid);
          existing.connectionIds.push(cid);
        }
      }
    } else {
      byId.set(id, {
        ...entry,
        id,
        connectionIds: Array.isArray(entry?.connectionIds)
          ? [...entry.connectionIds]
          : [],
      });
    }
  }
  return [...byId.values()];
}

// Test status from the existing test-results system. Accepts both the client
// mapping ("ok" | "error") and the persisted record shape
// ({ status: "passed" | "failed" | "timeout" }). Anything else is "untested" —
// never-tested models are never classified as working or failed.
export function testStatusOf(fullModel, testResults) {
  const raw = testResults?.[fullModel];
  const status = typeof raw === "string" ? raw : raw?.status;
  if (status === "ok" || status === "passed") return "ok";
  if (status === "inconclusive") return "inconclusive";
  if (status === "error" || status === "failed" || status === "timeout")
    return "error";
  return "untested";
}

function fullModelOf(storageAlias, id) {
  return `${storageAlias}/${id}`;
}

// Split the synced catalog into added vs discovered-only rows.
// Added = already has an alias record OR is a built-in (hardcoded) id.
// Discovered-only rows are the only ones the bulk/auto-add flows may create.
export function partitionDiscovered({
  catalog,
  storageAlias,
  addedFullModels,
  hardcodedIds,
}) {
  const addedSet =
    addedFullModels instanceof Set
      ? addedFullModels
      : new Set(
          Object.values(addedFullModels || {}).filter(
            (v) => typeof v === "string"
          )
        );
  const hardcoded = hardcodedIds instanceof Set ? hardcodedIds : new Set(hardcodedIds || []);
  const rows = [];
  for (const entry of dedupeDiscovered(catalog || [])) {
    if (entry?.stale) continue; // stale upstream drops are never offered
    const isAdded =
      addedSet.has(fullModelOf(storageAlias, entry.id)) ||
      hardcoded.has(entry.id);
    rows.push({
      ...entry,
      storageAlias,
      fullModel: fullModelOf(storageAlias, entry.id),
      isAdded,
      isManual: Boolean(entry?.manual) || addedSet.has(fullModelOf(storageAlias, entry.id)),
    });
  }
  const added = rows.filter((r) => r.isAdded);
  const discovered = rows.filter((r) => !r.isAdded);
  return { rows, added, discovered };
}

function matchesSearch(row, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return true;
  return (
    String(row?.id || "").toLowerCase().includes(q) ||
    String(row?.name || "").toLowerCase().includes(q)
  );
}

function matchesPrice(row, price) {
  const known = typeof row?.isFree === "boolean";
  if (price === "free") return row.isFree === true;
  if (price === "paid") return row.isFree === false;
  if (price === "unknown") return !known;
  return true;
}

function matchesStatus(row, status, { testResults, disabledIds }) {
  const testStatus = testStatusOf(row.fullModel, testResults);
  const disabled = disabledIds instanceof Set
    ? disabledIds.has(row.id)
    : (disabledIds || []).includes(row.id);
  switch (status) {
    case "working":
      return testStatus === "ok" && !disabled;
    case "error":
      return testStatus === "error";
    case "inconclusive":
      return testStatus === "inconclusive";
    case "disabled":
      return disabled;
    case "all":
    default:
      return true;
  }
}

// Filter discovered-only rows. Faceted counts stay consistent with the UI:
// status counts respect search+price, price counts respect search+status, and
// the selected facet's count always equals the returned rows.
export function filterDiscovered(
  rows,
  { search = "", status = "all", price = "all", testResults, disabledIds } = {}
) {
  const list = Array.isArray(rows) ? rows : [];
  const base = list.filter(
    (r) => matchesSearch(r, search) && matchesPrice(r, price) && matchesStatus(r, status, { testResults, disabledIds })
  );
  const searchOnly = list.filter((r) => matchesSearch(r, search));
  const statusBase = searchOnly.filter((r) => matchesPrice(r, price));
  const priceBase = searchOnly.filter((r) =>
    matchesStatus(r, status, { testResults, disabledIds })
  );
  const countBy = (arr, fn) => arr.filter(fn).length;
  const counts = {
    all: searchOnly.filter((r) => matchesPrice(r, price)).length,
    working: countBy(statusBase, (r) =>
      matchesStatus(r, "working", { testResults, disabledIds })
    ),
    error: countBy(statusBase, (r) =>
      matchesStatus(r, "error", { testResults, disabledIds })
    ),
    inconclusive: countBy(statusBase, (r) =>
      matchesStatus(r, "inconclusive", { testResults, disabledIds })
    ),
    disabled: countBy(statusBase, (r) =>
      matchesStatus(r, "disabled", { testResults, disabledIds })
    ),
    free: countBy(priceBase, (r) => matchesPrice(r, "free")),
    paid: countBy(priceBase, (r) => matchesPrice(r, "paid")),
    unknown: countBy(priceBase, (r) => matchesPrice(r, "unknown")),
  };
  return { rows: base, counts };
}

// Bulk "Add All" target resolution over the CURRENTLY FILTERED rows.
// Returns stable ids to add plus ids skipped because they already exist.
// Never deletes; never touches disabled state.
export function resolveBulkAdd(filteredRows) {
  const targets = [];
  const skipped = [];
  for (const row of filteredRows || []) {
    const id = stableModelId(row?.id);
    if (!id) continue;
    if (row?.isAdded) skipped.push(id);
    else targets.push(id);
  }
  return { targets, skipped };
}

// "Disable models not added" target resolution: filtered discovered rows that
// were not added, excluding hardcoded built-ins, already-added rows and
// already-disabled rows. Manual disables are never re-enabled by this path.
export function resolveDisableNotAdded(
  filteredRows,
  { disabledIds, hardcodedIds } = {}
) {
  const disabled = disabledIds instanceof Set ? disabledIds : new Set(disabledIds || []);
  const hardcoded = hardcodedIds instanceof Set ? hardcodedIds : new Set(hardcodedIds || []);
  const out = [];
  for (const row of filteredRows || []) {
    const id = stableModelId(row?.id);
    if (!id || row?.isAdded || hardcoded.has(id) || disabled.has(id)) continue;
    out.push(id);
  }
  return out;
}

// Bulk alias resolution (pure core of POST /api/models/alias).
// existing: { alias: fullModel } map. entries: [{ model, alias }].
// Never overwrites: alias-taken-by-another-model and empty entries fail,
// already-known aliases/models skip, the rest are queued to add. Idempotent.
export function resolveBulkAliasEntries(entries, existing) {
  const known = { ...(existing || {}) };
  const knownModels = new Set(
    Object.values(known).filter((v) => typeof v === "string")
  );
  const toAdd = [];
  const results = [];
  let skipped = 0;
  let failed = 0;
  const list = Array.isArray(entries) ? entries.slice(0, 2000) : [];
  for (const entry of list) {
    const model = typeof entry?.model === "string" ? entry.model : "";
    const alias = typeof entry?.alias === "string" ? entry.alias : "";
    if (!model || !alias) {
      failed += 1;
      results.push({ model, alias, status: "failed", reason: "Model and alias are required" });
      continue;
    }
    const current = known[alias];
    if (current === model || knownModels.has(model)) {
      skipped += 1;
      results.push({ model, alias, status: "skipped", reason: "Already added" });
      continue;
    }
    if (current !== undefined && current !== model) {
      failed += 1;
      results.push({ model, alias, status: "failed", reason: "Alias already maps to a different model" });
      continue;
    }
    toAdd.push({ model, alias });
    results.push({ model, alias, status: "pending", reason: "" });
    known[alias] = model;
    knownModels.add(model);
  }
  return { toAdd, results, skipped, failed };
}

export function defaultAliasForModel(modelId) {
  const parts = String(modelId || "").split("/");
  return parts[parts.length - 1] || String(modelId || "");
}

// Server-side "Add All Discovered" resolution. The client sends only the
// provider and the active filters; the server re-reads the persisted catalog so
// a stale/truncated browser list can never limit how many models are added.
export function resolveDiscoveredBulkAliasEntries({
  catalog,
  storageAlias,
  existing,
  hardcodedIds,
  search = "",
  status = "all",
  price = "all",
  testResults,
  disabledIds,
} = {}) {
  const addedFullModels = new Set(
    Object.values(existing || {}).filter((v) => typeof v === "string")
  );
  const { discovered } = partitionDiscovered({
    catalog,
    storageAlias,
    addedFullModels,
    hardcodedIds,
  });
  const { rows } = filterDiscovered(discovered, {
    search,
    status,
    price,
    testResults,
    disabledIds,
  });
  const entries = rows.map((row) => ({
    model: row.fullModel,
    alias: defaultAliasForModel(row.id),
  }));
  const resolved = resolveBulkAliasEntries(entries, existing);
  return { ...resolved, total: entries.length };
}

// Auto-Add policy resolution over discovered-only (unadded) rows.
// Returns { toAdd, toDisable } as stable ids. Pure: performs no writes, never
// re-enables anything, never adds failed/untested models unless the policy (or
// explicit includeUntested) allows it.
export function resolveAutoAdd({
  discoveredRows,
  testResults,
  disabledIds,
  policy = "working-only",
  includeUntested = false,
} = {}) {
  const disabled = disabledIds instanceof Set ? disabledIds : new Set(disabledIds || []);
  const toAdd = [];
  const toDisable = [];
  const effective = normalizeAutoAddPolicy(policy, "working-only");
  for (const row of discoveredRows || []) {
    const id = stableModelId(row?.id);
    if (!id || row?.isAdded || disabled.has(id)) continue;
    const status = testStatusOf(row.fullModel || id, testResults);
    if (effective === "all") {
      // Everything eligible, subject to the existing safety rules above.
      toAdd.push(id);
      continue;
    }
    if (status === "ok") {
      toAdd.push(id);
      continue;
    }
    if (status === "error") {
      // `working-ignore-failed` deliberately touches nothing on failure.
      if (effective === "working-disable-failed" || effective === "working-untested") {
        toDisable.push(id);
      }
      continue;
    }
    // status === "untested" or "inconclusive": unknown, never failed.
    if (effective === "working-untested" || includeUntested) toAdd.push(id);
  }
  return { toAdd, toDisable };
}
