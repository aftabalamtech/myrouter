
import { pingModelByKind } from "./ping.js";
import { saveModelTestResult } from "../../../lib/models/modelTestRepo.js";
import { classifyTestError } from "../../../lib/models/testBatch.js";

function classifySingleTestError(result) {
  return classifyTestError({ status: result?.status, error: result?.error });
}

function isInconclusiveCode(code) {
  return code === "timeout" || code === "network" || code === "rate_limited";
}

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST_handler(req, res) {
  try {
    const { model, kind } = req.body;
    if (!model) return res.status(400).json({ error: "Model required" });
    const result = await pingModelByKind(model, kind || "llm");
    const errorCode = result.ok ? null : classifySingleTestError(result);
    const status = result.ok ? "passed" : (isInconclusiveCode(errorCode) ? "inconclusive" : "failed");
    await saveModelTestResult(model, {
      status,
      latencyMs: result.latencyMs,
      errorCode,
      errorMessage: result.ok ? null : result.error,
      testedAt: new Date().toISOString(),
    });
    return res.json({ ...result, status, errorCode });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
