import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SNAPSHOT_ROOT, loadBenchmarkAssets } from "../benchmark-assets.ts";
import { qualifyBenchmarkProfiles, ROUTING_PROFILES } from "../benchmark-qualification.ts";

test("benchmark qualification reports every profile without depending on health", async () => {
  const assets = await loadBenchmarkAssets(DEFAULT_SNAPSHOT_ROOT, 31_536_000_000);
  assert.ok(assets);
  const snapshot = assets.snapshots.find((entry) => entry.modelId === "8d0cb231-7303-452c-9923-a9620b948475");
  assert.ok(snapshot);
  const results = qualifyBenchmarkProfiles({ input: ["text", "image"], contextWindow: 131_072, maxTokens: 163_840 }, snapshot);
  assert.deepEqual(results.map((entry) => entry.profile), ROUTING_PROFILES);
  assert.ok(results.some((entry) => entry.qualified));
  assert.equal(results.find((entry) => entry.profile === "agentic")?.qualified, false);
  assert.equal(results.find((entry) => entry.profile === "agentic")?.reason, "mandatoryFloor");
});

test("benchmark qualification fails capability gates before benchmark gates", async () => {
  const assets = await loadBenchmarkAssets(DEFAULT_SNAPSHOT_ROOT, 31_536_000_000);
  assert.ok(assets);
  const snapshot = assets.snapshots[0]!;
  const results = qualifyBenchmarkProfiles({ input: [], contextWindow: 1, maxTokens: 1 }, snapshot);
  assert.ok(results.every((entry) => !entry.qualified && entry.reason === "capability"));
});
