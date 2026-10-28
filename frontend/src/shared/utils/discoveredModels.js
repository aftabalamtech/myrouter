// Client-side mirror of backend/src/lib/models/autoAdd.js.
// Reuses the shared eligibility vocabulary (getTestStatus) so the provider
// page classifies working/error/untested exactly like the Models page.
// Pure functions only — safe for `node --test`.
import { getTestStatus } from "./modelEligibility.js";

// Mirrors backend/src/lib/models/autoAdd.js. Keep the two in sync: the backend
// is authoritative for persistence, this copy drives the dropdown.
export const AUTO_ADD_POLICIES = Object.freeze([
  "working-only",
  "working-disable-failed",
  "working-untested",
  "all",
]);

// Previously-persisted ids kept readable; not offered in the dropdown because
// their behaviour duplicates another option.
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
    "Add working models. Failed models stay in the catalog but go to Disabled models, so they can never be routed to.",
  "working-untested":
    "Add working models and untested models. Failed models stay in the catalog and go to Disabled models.",
  all: "Add every eligible discovered model, whatever its test status.",
});

export function normalizeAutoAddPolicy(value, fallback = "working-only") {
  const resolved = AUTO_ADD_POLICY_ALIASES[value] || value;
  return AUTO_ADD_POLICIES.includes(resolved) ? resolved : fallback;
}

export function stableModelId(id) {
  if (typeof id !== "string") return "";
  return id.trim().slice(0, 200);
}

export function dedupeDiscovered(entries) {
  const byId = new Map();
  for (const entry of entries || []) {
    const id = stableModelId(entry?.id);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { ...entry, id });
  }
  return [...byId.values()];
}

function fullModelOf(storageAlias, id) {
  return `${storageAlias}/${id}`;
}

// testResults here use the provider-page mapping: { [bareId]: "ok" | "error" }.
export function partitionDiscovered({
  catalog,
  storageAlias,
  modelAliases,
  hardcodedIds,
}) {
  const addedFullModels = new Set(
    Object.values(modelAliases || {}).filter((v) => typeof v === "string")
  );
  const hardcoded = new Set(hardcodedIds || []);
  const rows = [];
  for (const entry of dedupeDiscovered(catalog || [])) {
    if (entry?.stale) continue;
    const fullModel = fullModelOf(storageAlias, entry.id);
    const isAdded = addedFullModels.has(fullModel) || hardcoded.has(entry.id);
    rows.push({
      ...entry,
      storageAlias,
      fullModel,
      isAdded,
      isManual: Boolean(entry?.manual) || addedFullModels.has(fullModel),
    });
  }
  return {
    rows,
    added: rows.filter((r) => r.isAdded),
    discovered: rows.filter((r) => !r.isAdded),
  };
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
  const testStatus = getTestStatus(row.id, testResults);
  const disabled = (disabledIds || []).includes(row.id);
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

export function filterDiscovered(
  rows,
  { search = "", status = "all", price = "all", testResults, disabledIds } = {}
) {
  const list = Array.isArray(rows) ? rows : [];
  const ctx = { testResults, disabledIds };
  const base = list.filter(
    (r) => matchesSearch(r, search) && matchesPrice(r, price) && matchesStatus(r, status, ctx)
  );
  const searchOnly = list.filter((r) => matchesSearch(r, search));
  const statusBase = searchOnly.filter((r) => matchesPrice(r, price));
  const priceBase = searchOnly.filter((r) => matchesStatus(r, status, ctx));
  const countBy = (arr, fn) => arr.filter(fn).length;
  const counts = {
    all: searchOnly.filter((r) => matchesPrice(r, price)).length,
    working: countBy(statusBase, (r) => matchesStatus(r, "working", ctx)),
    error: countBy(statusBase, (r) => matchesStatus(r, "error", ctx)),
    inconclusive: countBy(statusBase, (r) => matchesStatus(r, "inconclusive", ctx)),
    disabled: countBy(statusBase, (r) => matchesStatus(r, "disabled", ctx)),
    free: countBy(priceBase, (r) => matchesPrice(r, "free")),
    paid: countBy(priceBase, (r) => matchesPrice(r, "paid")),
    unknown: countBy(priceBase, (r) => matchesPrice(r, "unknown")),
  };
  return { rows: base, counts };
}

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

export function resolveDisableNotAdded(
  filteredRows,
  { disabledIds, hardcodedIds } = {}
) {
  const disabled = new Set(disabledIds || []);
  const hardcoded = new Set(hardcodedIds || []);
  const out = [];
  for (const row of filteredRows || []) {
    const id = stableModelId(row?.id);
    if (!id || row?.isAdded || hardcoded.has(id) || disabled.has(id)) continue;
    out.push(id);
  }
  return out;
}

// discoveredRows: UNADDED rows with bare-id testResults.
// Never re-enables; never adds failed/untested unless allowed.
export function resolveAutoAdd({
  discoveredRows,
  testResults,
  disabledIds,
  policy = "working-only",
  includeUntested = false,
} = {}) {
  const disabled = new Set(disabledIds || []);
  const toAdd = [];
  const toDisable = [];
  const effective = normalizeAutoAddPolicy(policy, "working-only");
  for (const row of discoveredRows || []) {
    const id = stableModelId(row?.id);
    if (!id || row?.isAdded || disabled.has(id)) continue;
    const status = getTestStatus(id, testResults);
    if (effective === "all") {
      toAdd.push(id);
      continue;
    }
    if (status === "ok") {
      toAdd.push(id);
      continue;
    }
    if (status === "error") {
      if (effective === "working-disable-failed" || effective === "working-untested") {
        toDisable.push(id);
      }
      continue;
    }
    if (effective === "working-untested" || includeUntested) toAdd.push(id);
  }
  return { toAdd, toDisable };
}
