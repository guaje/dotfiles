import assert from "node:assert/strict";
import test from "node:test";
import { calculateUsageCostBreakdown, extractStats, mergeCatalogCostRates } from "../index.ts";

test("recorded provider charges are retained over later catalog rates", () => {
  const cost = calculateUsageCostBreakdown({ input: 100, output: 20, cost: { total: 7.5 } }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost.total, 7.5);
});

test("unknown catalog prices remove Pi's required zero-cost placeholder from totals", () => {
  const rates = new Map([["private/unknown", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]]);
  mergeCatalogCostRates(rates, { providers: [{ models: [{ canonicalId: "private/unknown" }] }] });
  assert.equal(rates.has("private/unknown"), false);
  const summary = extractStats([{ type: "message", message: { role: "assistant", provider: "private", model: "unknown", usage: { input: 1_000_000, output: 1_000_000 } } }], rates);
  assert.equal(summary.main[0]?.cost, 0);
  assert.equal(summary.hasNotionalCost, false);
  assert.deepEqual(summary.unpricedModels, ["private/unknown"]);
});

test("native login observations provide resolved pricing without reading auth.json", () => {
  const rates = new Map<string, any>();
  mergeCatalogCostRates(rates, { providers: [], nativeModels: [{ id: "login/native", cost: { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 } }] });
  assert.deepEqual(rates.get("login/native"), { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 });
});

test("historical bare ids resolve only when unique", () => {
  const rates = new Map([
    ["one/shared", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
    ["two/shared", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
  ]);
  const summary = extractStats([{ type: "message", message: { role: "assistant", model: "shared", usage: { input: 100 } } }], rates);
  assert.equal(summary.main[0]?.model, "shared");
  assert.equal(summary.hasNotionalCost, false);
  assert.deepEqual(summary.unpricedModels, ["shared"]);
});
