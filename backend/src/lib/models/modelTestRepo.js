import { makeKv } from "../db/helpers/kvStore.js";

const store = makeKv("modelTestResults");

export async function saveModelTestResult(fullModel, result) {
  if (!fullModel || typeof fullModel !== "string") return;
  const record = {
    status: result.status,
    latencyMs: result.latencyMs ?? null,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    testedAt: result.testedAt ?? new Date().toISOString(),
  };
  await store.set(fullModel, record);
  if (record.status === "passed") {
    const { autoSelectVerifiedWorkingModel } = await import("./comboAutoSelect.js");
    await autoSelectVerifiedWorkingModel(fullModel).catch(() => {});
  }
}

export async function getModelTestResults(providerAlias) {
  const all = await store.getAll();
  if (!providerAlias) return all;
  const prefix = `${providerAlias}/`;
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(prefix)) out[key] = value;
  }
  return out;
}

export async function clearModelTestResults(providerAlias) {
  if (!providerAlias) return;
  const all = await store.getAll();
  const prefix = `${providerAlias}/`;
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) await store.remove(key);
  }
}
