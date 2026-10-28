// Centralized client-side model eligibility.
// Single source of truth for Models page, Playground, Combos/ModelSelectModal.
// Mirrors the server rules in backend/src/lib/models/eligibility.js:
//
// - hidden  (/api/models/disabled, keyed {aliasOrId: [modelId]}):
//   removed from normal lists, requests still allowed.
// - blocked (/api/models/blocks, keyed {aliasOrId: [modelId]}):
//   removed from normal lists AND rejected at request time (HTTP 403).
// - test status (/api/models/test-results, keyed "alias/model"):
//   "ok" (passed) | "error" (failed) | "inconclusive" (timeout/unknown) |
//   "untested" (no record).

export function splitFullModel(fullModel) {
  const s = String(fullModel || "");
  const slash = s.indexOf("/");
  if (slash <= 0) return { alias: "", id: s };
  return { alias: s.slice(0, slash), id: s.slice(slash + 1) };
}

function idsIn(map, keys) {
  const out = new Set();
  for (const key of keys) {
    if (!key) continue;
    const list = map?.[key];
    if (Array.isArray(list)) for (const id of list) out.add(id);
  }
  return out;
}

export function isModelHidden(providerId, providerAlias, modelId, hiddenMap) {
  if (!hiddenMap) return false;
  return idsIn(hiddenMap, [providerId, providerAlias]).has(modelId);
}

export function isModelBlocked(providerId, providerAlias, modelId, blocksMap) {
  if (!blocksMap) return false;
  return idsIn(blocksMap, [providerId, providerAlias]).has(modelId);
}

// testResults: { "alias/model": "ok" | "error" | "inconclusive" }
export function getTestStatus(fullModel, testResults) {
  const s = testResults?.[fullModel];
  if (s === "ok") return "ok";
  if (s === "error") return "error";
  if (s === "inconclusive") return "inconclusive";
  return "untested";
}

export function isWorkingModel(fullModel, testResults, blocksMap, hiddenMap) {
  if (getTestStatus(fullModel, testResults) !== "ok") return false;
  const { alias, id } = splitFullModel(fullModel);
  if (isModelBlocked(alias, alias, id, blocksMap)) return false;
  if (isModelHidden(alias, alias, id, hiddenMap)) return false;
  return true;
}

// Status filter shared by the Models page. Combines with the existing
// visibility filter via AND — except "disabled", which shows all blocked
// models even if they are also hidden.
// Shared working definition (same as GET /api/models/working):
// working = latest test passed AND NOT hidden AND NOT blocked.
export function matchesStatusFilter({ testStatus, hidden, blocked }, statusFilter) {
  switch (statusFilter) {
    case "working":
      return testStatus === "ok" && !hidden && !blocked;
    case "error":
      return testStatus === "error";
    case "inconclusive":
      return testStatus === "inconclusive";
    case "hidden":
      return hidden;
    case "disabled":
      return blocked;
    default:
      return true;
  }
}

// Eligibility for selection lists (Playground, Combos, ModelSelectModal):
// hidden and blocked models are excluded from normal selection.
export function isSelectable({ hidden, blocked }) {
  return !hidden && !blocked;
}
