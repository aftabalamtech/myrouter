// Unified model sync & auto-add tests (pure helpers, no DB).
// Run: npm test  (node --test, no extra dependencies)
//
// Covers: no-duplicate sync, discovered/added separation, filter matrix +
// counts, bulk-add filter fidelity, skip-existing, disable-not-added scope,
// auto-add policies (incl. OFF), fail->pass transitions, manual preservation,
// empty-catalog safety, cross-provider aliases, and bulk scale.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_ADD_POLICIES,
  normalizeSyncSettings,
  normalizeAutoAddPolicy,
  stableModelId,
  dedupeDiscovered,
  testStatusOf,
  partitionDiscovered,
  filterDiscovered,
  resolveBulkAdd,
  resolveBulkAliasEntries,
  resolveDisableNotAdded,
  resolveAutoAdd,
} from "../src/lib/models/autoAdd.js";

const catalog = (ids) => ids.map((id) => ({ id, name: id }));

describe("stable identity + dedupe (no-duplicate sync)", () => {
  it("trims ids and drops empty/non-string entries", () => {
    assert.equal(stableModelId("  gpt-4o  "), "gpt-4o");
    assert.equal(stableModelId(""), "");
    assert.equal(stableModelId(null), "");
    assert.equal(stableModelId(42), "");
  });

  it("dedupeDiscovered collapses duplicate upstream entries (first wins)", () => {
    const out = dedupeDiscovered([
      { id: "a", connectionIds: ["c1"] },
      { id: " a ", connectionIds: ["c2"] },
      { id: "", connectionIds: [] },
      { id: "b", connectionIds: ["c1"] },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "a");
    assert.deepEqual(out[0].connectionIds.sort(), ["c1", "c2"]);
  });

  it("repeated syncs are idempotent: same catalog -> same partition", () => {
    const opts = { storageAlias: "nvidia", addedFullModels: new Set(["nvidia/a"]), hardcodedIds: ["built-in"] };
    const first = partitionDiscovered({ catalog: catalog(["a", "b", "built-in"]), ...opts });
    const second = partitionDiscovered({ catalog: catalog(["b", "a", "built-in", "b"]), ...opts });
    assert.deepEqual(
      second.discovered.map((r) => r.id),
      first.discovered.map((r) => r.id)
    );
  });
});

describe("discovered vs added separation", () => {
  it("added (alias), manual and hardcoded models never appear as discovered", () => {
    const { rows, added, discovered } = partitionDiscovered({
      catalog: [
        { id: "a" },
        { id: "b", manual: true },
        { id: "built-in" },
        { id: "stale-x", stale: true },
      ],
      storageAlias: "nvidia",
      addedFullModels: { x: "nvidia/a", y: "nvidia/b" },
      hardcodedIds: ["built-in"],
    });
    assert.deepEqual(discovered.map((r) => r.id), []);
    assert.equal(added.length, 3);
    assert.ok(rows.every((r) => !r.stale));
    assert.ok(!rows.some((r) => r.id === "stale-x"));
  });

  it("preserves provider prefixes and metadata on rows", () => {
    const { discovered } = partitionDiscovered({
      catalog: [{ id: "auto", name: "Auto", type: "llm", isFree: true, contextLength: 200000 }],
      storageAlias: "qoder",
      addedFullModels: {},
      hardcodedIds: [],
    });
    assert.equal(discovered[0].fullModel, "qoder/auto");
    assert.equal(discovered[0].isFree, true);
    assert.equal(discovered[0].contextLength, 200000);
  });
});

describe("test status vocabulary (single status system)", () => {
  it("accepts client and persisted shapes; untested is never ok/error", () => {
    assert.equal(testStatusOf("a/m", { "a/m": "ok" }), "ok");
    assert.equal(testStatusOf("a/m", { "a/m": { status: "passed" } }), "ok");
    assert.equal(testStatusOf("a/m", { "a/m": "error" }), "error");
    assert.equal(testStatusOf("a/m", { "a/m": { status: "failed" } }), "error");
    assert.equal(testStatusOf("a/m", { "a/m": { status: "timeout" } }), "error");
    assert.equal(testStatusOf("a/m", {}), "untested");
    assert.equal(testStatusOf("a/m", { "a/other": "ok" }), "untested");
  });

  it("a previously failing model becomes working after a successful test", () => {
    const before = testStatusOf("nvidia/a", { "nvidia/a": { status: "failed" } });
    const after = testStatusOf("nvidia/a", { "nvidia/a": { status: "passed" } });
    assert.equal(before, "error");
    assert.equal(after, "ok");
  });
});

function fixtureRows() {
  // discovered-only rows (isAdded: false) with mixed status/price/disabled
  return [
    { id: "w-free", fullModel: "p/w-free", isFree: true },
    { id: "w-paid", fullModel: "p/w-paid", isFree: false },
    { id: "bad", fullModel: "p/bad", isFree: false },
    { id: "newbie", fullModel: "p/newbie", isFree: null },
    { id: "off", fullModel: "p/off", isFree: true },
  ];
}

function fixtureCtx() {
  return {
    testResults: { "p/w-free": "ok", "p/w-paid": "ok", "p/bad": "error" },
    disabledIds: ["off"],
  };
}

describe("discovered filters + counts", () => {
  it("all/working/error/disabled/free/paid return correct rows", () => {
    const rows = fixtureRows();
    const ctx = fixtureCtx();
    assert.deepEqual(filterDiscovered(rows, { ...ctx, status: "all" }).rows.map((r) => r.id).sort(), ["bad", "newbie", "off", "w-free", "w-paid"]);
    assert.deepEqual(filterDiscovered(rows, { ...ctx, status: "working" }).rows.map((r) => r.id).sort(), ["w-free", "w-paid"]);
    assert.deepEqual(filterDiscovered(rows, { ...ctx, status: "error" }).rows.map((r) => r.id), ["bad"]);
    assert.deepEqual(filterDiscovered(rows, { ...ctx, status: "disabled" }).rows.map((r) => r.id), ["off"]);
    assert.deepEqual(filterDiscovered(rows, { ...ctx, price: "free" }).rows.map((r) => r.id).sort(), ["off", "w-free"]);
    assert.deepEqual(filterDiscovered(rows, { ...ctx, price: "paid" }).rows.map((r) => r.id).sort(), ["bad", "w-paid"]);
    assert.deepEqual(filterDiscovered(rows, { ...ctx, price: "unknown" }).rows.map((r) => r.id), ["newbie"]);
  });

  it("unknown pricing is never inferred as free or paid", () => {
    const rows = [{ id: "mystery", fullModel: "p/mystery", isFree: null }];
    const ctx = { testResults: {}, disabledIds: [] };
    assert.deepEqual(filterDiscovered(rows, { ...ctx, price: "all" }).rows.map((r) => r.id), ["mystery"]);
    assert.equal(filterDiscovered(rows, { ...ctx, price: "free" }).rows.length, 0);
    assert.equal(filterDiscovered(rows, { ...ctx, price: "paid" }).rows.length, 0);
  });

  it("search combines with filters (id or name)", () => {
    const rows = [{ id: "gpt-4o", name: "GPT Four O" }, { id: "claude-x", name: "Other" }];
    const out = filterDiscovered(rows, { search: "four", status: "all", price: "all" });
    assert.deepEqual(out.rows.map((r) => r.id), ["gpt-4o"]);
    assert.equal(out.counts.all, 1);
  });

  it("selected facet counts match the returned rows", () => {
    const rows = fixtureRows();
    const ctx = fixtureCtx();
    for (const status of ["all", "working", "error", "disabled"]) {
      const out = filterDiscovered(rows, { ...ctx, status, price: "all" });
      assert.equal(out.rows.length, out.counts[status], `status=${status}`);
    }
    const free = filterDiscovered(rows, { ...ctx, status: "all", price: "free" });
    assert.equal(free.rows.length, free.counts.free);
    const paid = filterDiscovered(rows, { ...ctx, status: "working", price: "paid" });
    assert.equal(paid.rows.length, paid.counts.paid);
    assert.equal(paid.rows.length, paid.counts.working);
  });
});

describe("Add All respects filters + skips existing", () => {
  it("targets only the filtered rows; added rows are skipped", () => {
    const rows = fixtureRows().map((r) => ({ ...r, isAdded: r.id === "w-free" }));
    const filtered = filterDiscovered(rows.filter((r) => !r.isAdded), {
      ...fixtureCtx(),
      status: "working",
    }).rows;
    const { targets, skipped } = resolveBulkAdd(filtered);
    assert.deepEqual(targets, ["w-paid"]);
    assert.deepEqual(skipped, []);
    const withAdded = resolveBulkAdd(rows);
    assert.ok(withAdded.skipped.includes("w-free"));
    assert.ok(!withAdded.targets.includes("w-free"));
  });

  it("resolveBulkAliasEntries never overwrites manual aliases", () => {
    const existing = { keep: "p/a", clash: "p/other" };
    const { toAdd, skipped, failed } = resolveBulkAliasEntries(
      [
        { model: "p/a", alias: "keep" }, // identical -> skip
        { model: "p/a", alias: "new-alias" }, // model known -> skip
        { model: "p/z", alias: "clash" }, // alias taken -> fail, no overwrite
        { model: "p/b", alias: "b" }, // add
        { model: "p/b", alias: "b2" }, // same model twice -> second skips
        { model: "", alias: "x" }, // invalid -> fail
      ],
      existing
    );
    assert.deepEqual(toAdd, [{ model: "p/b", alias: "b" }]);
    assert.equal(skipped, 3);
    assert.equal(failed, 2);
  });
});

describe("disable-not-added scope", () => {
  it("disables only filtered, unadded, non-hardcoded, non-disabled rows", () => {
    const rows = [
      { id: "a", isAdded: false },
      { id: "b", isAdded: true },
      { id: "c", isAdded: false },
      { id: "built-in", isAdded: false },
    ];
    const out = resolveDisableNotAdded(rows, {
      disabledIds: ["c"],
      hardcodedIds: ["built-in"],
    });
    assert.deepEqual(out, ["a"]);
  });
});

describe("auto-add policies", () => {
  const rows = () => [
    { id: "w", fullModel: "p/w" },
    { id: "bad", fullModel: "p/bad" },
    { id: "newbie", fullModel: "p/newbie" },
    { id: "off", fullModel: "p/off" },
    { id: "added", fullModel: "p/added", isAdded: true },
  ];
  const results = { "p/w": "ok", "p/bad": "error" };

  it("auto-add defaults to OFF with working-only policy (pinned above)", () => {
    const s = normalizeSyncSettings(null);
    assert.equal(s.autoAdd, false);
    assert.equal(s.autoAddPolicy, "working-only");
    assert.equal(s.includeUntested, false);
  });

  it("every policy leaves added models and disabled models alone", () => {
    for (const policy of AUTO_ADD_POLICIES) {
      const { toAdd, toDisable } = resolveAutoAdd({
        discoveredRows: rows(),
        testResults: results,
        disabledIds: ["off"],
        policy,
      });
      assert.equal(toAdd.includes("added"), false, `${policy} must not re-add an existing model`);
      assert.equal(toAdd.includes("off"), false, `${policy} must not touch a disabled model`);
      assert.equal(toDisable.includes("off"), false, `${policy} must not re-disable`);
    }
  });

  it("working-only: adds working, leaves failed+untested in catalog", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: rows(),
      testResults: results,
      disabledIds: ["off"],
      policy: "working-only",
    });
    assert.deepEqual(toAdd, ["w"]);
    assert.deepEqual(toDisable, []);
  });

  it("working-disable-failed: adds working, disables failed", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: rows(),
      testResults: results,
      disabledIds: ["off"],
      policy: "working-disable-failed",
    });
    assert.deepEqual(toAdd, ["w"]);
    assert.deepEqual(toDisable, ["bad"]);
  });

  it("working-untested: adds working AND untested, disables failed", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: rows(),
      testResults: results,
      disabledIds: ["off"],
      policy: "working-untested",
    });
    assert.deepEqual(toAdd.sort(), ["newbie", "w"]);
    assert.deepEqual(toDisable, ["bad"]);
  });

  it("the legacy 'working-ignore-failed' id still resolves (settings compat)", () => {
    assert.equal(normalizeAutoAddPolicy("working-ignore-failed"), "working-only");
    // ...and is not offered as its own option, because it duplicates
    // working-only exactly.
    assert.equal(AUTO_ADD_POLICIES.includes("working-ignore-failed"), false);
  });

  it("all: adds every eligible model whatever its status", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: rows(),
      testResults: results,
      disabledIds: ["off"],
      policy: "all",
    });
    assert.deepEqual(toAdd.sort(), ["bad", "newbie", "w"]);
    assert.deepEqual(toDisable, []);
  });

  it("every policy yields a distinct outcome (no ambiguous duplicates)", () => {
    const base = { discoveredRows: rows(), testResults: results, disabledIds: [] };
    const outcomes = AUTO_ADD_POLICIES.map(
      (p) => JSON.stringify(resolveAutoAdd({ ...base, policy: p }))
    );
    assert.equal(new Set(outcomes).size, AUTO_ADD_POLICIES.length);
  });

  it("includeUntested is opt-in and off by default", () => {
    const base = { discoveredRows: rows(), testResults: results, disabledIds: [], policy: "working-only" };
    assert.deepEqual(resolveAutoAdd(base).toAdd, ["w"]);
    assert.deepEqual(resolveAutoAdd({ ...base, includeUntested: true }).toAdd.sort(), ["newbie", "off", "w"]);
  });

  it("never re-enables disabled models, never adds them", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: [{ id: "off", fullModel: "p/off" }],
      testResults: { "p/off": "ok" }, // passes now, but still disabled
      disabledIds: ["off"],
      policy: "working-disable-failed",
    });
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toDisable, []);
  });

  it("failed-then-passing model is picked up on the next run", () => {
    const first = resolveAutoAdd({
      discoveredRows: [{ id: "m", fullModel: "p/m" }],
      testResults: { "p/m": "error" },
      disabledIds: [],
      policy: "working-disable-failed",
    });
    assert.deepEqual(first.toAdd, []);
    assert.deepEqual(first.toDisable, ["m"]);
    const second = resolveAutoAdd({
      discoveredRows: [{ id: "m", fullModel: "p/m" }],
      testResults: { "p/m": "passed" },
      disabledIds: [],
      policy: "working-disable-failed",
    });
    assert.deepEqual(second.toAdd, ["m"]);
    assert.deepEqual(second.toDisable, []);
  });

  it("empty catalog resolves to nothing (sync failure deletes nothing)", () => {
    const { toAdd, toDisable } = resolveAutoAdd({ discoveredRows: [], testResults: {}, disabledIds: [], policy: "all" });
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toDisable, []);
    assert.deepEqual(resolveBulkAdd([]), { targets: [], skipped: [] });
  });

  it("includeUntested stays opt-in for the working-only policy", () => {
    // disabledIds deliberately empty so the untested-but-enabled rows are
    // visible in the diff.
    const base = { discoveredRows: rows(), testResults: results, disabledIds: [], policy: "working-only" };
    assert.deepEqual(resolveAutoAdd(base).toAdd, ["w"]);
    assert.deepEqual(
      resolveAutoAdd({ ...base, includeUntested: true }).toAdd.sort(),
      ["newbie", "off", "w"]
    );
  });

  it("normalizeSyncSettings defaults to OFF with the safest policy", () => {
    const s = normalizeSyncSettings(null);
    assert.equal(s.autoAdd, false);
    assert.equal(s.autoAddPolicy, "working-only");
    assert.equal(s.includeUntested, false);
    assert.ok(AUTO_ADD_POLICIES.includes(s.autoAddPolicy));
  });

  it("unknown policies fall back safely", () => {
    assert.equal(normalizeAutoAddPolicy("nope"), "working-only");
    assert.ok(AUTO_ADD_POLICIES.includes("working-only"));
    const { toAdd } = resolveAutoAdd({
      discoveredRows: [{ id: "w", fullModel: "p/w" }],
      testResults: { "p/w": "ok" },
      policy: "nope",
    });
    assert.deepEqual(toAdd, ["w"]);
  });
});

