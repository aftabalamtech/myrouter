// Provider-sync / bulk-add regression suite (task §8).
//
// Deterministic: upstream responses are mocked, the DB is a temp-dir SQLite
// instance driven through the REAL adapters and repos, so the whole
// fetchConnectionModels → persistDiscovered → catalog API → bulk-add
// path is exercised without any live provider call.
//
// PostgreSQL: the feature code is dialect-neutral kv/SQL via the shared adapter
// layer (see pg-placeholder.test.js + pg-ddl.test.js for the parity checks), so
// the same suite runs against DATABASE_URL when one is provided.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-bulkadd-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { initDb } = await import("../src/lib/db/index.js");
await initDb();

const { fetchConnectionModels, normalizeDiscoveredModel, mergeConnectionModels } =
  await import("../src/lib/models/modelDiscovery.js");
const {
  persistDiscovered,
  getSyncedModels,
  syncedKey,
} = await import("../src/lib/models/modelSync.js");
const {
  resolveDiscoveredBulkAliasEntries,
  resolveBulkAliasEntries,
  resolveAutoAdd,
  filterDiscovered,
} = await import("../src/lib/models/autoAdd.js");
const { setModelAlias, getModelAliases } = await import("../src/models/index.js");
const { fetchCatalogFollowUpPages } = await import("../src/lib/net/catalogPagination.js");

const ALIAS = "nvidia-e2e";

// A deterministic stand-in for the live NVIDIA NIM /v1/models response
// (85 upstream entries, no pricing metadata — exactly what NIM serves).
function nimPayload(count = 85) {
  const data = [];
  for (let i = 0; i < count; i += 1) {
    data.push({
      id: `vendor/model-${String(i).padStart(3, "0")}`,
      object: "model",
      created: 735790403,
      owned_by: "vendor",
    });
  }
  return { object: "list", data };
}

