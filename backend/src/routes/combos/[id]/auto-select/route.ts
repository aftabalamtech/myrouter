import { getComboById, updateCombo } from "../../../../lib/localDb.js";
import { getWorkingModels } from "../../../../lib/models/eligibility.js";

export async function POST_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    if (!combo) return res.status(404).json({ error: "Combo not found" });

    const working = await getWorkingModels();
    const excluded = new Set(combo.metadata?.excludedModels || []);
    const existing = new Set(combo.models || []);
    const eligible = combo.kind && combo.kind !== "llm" ? [] : working.map((m) => m.fullModel);
    const added = eligible.filter((model) => !existing.has(model) && !excluded.has(model));
    const skipped = eligible.length - added.length;
    const updated = await updateCombo(id, { models: [...combo.models, ...added] });

    return res.json({
      combo: updated,
      summary: { added: added.length, alreadyExisting: eligible.filter((model) => existing.has(model)).length, excluded: eligible.filter((model) => excluded.has(model)).length, skipped },
    });
  } catch {
    return res.status(500).json({ error: "Failed to auto-select working models" });
  }
}
