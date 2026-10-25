// Regression tests for partial-sync stale preservation and HTML error redaction.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-partialsync-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { persistDiscovered, getSyncedModels, syncedKey } = await import("../src/lib/models/modelSync.js");
const { parseErrorPayload } = await import("../src/lib/net/httpBody.js");

const model = (id, extra = {}) => ({ id, name: id, provider: "test", connectionId: "c1", connectionIds: ["c1"], ...extra });

describe("persistDiscovered partial-failure preservation", () => {
  const alias = "partial-test";

  it("does not stale-mark models from failed connections", async () => {
    await persistDiscovered({ storageAlias: alias, discovered: [model("a"), model("b", { connectionIds: ["c2"] })], manualIds: [] });
    const before = await getSyncedModels(alias);
    assert.equal(Object.keys(before).length, 2);

    const result = await persistDiscovered({
      storageAlias: alias,
      discovered: [model("a")],
      manualIds: [],
      failedConnectionIds: ["c2"],
    });
    assert.equal(result.stale, 0, "model b should NOT be marked stale because c2 failed");
    const after = await getSyncedModels(alias);
    assert.equal(after[syncedKey(alias, "b")]?.stale, false);
  });

  it("stale-marks models from connections that succeeded but no longer list them", async () => {
    const alias2 = "partial-stale";
    await persistDiscovered({ storageAlias: alias2, discovered: [model("x"), model("y")], manualIds: [] });
    const result = await persistDiscovered({
      storageAlias: alias2,
      discovered: [model("x")],
      manualIds: [],
      failedConnectionIds: [],
    });
    assert.equal(result.stale, 1, "model y should be stale (c1 succeeded, y missing)");
    const after = await getSyncedModels(alias2);
    assert.equal(after[syncedKey(alias2, "y")]?.stale, true);
  });

  it("never stale-marks manual models", async () => {
    const alias3 = "manual-prot";
    await persistDiscovered({ storageAlias: alias3, discovered: [model("m")], manualIds: ["m"] });
    const result = await persistDiscovered({
      storageAlias: alias3,
      discovered: [],
      manualIds: ["m"],
      failedConnectionIds: [],
    });
    assert.equal(result.stale, 0, "manual model m should not be stale");
    const after = await getSyncedModels(alias3);
    assert.equal(after[syncedKey(alias3, "m")]?.stale, false);
  });
});

describe("parseErrorPayload HTML redaction", () => {
  it("redacts HTML error pages", () => {
    const html = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>bad</body></html>";
    const msg = parseErrorPayload(html, { status: 502 });
    assert.ok(!msg.includes("<html"), "raw HTML must not leak");
    assert.ok(msg.includes("HTML error page"));
  });

  it("preserves plain-text errors", () => {
    assert.equal(parseErrorPayload("rate limit exceeded"), "rate limit exceeded");
  });

  it("extracts JSON error messages", () => {
    const json = JSON.stringify({ error: { message: "quota exceeded" } });
    assert.equal(parseErrorPayload(json), "quota exceeded");
  });

  it("handles empty/missing input", () => {
    assert.ok(parseErrorPayload("", { status: 500 }).includes("500"));
    assert.ok(parseErrorPayload(null).includes("failed"));
  });
});