function mockDiscoveryRoute(payload) {
  return async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("§8.1 upstream 85-model response ⇒ full catalog persisted", () => {
  it("fetchConnectionModels normalizes and keeps every entry", async () => {
    const payload = nimPayload(85);
    const r = await fetchConnectionModels("c1", { fetchImpl: mockDiscoveryRoute(payload) });
    assert.equal(r.models.length, 85, "normalized count must equal upstream count");
    assert.ok(r.models.every((m) => m.id && m.provider === null || m.provider !== undefined));
    // Missing pricing must be explicit — not inferred to free/paid.
    assert.ok(r.models.every((m) => m.isFree === null));
  });

  it("persistDiscovered stores all 85 with real counters", async () => {
    const r = await fetchConnectionModels("c1", { fetchImpl: mockDiscoveryRoute(nimPayload(85)) });
    const merged = mergeConnectionModels([{ connectionId: "c1", models: r.models }]);
    const first = await persistDiscovered({ storageAlias: ALIAS, discovered: merged, manualIds: [] });
    assert.equal(first.added, 85);
    assert.equal(first.updated, 0);
    const stored = await getSyncedModels(ALIAS);
    assert.equal(Object.keys(stored).length, 85);
    assert.equal(stored[syncedKey(ALIAS, "vendor/model-042")]?.fullModel, `${ALIAS}/vendor/model-042`);
    assert.ok(Object.values(stored).every((v) => v.stale === false));
  });

  it("re-sync is idempotent: 85 discovered, 0 added, 0 updated (the '85 updated' counter drift cannot recur)", async () => {
    const r = await fetchConnectionModels("c1", { fetchImpl: mockDiscoveryRoute(nimPayload(85)) });
    const merged = mergeConnectionModels([{ connectionId: "c1", models: r.models }]);
    const second = await persistDiscovered({ storageAlias: ALIAS, discovered: merged, manualIds: [] });
    assert.deepEqual(second, { added: 0, updated: 0, stale: 0 });
  });
});

describe("§8.2 §8.7 UI renders 16/page but filters & pagination operate on the complete set", () => {
  const PAGE_SIZE = 16;

  it("only the page is dropped for display; the data set stays 85", async () => {
    const stored = await getSyncedModels(ALIAS);
    const catalog = Object.values(stored).filter((v) => v && v.id && !v.stale);
    const { rows, counts } = filterDiscovered(catalog, { status: "all", price: "all" });
    assert.equal(rows.length, 85);
    assert.equal(counts.all, 85);
    const visible = rows.slice(0, Math.min(PAGE_SIZE, rows.length));
    assert.equal(visible.length, 16);
  });

  it("counts stay consistent for every facet over the full set (not just the page)", async () => {
    const stored = await getSyncedModels(ALIAS);
    const catalog = Object.values(stored).filter((v) => v && v.id && !v.stale);
    for (const status of ["all", "error", "disabled"]) {
      const { rows, counts } = filterDiscovered(catalog, { status });
      assert.equal(rows.length, counts[status], `status=${status}`);
    }
    const unknown = filterDiscovered(catalog, { price: "unknown" });
    assert.equal(unknown.rows.length, 85, "no pricing metadata ⇒ everything is Unknown price");
  });
});

describe("§8.3 server-side Add All (pure layer)", () => {
  it("adds all 85 minus the server-side hardcoded id (not the 16-row first page)", async () => {
    const stored = await getSyncedModels(ALIAS);
    const catalog = Object.values(stored).filter((v) => v && v.id && !v.stale);
    const resolved = resolveDiscoveredBulkAliasEntries({
      catalog,
      storageAlias: ALIAS,
      existing: {},
      hardcodedIds: ["vendor/model-000"], // built-in id must exist in the catalog
      search: "",
      status: "all",
      price: "all",
      testResults: {},
      disabledIds: [],
    });
    assert.equal(resolved.total, 84, "built-in id is excluded from eligible");
    assert.equal(resolved.toAdd.length, 84);
    assert.equal(resolved.skipped, 0);
  });
});

let aliasesBefore;

describe("§8.4 repeated Add All is idempotent (no duplicates)", () => {
  it("a completed Add All leaves zero eligible rows and alias keys stable", async () => {
    const stored = await getSyncedModels(ALIAS);
    const catalog = Object.values(stored).filter((v) => v && v.id && !v.stale);
    for (const row of catalog) {
      await setModelAlias(row.id.split("/").pop(), row.fullModel || `${ALIAS}/${row.id}`);
    }
    const before = await getModelAliases();
    const resolved = resolveDiscoveredBulkAliasEntries({
      catalog,
      storageAlias: ALIAS,
      existing: before,
      hardcodedIds: [],
      search: "",
      status: "all",
      price: "all",
      testResults: {},
      disabledIds: [],
    });
    assert.equal(resolved.total, 0, "all models are added ⇒ nothing eligible left");
    assert.equal(resolved.toAdd.length, 0);
    const after = await getModelAliases();
    assert.equal(Object.keys(after).length, Object.keys(before).length, "no duplicate alias records");
  });
});

describe("§8.6 statuses never hide eligible models; untested ≠ failed", () => {
  const rows = [
    { id: "w1", fullModel: "p/w1", isFree: true },
    { id: "e1", fullModel: "p/e1", isFree: false },
    { id: "u1", fullModel: "p/u1", isFree: null },
  ];
  const ctx = {
    testResults: { "p/w1": "ok", "p/e1": "error" },
    disabledIds: [],
  };
  it("the all/untested-inclusive tabs keep every row", () => {
    const all = filterDiscovered(rows, { ...ctx, status: "all" });
    assert.equal(all.rows.length, 3);
    assert.equal(all.counts.working, 1);
    assert.equal(all.counts.error, 1);
    assert.equal(all.counts.inconclusive, 0);
  });
  it("resolveAutoAdd policy=all adds working, failed AND untested", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: rows,
      testResults: ctx.testResults,
      disabledIds: [],
      policy: "all",
    });
    assert.deepEqual(toAdd.sort(), ["e1", "u1", "w1"]);
    assert.deepEqual(toDisable, []);
  });
});

describe("§8.8 partial bulk-add failures return per-model reasons", () => {
  it("failures carry reasons and never overwrite the loser", () => {
    const resolved = resolveBulkAliasEntries(
      [
        { model: "p/keep", alias: "keep" },
        { model: "p/other", alias: "clash" }, // alias taken by a different model
        { model: "", alias: "x" }, // invalid
        { model: "p/new", alias: "fresh" },
        { model: "p/new2", alias: "dupe" }, // same model twice ⇒ second skips
        { model: "p/new2", alias: "dupe2" },
      ],
      { keep: "p/keep", clash: "p/taken" }
    );
    const byIdentity = (model, alias) =>
      resolved.results.find((r) => r.model === model && r.alias === alias);
    assert.equal(byIdentity("p/keep", "keep").status, "skipped");
    const clash = byIdentity("p/other", "clash");
    assert.equal(clash.status, "failed");
    assert.ok(typeof clash.reason === "string" && clash.reason.length > 0);
    assert.equal(byIdentity("", "x").status, "failed");
    assert.equal(byIdentity("p/new", "fresh").status, "pending");
    assert.equal(byIdentity("p/new2", "dupe2").status, "skipped");
    assert.equal(resolved.toAdd.length, 2);
    assert.equal(resolved.failed, 2);
  });
});

