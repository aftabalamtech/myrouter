// Automated tests: shared model eligibility rules + test-batch pure helpers.
// Run: npm test   (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  splitFullModel,
  isModelBlocked,
  isModelHidden,
  getTestStatus,
  isWorkingModel,
  matchesStatusFilter,
} from "../../frontend/src/shared/utils/modelEligibility.js";

import {
  normalizeModels,
  clampConcurrency,
  sanitizeErrorMessage,
  classifyTestError,
} from "../src/lib/models/testBatch.js";

describe("modelEligibility", () => {
  it("splits on first slash (doubled ids keep remainder)", () => {
    assert.deepEqual(splitFullModel("nvidia/nvidia/ising-x"), { alias: "nvidia", id: "nvidia/ising-x" });
    assert.deepEqual(splitFullModel("oc/big-pickle"), { alias: "oc", id: "big-pickle" });
    assert.deepEqual(splitFullModel("bare"), { alias: "", id: "bare" });
  });

  it("matches blocks/hidden by provider id or alias", () => {
    const blocks = { nvidia: ["a/b"] };
    assert.equal(isModelBlocked("nvidia", "nvidia", "a/b", blocks), true);
    assert.equal(isModelBlocked("other", "nvidia", "a/b", blocks), true);
    assert.equal(isModelBlocked("nvidia", "nvidia", "zzz", blocks), false);
    assert.equal(isModelBlocked("nvidia", "nvidia", "a/b", {}), false);
    assert.equal(isModelHidden("oc", "oc", "m", { oc: ["m"] }), true);
  });

  it("working = passed AND visible AND enabled", () => {
    const ok = { "nvidia/a": "ok" };
    assert.equal(isWorkingModel("nvidia/a", ok, {}, {}), true);
    assert.equal(isWorkingModel("nvidia/a", ok, { nvidia: ["a"] }, {}), false);
    assert.equal(isWorkingModel("nvidia/a", ok, {}, { nvidia: ["a"] }), false);
    assert.equal(isWorkingModel("nvidia/a", { "nvidia/a": "error" }, {}, {}), false);
    assert.equal(isWorkingModel("nvidia/a", {}, {}, {}), false);
  });

  it("status filter matrix", () => {
    assert.equal(matchesStatusFilter({ testStatus: "ok", hidden: false, blocked: false }, "working"), true);
    assert.equal(matchesStatusFilter({ testStatus: "ok", hidden: true, blocked: false }, "working"), false);
    assert.equal(matchesStatusFilter({ testStatus: "error", hidden: true, blocked: true }, "error"), true);
    assert.equal(matchesStatusFilter({ testStatus: "ok", hidden: true, blocked: false }, "hidden"), true);
    assert.equal(matchesStatusFilter({ testStatus: "untested", hidden: true, blocked: true }, "disabled"), true);
    assert.equal(matchesStatusFilter({ testStatus: "untested", hidden: false, blocked: false }, "all"), true);
  });
});

describe("testBatch helpers", () => {
  it("normalizeModels dedupes, trims, defaults kind", () => {
    const out = normalizeModels(["oc/a", "oc/a ", { model: " nvidia/b ", kind: "image" }, 42, null]);
    assert.deepEqual(out, [
      { model: "oc/a", kind: "llm" },
      { model: "nvidia/b", kind: "image" },
    ]);
  });

  it("clampConcurrency respects 1..10 bounds", () => {
    assert.equal(clampConcurrency(0), 1);
    assert.equal(clampConcurrency(4), 4);
    assert.equal(clampConcurrency(99), 10);
    assert.equal(clampConcurrency("x"), 4);
  });

  it("sanitizeErrorMessage redacts secrets", () => {
    const msg = sanitizeErrorMessage("fail sk-abcdef123456 with Bearer tokengoeshere123");
    assert.ok(!msg.includes("sk-abcdef123456"));
    assert.ok(!msg.includes("tokengoeshere123"));
  });

  it("classifyTestError categorizes", () => {
    assert.equal(classifyTestError({ status: 401, error: "x" }), "auth");
    assert.equal(classifyTestError({ status: 429, error: "slow down" }), "rate_limited");
    assert.equal(classifyTestError({ status: 404, error: "no such model" }), "not_found");
    assert.equal(classifyTestError({ status: null, error: "timed out" }), "timeout");
    assert.equal(classifyTestError({ status: 500, error: "boom" }), "network");
    assert.equal(classifyTestError({ status: null, error: "No active credentials for provider" }), "no_connection");
  });
});
