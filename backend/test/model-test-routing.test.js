import test from "node:test";
import assert from "node:assert/strict";
import { validateChatCompletion } from "../src/routes/models/test/ping.js";
import { classifyTestError, summarizeResults } from "../src/lib/models/testBatch.js";

test("streaming Playground-compatible completion is accepted only with text", () => {
  assert.deepEqual(validateChatCompletion('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n'), { ok: true });
  assert.equal(validateChatCompletion('data: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n').ok, false);
});

test("authentication and invalid models remain definitive", () => {
  assert.equal(classifyTestError({ status: 401, error: "Unauthorized" }), "auth");
  assert.equal(classifyTestError({ status: 404, error: "No such model" }), "not_found");
});

test("temporary outcomes are inconclusive counters, not failed", () => {
  const summary = summarizeResults([{ status: "inconclusive" }, { status: "timeout" }, { status: "failed" }]);
  assert.equal(summary.inconclusive, 2);
  assert.equal(summary.failed, 1);
});