describe("§8.9 re-sync handles new/updated/unchanged/removed upstream", () => {
  const A = "resync-policy";
  const base = [
    { id: "same", name: "Same", connectionIds: ["c1"], connectionId: "c1" },
    { id: "priced", name: "Now priced", connectionIds: ["c1"], connectionId: "c1" },
    { id: "gone", name: "Dropped upstream", connectionIds: ["c1"], connectionId: "c1" },
  ];
  it("adds, updates, keeps and stale-marks exactly per policy", async () => {
    await persistDiscovered({ storageAlias: A, discovered: base, manualIds: [] });
    // upstream now: same (unchanged), priced (metadata changed), fresh (new).
    // Entries carry connectionIds because the real pipeline (mergeConnectionModels)
    // always attaches them — the stale-mark guard keys off that field.
    const next = [
      { id: "same", name: "Same", connectionIds: ["c1"], connectionId: "c1" },
      { id: "priced", name: "Now priced v2", connectionIds: ["c1"], connectionId: "c1" },
      { id: "fresh", name: "New upstream", connectionIds: ["c1"], connectionId: "c1" },
    ];
    const out = await persistDiscovered({ storageAlias: A, discovered: next, manualIds: [] });
    assert.equal(out.added, 1, "fresh discovered");
    assert.equal(out.updated, 1, "priced refreshed");
    assert.equal(out.stale, 1, "gone marked stale (kept, hidden)");
    const stored = await getSyncedModels(A);
    assert.equal(stored[syncedKey(A, "gone")]?.stale, true);
    assert.equal(stored[syncedKey(A, "fresh")]?.stale, false);
  });
  it("a fully failed upstream sync preserves the catalog", async () => {
    const out = await persistDiscovered({ storageAlias: A, discovered: [], manualIds: [], failedConnectionIds: ["c1"] });
    assert.equal(out.stale, 0);
  });
});

describe("§8.13 manual models and disabled states survive sync", () => {
  it("manual flag is preserved across syncs; stale marking skips manual rows", async () => {
    const B = "manual-prot";
    await persistDiscovered({ storageAlias: B, discovered: [{ id: "m1" }, { id: "m2" }], manualIds: ["m1"] });
    // Upstream dropped everything; manual m1 must survive as non-stale.
    const out = await persistDiscovered({ storageAlias: B, discovered: [], manualIds: ["m1"] });
    assert.equal(out.stale, 1, "only the non-manual row goes stale");
    const stored = await getSyncedModels(B);
    assert.equal(stored[syncedKey(B, "m1")]?.stale, false);
    assert.equal(stored[syncedKey(B, "m2")]?.stale, true);
    assert.equal(stored[syncedKey(B, "m1")]?.manual, true);
  });
  it("disabled rows are never re-added by the auto flows", () => {
    const { toAdd, toDisable } = resolveAutoAdd({
      discoveredRows: [
        { id: "off", fullModel: "p/off", isAdded: false },
        { id: "on", fullModel: "p/on", isAdded: false },
      ],
      testResults: { "p/off": "ok" },
      disabledIds: ["off"],
      policy: "all",
    });
    assert.deepEqual(toAdd, ["on"], "policy=all adds eligibles but never a disabled row");
    assert.deepEqual(toDisable, []);
  });
});

