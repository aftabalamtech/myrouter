import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-meta-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { createCombo, getComboById, updateCombo } = await import("../src/lib/db/repos/combosRepo.js");

test("combo metadata persists auto-selection and explicit exclusions", async () => {
  const combo = await createCombo({
    name: "working-set",
    models: ["openai/gpt-test", "openai/gpt-test"],
    metadata: { autoSelectWorking: true, excludedModels: ["other/model", "other/model"] },
  });
  assert.deepEqual(combo.models, ["openai/gpt-test"]);
  assert.equal(combo.metadata.autoSelectWorking, true);
  assert.deepEqual(combo.metadata.excludedModels, ["other/model"]);

  const updated = await updateCombo(combo.id, { models: ["openai/gpt-test", "anthropic/claude-test"] });
  assert.deepEqual(updated.models, ["openai/gpt-test", "anthropic/claude-test"]);
  assert.equal(updated.metadata.autoSelectWorking, true);
  assert.deepEqual(updated.metadata.excludedModels, ["other/model"]);

  const reloaded = await getComboById(combo.id);
  assert.deepEqual(reloaded, updated);
});
