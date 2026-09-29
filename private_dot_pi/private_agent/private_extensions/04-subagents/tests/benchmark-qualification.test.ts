import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SNAPSHOT_ROOT, loadBenchmarkAssets } from "../benchmark-assets.ts";
import { qualifyBenchmarkProfiles, ROUTING_PROFILES } from "../benchmark-qualification.ts";

test("benchmark qualification reports every profile without depending on health", async () => {
  const assets = await loadBenchmarkAssets(DEFAULT_SNAPSHOT_ROOT, 31_536_000_000);
  assert.ok(assets);
  const snapshot = assets.snapshots.find((entry) => entry.provider === "qwen" && entry.model === "qwen3.8-27b" && entry.thinkingLevel === "off");
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

const substituteSnapshot = (scores: Record<string, number | null>, subBenchmarks?: Record<string, number | null>) => ({
  version: 4 as const, methodologyVersion: "4.3", modelId: "substitute-model", thinkingLevel: "generic" as const,
  provider: "test", model: "substitute", sourceUrl: "https://artificialanalysis.ai/models/test",
  retrievedAt: Date.now(), publishedAt: Date.now(),
  scores: { intelligence: 50, coding: 40, agentic: 40, toolUse: 30, scientificReasoning: null, longContext: 40, instructionFollowing: null, knowledge: 40, faithfulness: 90, ...scores },
  tools: null, costs: null, ...(subBenchmarks ? { subBenchmarks } : {}),
});
const retiredFields = (overrides: Record<string, string> = {}) => {
  const entry = (status: string) => ({ status, checked: 15, scored: status === "active" ? 15 : 0, oldestScoredRelease: "2026-01-01", newestScoredRelease: status === "active" ? "2026-09-01" : "2026-07-09", sources: [] });
  return { ifbench: entry(overrides.ifbench ?? "retired"), gpqa: entry(overrides.gpqa ?? "retired"), hle: entry(overrides.hle ?? "active"), critpt: entry(overrides.critpt ?? "active") } as never;
};
const capable = { input: ["text"], contextWindow: 262_144, maxTokens: 65_536 };

test("retired-benchmark fallbacks qualify planning only with reviewed floors and retirement proof", () => {
  const snapshot = substituteSnapshot({}, { ifbench: null, hle: 30, gpqa: null, critpt: 20 });
  const profiles = qualifyBenchmarkProfiles(capable, snapshot, retiredFields());
  const planning = profiles.find((entry) => entry.profile === "planning")!;
  assert.equal(planning.qualified, true);
  assert.deepEqual(planning.substitutions?.map((entry) => `${entry.dimension}=${entry.source}`).sort(), ["instructionFollowing=subBenchmark:critpt", "scientificReasoning=subBenchmark:hle+critpt"]);
  assert.equal(profiles.find((entry) => entry.profile === "research")!.qualified, true);
  assert.deepEqual(profiles.find((entry) => entry.profile === "research")!.substitutions?.map((entry) => entry.dimension), ["scientificReasoning"]);
  assert.equal(profiles.find((entry) => entry.profile === "review")!.qualified, true);
  assert.deepEqual(profiles.find((entry) => entry.profile === "review")!.substitutions?.map((entry) => entry.dimension), ["instructionFollowing"]);
  // The substituted dimensions count toward coverage at full weight.
  const planningQuality = qualifyBenchmarkProfiles(capable, snapshot, retiredFields()).find((entry) => entry.profile === "planning")!;
  assert.ok(planningQuality.qualified && planningQuality.substitutions?.length === 2);
});

test("fallback substitutions fail closed on source floors, active fields, and missing data", () => {
  // CRITPT 9 is below the reviewed instructionFollowing floor of 10.
  const weak = substituteSnapshot({}, { ifbench: null, hle: null, gpqa: null, critpt: 9 });
  assert.equal(qualifyBenchmarkProfiles(capable, weak, retiredFields()).find((entry) => entry.profile === "planning")!.reason, "missingRequiredDimension");
  // mean(hle 30, critpt 11) = 20.5 is below the reviewed scientificReasoning floor of 25.
  const weakScience = substituteSnapshot({}, { ifbench: null, hle: 30, gpqa: null, critpt: 11 });
  assert.equal(qualifyBenchmarkProfiles(capable, weakScience, retiredFields()).find((entry) => entry.profile === "planning")!.reason, "missingRequiredDimension");
  // An active primary field never enables substitution, no matter the substituted values.
  const active = substituteSnapshot({}, { ifbench: null, hle: 100, gpqa: null, critpt: 100 });
  assert.equal(qualifyBenchmarkProfiles(capable, active, retiredFields({ ifbench: "active", gpqa: "active" })).find((entry) => entry.profile === "planning")!.reason, "missingRequiredDimension");
  // No health artifact means today's fail-closed behavior even with rich sub-benchmark data.
  assert.equal(qualifyBenchmarkProfiles(capable, active).find((entry) => entry.profile === "planning")!.reason, "missingRequiredDimension");
  // Missing sub-benchmark component values block the mean.
  const partial = substituteSnapshot({}, { ifbench: null, hle: null, gpqa: null, critpt: 40 });
  assert.equal(qualifyBenchmarkProfiles(capable, partial, retiredFields()).find((entry) => entry.profile === "planning")!.reason, "missingRequiredDimension");
});

test("primary benchmark scores always win over retired fallbacks", () => {
  const snapshot = substituteSnapshot({ instructionFollowing: 50 }, { ifbench: null, hle: null, gpqa: null, critpt: 40 });
  const review = qualifyBenchmarkProfiles(capable, snapshot, retiredFields()).find((entry) => entry.profile === "review")!;
  assert.equal(review.qualified, true);
  assert.equal(review.substitutions, undefined);
});