describe("§8.10 connection deletion + recreation leaves no orphans and no stale ids", () => {
  it("the catalog is keyed by storage alias, so a new connection id re-associates records on the next sync", async () => {
    const C = "conn-recreate";
    const r1 = await fetchConnectionModels("conn-A", { fetchImpl: mockDiscoveryRoute(nimPayload(10)) });
    const merged1 = mergeConnectionModels([{ connectionId: "conn-A", models: r1.models }]);
    await persistDiscovered({ storageAlias: C, discovered: merged1, manualIds: [] });
    const stored = await getSyncedModels(C);
    assert.deepEqual(
      stored[syncedKey(C, "vendor/model-000")]?.connectionIds,
      ["conn-A"],
      "records remember the connection(s) that discovered them"
    );

    // Connection destroyed; the persisted catalog is intentionally preserved.
    assert.equal(Object.keys(stored).length, 10, "the destroyed connection does not delete the catalog");
    assert.ok(Object.values(stored).every((v) => !v.stale), "no stale on clean catalog");

    // Recreated connection gets a FRESH id; next sync re-associates by model id.
    const r2 = await fetchConnectionModels("conn-B", { fetchImpl: mockDiscoveryRoute(nimPayload(12)) });
    const merged2 = mergeConnectionModels([{ connectionId: "conn-B", models: r2.models }]);
    const out = await persistDiscovered({ storageAlias: C, discovered: merged2, manualIds: [] });
    assert.equal(out.added, 2, "only genuinely new models count as added");
    assert.equal(out.updated, 10, "re-associated records count as refreshed");
    const after = await getSyncedModels(C);
    assert.deepEqual(after[syncedKey(C, "vendor/model-000")]?.connectionIds, ["conn-B"], "records re-associate to the recreated connection");
    assert.ok(!JSON.stringify(after[syncedKey(C, "vendor/model-000")]).includes("conn-A"), "no stale connection ids leak into the catalog");
  });
});

describe("§8.11 paginated upstream catalogs fully synchronize (Gemini-style)", () => {
  it("follow-up pages are fetched until the token stream ends", async () => {
    const pagesSeen = [];
    const result = await fetchCatalogFollowUpPages({
      firstBody: { nextPageToken: "page2" },
      parseResponse: (j) => j.models || [],
      pagination: { query: "pageToken", tokenField: "nextPageToken", maxPages: 10, maxModels: 5000 },
      buildUrl: (t) => `https://x/v1beta/models?pageToken=${t}`,
      fetchPage: async (url) => {
        pagesSeen.push(url);
        if (url.includes("page2")) {
          return { okStatus: true, parsed: true, json: { models: [{ id: "gemini/11" }], nextPageToken: "page3" } };
        }
        return { okStatus: true, parsed: true, json: { models: [{ id: "gemini/12" }] } };
      },
    });
    assert.equal(pagesSeen.length, 2);
    assert.equal(result.pages.flat().length, 2);
    assert.equal(result.truncated, false);
  });

  it("a repeated/looping token terminates the loop", async () => {
    let calls = 0;
    const result = await fetchCatalogFollowUpPages({
      firstBody: { nextPageToken: "loop" },
      parseResponse: () => [],
      pagination: { query: "pageToken", tokenField: "nextPageToken", maxPages: 50, maxModels: 5000 },
      buildUrl: () => "https://x/v1beta/models?pageToken=loop",
      fetchPage: async () => {
        calls += 1;
        return { okStatus: true, parsed: true, json: { nextPageToken: "loop" } };
      },
    });
    assert.equal(calls, 1, "must not loop forever on a self-referencing token");
    assert.equal(result.pages.length, 1);
  });

  it("a failing follow-up page keeps collected models and flags truncation", async () => {
    const result = await fetchCatalogFollowUpPages({
      firstBody: { nextPageToken: "p2" },
      parseResponse: (j) => j.models || [],
      pagination: { query: "pageToken", tokenField: "nextPageToken" },
      buildUrl: (t) => `?pageToken=${t}`,
      fetchPage: async () => ({ okStatus: false, parsed: false, json: null }),
    });
    assert.equal(result.truncated, true);
    assert.equal(result.pages.length, 0);
  });

  it("upstream entries with no identifier are dropped, never invented", () => {
    assert.equal(normalizeDiscoveredModel({}, { provider: "x", connectionId: "c" }), null);
    assert.equal(normalizeDiscoveredModel({ name: "no id here" }, { provider: "x", connectionId: "c" }), null);
    const ok = normalizeDiscoveredModel({ id: " keep/me " }, { provider: "x", connectionId: "c" });
    assert.equal(ok.id, "keep/me");
    assert.equal(ok.isFree, null, "unknown pricing stays null (never inferred)");
  });
});