describe("settings persistence", () => {
  it("normalizeSyncSettings preserves lastSyncAt and drops unknown fields", () => {
    const out = normalizeSyncSettings({
      autoFetch: true,
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      autoAdd: true,
      autoAddPolicy: "working-disable-failed",
      includeUntested: true,
      bogus: 1,
    });
    assert.equal(out.autoFetch, true);
    assert.equal(out.lastSyncAt, "2026-01-01T00:00:00.000Z");
    assert.equal(out.autoAdd, true);
    assert.equal(out.autoAddPolicy, "working-disable-failed");
    assert.equal(out.includeUntested, true);
    assert.ok(!("bogus" in out));
  });

  it("legacy records upgrade with safe defaults and survive a JSON round-trip (kv storage)", () => {
    const legacy = { autoFetch: true, autoSync: true, lastSyncAt: null };
    const out = normalizeSyncSettings(JSON.parse(JSON.stringify(legacy)));
    assert.equal(out.autoFetch, true);
    assert.equal(out.autoAdd, false);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  });
});

describe("shared behavior across providers", () => {
  const cases = [
    ["openai-compatible-b3b2c1a4-uuid-here", "gpt-4o-mini"],
    ["anthropic-compatible-9f8e7d6c-uuid-here", "claude-3-opus"],
    ["qoder", "qoder/auto"],
    ["nvidia", "nvidia/ising-x"],
    ["opencode", "qwen3-coder-free"],
  ];
  for (const [storageAlias, id] of cases) {
    it(`partitions + auto-adds for ${storageAlias}`, () => {
      const part = partitionDiscovered({
        catalog: [{ id }, { id: "other" }],
        storageAlias,
        addedFullModels: {},
        hardcodedIds: [],
      });
      assert.equal(part.discovered.length, 2);
      assert.ok(part.discovered.every((r) => r.fullModel.startsWith(`${storageAlias}/`)));
      const { toAdd } = resolveAutoAdd({
        discoveredRows: part.discovered,
        testResults: { [`${storageAlias}/${id}`]: "passed" },
        disabledIds: [],
        policy: "working-only",
      });
      assert.deepEqual(toAdd, [id]);
    });
  }
});

describe("bulk scale (UI stays responsive)", () => {
  it("resolves 5000 discovered ids without loss", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `model-${i}` }));
    const { discovered } = partitionDiscovered({
      catalog: big,
      storageAlias: "p",
      addedFullModels: {},
      hardcodedIds: [],
    });
    const { targets, skipped } = resolveBulkAdd(discovered);
    assert.equal(targets.length, 5000);
    assert.equal(skipped.length, 0);
  });
});
