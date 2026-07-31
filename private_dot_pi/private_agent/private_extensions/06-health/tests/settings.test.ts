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
