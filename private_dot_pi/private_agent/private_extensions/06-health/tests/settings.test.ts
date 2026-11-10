import assert from "node:assert/strict";
import test from "node:test";
import policy from "../assets/policy.json" with { type: "json" };
import { resolveModelHealthSettings } from "../settings.ts";

test("Health settings resolve valid configured policy", () => {
  assert.deepEqual(
    resolveModelHealthSettings({ modelHealthCacheTtlMs: 60_000, modelHealthProbeConcurrency: 5, modelHealthProbeTimeoutMs: 45_000 }),
    { cacheTtlMs: 60_000, concurrency: 5, probeTimeoutMs: 45_000, probeEscalation: policy.probeEscalation.default },
  );
});

test("Health settings reject values outside machine-readable bounds", () => {
  assert.deepEqual(
    resolveModelHealthSettings({ modelHealthCacheTtlMs: 1, modelHealthProbeConcurrency: 100, modelHealthProbeTimeoutMs: policy.probeTimeoutMs.maximum + 1 }),
    { cacheTtlMs: policy.cacheTtlMs.default, concurrency: policy.probeConcurrency.default, probeTimeoutMs: policy.probeTimeoutMs.default, probeEscalation: policy.probeEscalation.default },
  );
});

test("Health settings prefer nested health.* over flat legacy keys", () => {
  assert.deepEqual(
    resolveModelHealthSettings({
      health: { cacheTtlMs: 120_000, probeConcurrency: 2, probeTimeoutMs: 30_000, probeEscalation: false },
      modelHealthCacheTtlMs: 30_000,
      modelHealthProbeConcurrency: 7,
      modelHealthProbeTimeoutMs: 90_000,
      modelHealthProbeEscalation: true,
    }),
    { cacheTtlMs: 120_000, concurrency: 2, probeTimeoutMs: 30_000, probeEscalation: false },
  );
});

test("Health settings fall back to flat legacy when nested is invalid", () => {
  assert.deepEqual(
    resolveModelHealthSettings({
      health: { cacheTtlMs: "NaN", probeConcurrency: "NaN", probeTimeoutMs: 0, probeEscalation: "yes" },
      modelHealthCacheTtlMs: 45_000,
      modelHealthProbeConcurrency: 4,
      modelHealthProbeEscalation: false,
    }),
    { cacheTtlMs: 45_000, concurrency: 4, probeTimeoutMs: policy.probeTimeoutMs.default, probeEscalation: false },
  );
});

test("Health settings resolve with nested only keys", () => {
  assert.deepEqual(
    resolveModelHealthSettings({ health: { cacheTtlMs: 180_000, probeConcurrency: 6 } }),
    { cacheTtlMs: 180_000, concurrency: 6, probeTimeoutMs: policy.probeTimeoutMs.default, probeEscalation: policy.probeEscalation.default },
  );
});

test("Health settings clamp a configured probe ceiling into policy bounds", () => {
  assert.equal(resolveModelHealthSettings({ health: { probeTimeoutMs: 5_000 } }).probeTimeoutMs, 5_000);
  assert.equal(resolveModelHealthSettings({ health: { probeTimeoutMs: 999 } }).probeTimeoutMs, policy.probeTimeoutMs.default);
  assert.equal(resolveModelHealthSettings({}).probeTimeoutMs, policy.probeTimeoutMs.default);
});

test("Health settings resolve the probe escalation switch", () => {
  assert.equal(resolveModelHealthSettings({}).probeEscalation, true, "on by policy default");
  assert.equal(resolveModelHealthSettings({ health: { probeEscalation: false } }).probeEscalation, false);
  assert.equal(resolveModelHealthSettings({ modelHealthProbeEscalation: false }).probeEscalation, false, "flat legacy key");
  assert.equal(resolveModelHealthSettings({ health: { probeEscalation: "never" } }).probeEscalation, true, "a non-boolean cannot flip it");
});
