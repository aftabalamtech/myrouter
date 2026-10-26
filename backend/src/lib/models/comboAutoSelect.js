import { getComboById, getCombos, updateCombo } from "../localDb.js";
import { getWorkingModels } from "./eligibility.js";

const locks = new Map();

async function withComboLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(id, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === queued) locks.delete(id);
  }
}

export async function autoSelectVerifiedWorkingModel(fullModel) {
  const working = await getWorkingModels();
  if (!working.some((model) => model.fullModel === fullModel)) return [];
  const combos = await getCombos();
  const updated = [];

  for (const combo of combos) {
    if (combo.kind && combo.kind !== "llm") continue;
    if (!combo.metadata?.autoSelectWorking) continue;
    const result = await withComboLock(combo.id, async () => {
      const current = await getComboById(combo.id);
      if (!current?.metadata?.autoSelectWorking) return null;
      if (current.models.includes(fullModel)) return null;
      if ((current.metadata.excludedModels || []).includes(fullModel)) return null;
      return updateCombo(current.id, { models: [...current.models, fullModel] });
    });
    if (result) updated.push(result);
  }
  return updated;
}
