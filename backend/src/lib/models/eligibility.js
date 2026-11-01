import { getBlockedModels } from "../db/index.js";
import { getDisabledModels } from "../db/index.js";
import { getCustomModels, getModelAliases } from "../db/index.js";
import { getModelTestResults } from "./modelTestRepo.js";
import { getProviderConnections } from "../localDb.js";
import { getSyncedModels } from "./modelSync.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, FREE_PROVIDERS, getProviderAlias } from "../../shared/constants/providers.js";

/**
 * Centralized server-side model eligibility.
 *
 * Two independent flags (both keyed `{providerAliasOrId: [modelId]}`):
 * - hidden  (disabledModels kv scope): removed from lists, requests still allowed.
 * - blocked (modelBlocks kv scope): removed from lists AND rejected at request time.
 *
 * Test status comes from modelTestRepo keyed by full "alias/model" string:
 * ok (passed) | error (failed/timeout) | untested (no record).
 */

export function splitModelRef(fullModel) {
  const s = String(fullModel || "");
  const slash = s.indexOf("/");
  if (slash <= 0) return { alias: "", id: s };
  return { alias: s.slice(0, slash), id: s.slice(slash + 1) };
}

export function isModelBlocked(provider, modelId, alias, blocks) {
  if (!blocks) return false;
  const keys = new Set([provider, alias].filter(Boolean));
  for (const key of keys) {
    const list = blocks[key];
    if (Array.isArray(list) && list.includes(modelId)) return true;
  }
  return false;
}

export function isModelHidden(provider, modelId, alias, hidden) {
  if (!hidden) return false;
  const keys = new Set([provider, alias].filter(Boolean));
  for (const key of keys) {
    const list = hidden[key];
    if (Array.isArray(list) && list.includes(modelId)) return true;
  }
  return false;
}

export async function loadBlocks() {
  try {
    return await getBlockedModels();
  } catch {
    return {};
  }
}

/**
 * Filter combo member model strings, dropping blocked ones.
 * @returns {{ eligible: string[], blocked: string[] }}
 */
export function partitionComboModels(models, blocks) {
  const eligible = [];
  const blocked = [];
  for (const m of models || []) {
    const { alias, id } = splitModelRef(m);
    if (isModelBlocked(alias, id, alias, blocks)) blocked.push(m);
    else eligible.push(m);
  }
  return { eligible, blocked };
}

function isChatKind(model) {
  const kind = model?.type || model?.kinds?.[0] || "llm";
  if (kind !== "llm") return false;
  const id = String(model?.id || "").toLowerCase();
  return !id.includes("embed") && !id.includes("tts") && !id.includes("stt");
}

/**
 * Centralized eligible-working-models query.
 * THE shared definition used by the Models Working filter, the Playground
 * working list/count, and Combos eligibility:
 *   working = latest test passed AND NOT hidden AND NOT blocked.
 *
 * Universe mirrors the Models page default view (connected providers +
 * no-auth free providers): static catalog + custom models + user aliases,
 * keyed by full "alias/upstream-id" exactly like test records.
 * Live-discovered-only models are covered because tests are keyed by the
 * same full-model strings the router resolves.
 *
 * @param {object} [options]
 * @param {string} [options.providerAlias] - scope to one provider alias
 * @returns {Promise<Array<{provider, alias, id, fullModel, name, testedAt}>>}
 */
export async function getWorkingModels(options = {}) {
  const { providerAlias = null } = options || {};
  const [connections, customModels, modelAliases, hidden, blocks, results, synced] = await Promise.all([
    getProviderConnections().catch(() => []),
    getCustomModels().catch(() => []),
    getModelAliases().catch(() => ({})),
    getDisabledModels().catch(() => ({})),
    loadBlocks(),
    getModelTestResults().catch(() => ({})),
    // Sync-discovered models (OpenAI/Anthropic-compatible nodes have no static
    // catalog — without this their models could never appear as working).
    getSyncedModels(null).catch(() => ({})),
  ]);

  const connected = new Set(
    (connections || []).filter((c) => c?.isActive !== false).map((c) => c.provider || c.id)
  );
  const eligibleProvider = (pid) => connected.has(pid) || FREE_PROVIDERS[pid]?.noAuth;

  const out = new Map(); // fullModel -> entry (dedupe across sources)
  const consider = (providerId, modelId, name) => {
    if (!modelId) return;
    const alias = getProviderAlias(providerId) || providerId;
    if (providerAlias && alias !== providerAlias) return;
    const fullModel = `${alias}/${modelId}`;
    if (out.has(fullModel)) return;
    if (isModelHidden(providerId, modelId, alias, hidden)) return;
    if (isModelBlocked(providerId, modelId, alias, blocks)) return;
    const rec = results[fullModel];
    if (rec?.status !== "passed") return;
    out.set(fullModel, {
      provider: providerId,
      alias,
      id: modelId,
      fullModel,
      name: name || modelId,
      testedAt: rec.testedAt || null,
    });
  };

  for (const pid of Object.keys(AI_PROVIDERS)) {
    if (!eligibleProvider(pid)) continue;
    const palias = getProviderAlias(pid) || pid;
    for (const m of PROVIDER_MODELS[palias] || PROVIDER_MODELS[pid] || []) {
      if (!isChatKind(m)) continue;
      consider(pid, m.id, m.name || m.id);
    }
  }
  for (const m of customModels || []) {
    const pid = Object.keys(AI_PROVIDERS).find((id) => (getProviderAlias(id) || id) === m.providerAlias)
      || m.providerAlias;
    if (!eligibleProvider(pid)) continue;
    if (!isChatKind({ id: m.id, type: m.type || "llm" })) continue;
    consider(pid, m.id, m.name || m.id);
  }
  // Sync-discovered catalog: keyed "storageAlias|modelId". Compatible-provider
  // nodes store models under the node id (providerId === storageAlias), so the
  // connection check below works unchanged.
  for (const record of Object.values(synced || {})) {
    if (!record || !record.id || record.stale) continue;
    const storageAlias = record.storageAlias || record.providerAlias;
    if (!storageAlias) continue;
    const pid = Object.keys(AI_PROVIDERS).find((k) => (getProviderAlias(k) || k) === storageAlias) || storageAlias;
    if (!eligibleProvider(pid)) continue;
    if (!isChatKind({ id: record.id, type: record.type || "llm" })) continue;
    consider(pid, record.id, record.name || record.id);
  }

  for (const [aliasName, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.includes("/")) continue;
    const { alias, id } = splitModelRef(fullModel);
    if (!id) continue;
    const pid = Object.keys(AI_PROVIDERS).find((k) => (getProviderAlias(k) || k) === alias) || alias;
    if (!eligibleProvider(pid)) continue;
    if (!isChatKind({ id })) continue;
    if (!out.has(fullModel)) {
      consider(pid, id, aliasName);
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
