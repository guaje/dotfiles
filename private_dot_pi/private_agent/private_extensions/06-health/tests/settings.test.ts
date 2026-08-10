import assert from "node:assert/strict";
import test from "node:test";
import policy from "../assets/policy.json" with { type: "json" };
import { resolveModelHealthSettings } from "../settings.ts";

test("Health settings resolve valid configured policy", () => {
  assert.deepEqual(resolveModelHealthSettings({ modelHealthCacheTtlMs: 60_000, modelHealthProbeConcurrency: 5 }), { cacheTtlMs: 60_000, concurrency: 5 });
});

test("Health settings reject values outside machine-readable bounds", () => {
  assert.deepEqual(resolveModelHealthSettings({ modelHealthCacheTtlMs: 1, modelHealthProbeConcurrency: 100 }), { cacheTtlMs: policy.cacheTtlMs.default, concurrency: policy.probeConcurrency.default });
});

test("Health settings prefer nested health.* over flat legacy keys", () => {
  assert.deepEqual(
    resolveModelHealthSettings({ health: { cacheTtlMs: 120_000, probeConcurrency: 2 }, modelHealthCacheTtlMs: 30_000, modelHealthProbeConcurrency: 7 }),
    { cacheTtlMs: 120_000, concurrency: 2 },
  );
});

test("Health settings fall back to flat legacy when nested is invalid", () => {
  assert.deepEqual(
    resolveModelHealthSettings({ health: { cacheTtlMs: "NaN", probeConcurrency: "NaN" }, modelHealthCacheTtlMs: 45_000, modelHealthProbeConcurrency: 4 }),
    { cacheTtlMs: 45_000, concurrency: 4 },
  );
});

test("Health settings resolve with nested only keys", () => {
  assert.deepEqual(
    resolveModelHealthSettings({ health: { cacheTtlMs: 180_000, probeConcurrency: 6 } }),
    { cacheTtlMs: 180_000, concurrency: 6 },
  );
});
