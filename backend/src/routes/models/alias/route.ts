
import { getModelAliases, setModelAlias, deleteModelAlias } from "../../../models/index.js";
import { getSyncedModels } from "../../../lib/models/modelSync.js";
import { getModelTestResults } from "../../../lib/models/modelTestRepo.js";
import { getDisabledByProvider } from "../../../lib/db/repos/disabledModelsRepo.js";
import {
  resolveBulkAliasEntries,
  resolveDiscoveredBulkAliasEntries,
} from "../../../lib/models/autoAdd.js";

export const dynamic = "force-dynamic";

// GET /api/models/alias - Get all aliases
export async function GET(req, res) {
  try {
    const aliases = await getModelAliases();
    return res.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return res.status(500).json({ error: "Failed to fetch aliases" });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT_handler(req, res) {
  try {
    const body = req.body;
    const { model, alias } = body;

    if (!model || !alias) {
      return res.status(400).json({ error: "Model and alias required" });
    }

    await setModelAlias(alias, model);

    return res.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return res.status(500).json({ error: "Failed to update alias" });
  }
}

// POST /api/models/alias - Bulk-add models (the "Add All Models" target).
// Body: { models: [{ model, alias }] }. Idempotent: entries whose alias or
// full-model value already exists are skipped, never overwritten, so manual
// configuration is preserved and repeated calls are safe. Alias collisions
// (same alias, different model) are reported as failed, not silently resolved.
export async function POST_handler(req, res) {
  try {
    const body = req.body || {};
    const existing = await getModelAliases();
    let resolved;
    let total;

    if (body.scope === "discovered") {
      const providerAlias = typeof body.providerAlias === "string" ? body.providerAlias.trim() : "";
      if (!providerAlias) {
        return res.status(400).json({ error: "providerAlias is required for discovered bulk add" });
      }
      const stored = await getSyncedModels(providerAlias);
      const catalog = Object.values(stored || {})
        .filter((entry) => entry && typeof entry === "object" && entry.id)
        .map((entry) => ({ ...entry, id: String(entry.id) }));
      const [testResults, disabledIds] = await Promise.all([
        getModelTestResults(providerAlias),
        getDisabledByProvider(providerAlias),
      ]);
      const filters = body.filters && typeof body.filters === "object" ? body.filters : {};
      resolved = resolveDiscoveredBulkAliasEntries({
        catalog,
        storageAlias: providerAlias,
        existing: existing || {},
        hardcodedIds: Array.isArray(body.hardcodedIds) ? body.hardcodedIds : [],
        search: typeof filters.search === "string" ? filters.search : "",
        status: typeof filters.status === "string" ? filters.status : "all",
        price: typeof filters.price === "string" ? filters.price : "all",
        testResults,
        disabledIds,
      });
      total = resolved.total;
    } else {
      const { models } = body;
      if (!Array.isArray(models)) {
        return res.status(400).json({ error: "models must be an array" });
      }
      if (models.length > 2000) {
        return res.status(400).json({ error: "Too many models (max 2000)" });
      }
      resolved = resolveBulkAliasEntries(models, existing || {});
      total = models.length;
    }

    if (total > 2000) {
      return res.status(400).json({ error: "Too many discovered models to add at once (max 2000); narrow the filters", total });
    }

    const { toAdd, results, skipped, failed: preFailed } = resolved;
    const byModel = new Map(results.map((item) => [`${item.model}\u0000${item.alias}`, item]));
    let added = 0;
    let failed = preFailed;
    for (const { model, alias } of toAdd) {
      const result = byModel.get(`${model}\u0000${alias}`);
      try {
        await setModelAlias(alias, model);
        added += 1;
        if (result) result.status = "added";
      } catch (error) {
        failed += 1;
        if (result) {
          result.status = "failed";
          result.reason = error?.message || "Failed to add model";
        }
      }
    }
    return res.json({ success: true, added, skipped, failed, total, results });
  } catch (error) {
    console.log("Error bulk-adding aliases:", error);
    return res.status(500).json({ error: "Failed to bulk-add models" });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE_handler(req, res) {
  try {
    const { searchParams } = new URL('http://localhost' + req.originalUrl);
    const alias = searchParams.get("alias");

    if (!alias) {
      return res.status(400).json({ error: "Alias required" });
    }

    await deleteModelAlias(alias);

    return res.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return res.status(500).json({ error: "Failed to delete alias" });
  }
}
