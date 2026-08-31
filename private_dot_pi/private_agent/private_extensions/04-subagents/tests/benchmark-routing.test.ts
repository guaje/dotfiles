import assert from "node:assert/strict";
import test from "node:test";
import { routeBenchmarkModel } from "../benchmark-routing.ts";
import { BENCHMARK_DIMENSIONS } from "../benchmark-types.ts";

const methodology = { id: "artificial-analysis-intelligence-index", version: "4.1" };
const snapshot = (model: string, overrides: Record<string, number | null> = {}, output?: number, capturedAt = 100, thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max" | null = null): any => ({
	version: 4,
	provider: "p",
	model,
	thinkingLevel,
	modelId: `aa-${model}-${thinkingLevel ?? "generic"}`,
	capturedAt,
	methodology,
	mapping: { status: "mapped", matchBasis: "manual", reviewedAt: 1, thinkingLevel },
	source: { name: `Synthetic ${model}`, slug: `synthetic-${model}`, openrouterApiId: `p/${model}` },
	publicPage: { url: `https://artificialanalysis.ai/models/synthetic-${model}`, retrievedAt: 100, contentSha256: "a".repeat(64), recordSha256: "b".repeat(64), extractorVersion: "aa-current-model-rsc-v1", intelligenceIndexMethodologyVersion: "4.1.1" },
	scores: { ...Object.fromEntries(BENCHMARK_DIMENSIONS.map((dimension) => [dimension, 60])), ...overrides },
	toolUse: { components: { tau3Banking: null, gdpvalAaNormalized: null, tau2Telecom: { normalizedScore: 60, sourceKind: "api", fieldPath: "evaluations.tau2_telecom", benchmark: { id: "tau2-telecom", version: "test", status: "current" }, retrievedAt: 100, sourceUrl: "https://artificialanalysis.ai/api/v2/language/models", sourceRecordDigest: "c".repeat(64) } }, derivation: { version: "v1", rule: "tau2-telecom-fallback", score: 60 } },
	outputTokens: output === undefined ? {} : { coding: output, balanced: output, agentic: output, research: output, planning: output, review: output, "long-context": output },
	taskTimeMs: {},
	coverage: 1,
});
const candidates = [{ id: "p/a", reasoning: true, input: ["text"] }, { id: "p/b", reasoning: true, input: ["text"] }];
const health = [
	{ id: "p/a", status: "ok", latencyMs: 1000, tokensPerSecond: 10, checkedAt: 100 },
	{ id: "p/b", status: "ok", latencyMs: 100, tokensPerSecond: 100, checkedAt: 100 },
];

test("uses an absolute quality band then the fastest qualifying local endpoint", () => {
	const result = routeBenchmarkModel(
		"coding",
		candidates,
		[snapshot("a", { coding: 90, intelligence: 61 }), snapshot("b", { coding: 89, intelligence: 62 })],
		health,
		"digest",
	)!;
	assert.equal(result.modelId, "p/b");
	assert.equal(result.diagnostics.outputTokensSource, "profile-default");
	assert.equal(result.diagnostics.policyVersion, "4");
});

test("mandatory floors reject weak benchmark candidates", () => {
	const result = routeBenchmarkModel(
		"planning",
		candidates,
		[snapshot("a", { scientificReasoning: 90, instructionFollowing: 90 }), snapshot("b", { scientificReasoning: 20, instructionFollowing: 99 })],
		health,
		"digest",
	)!;
	assert.equal(result.modelId, "p/a");
	assert.equal(result.diagnostics.exclusions.mandatoryFloor, 1);
});

test("Pareto considers both quality and local completion time", () => {
	const result = routeBenchmarkModel(
		"balanced",
		candidates,
		[snapshot("a", {}), snapshot("b", {})],
		[
			{ id: "p/a", status: "ok", latencyMs: 100, tokensPerSecond: 100 },
			{ id: "p/b", status: "ok", latencyMs: 1000, tokensPerSecond: 10 },
		],
		"digest",
	)!;
	assert.equal(result.modelId, "p/a");
	assert.equal(result.diagnostics.exclusions.pareto, 1);
});

test("profile functional constraints reject insufficient context windows", () => {
	const result = routeBenchmarkModel(
		"long-context",
		[{ id: "p/a", input: ["text"], contextWindow: 64_000 }, { id: "p/b", input: ["text"], contextWindow: 256_000 }],
		[snapshot("a", { longContext: 90 }), snapshot("b", { longContext: 90 })],
		health,
		"digest",
	)!;
	assert.equal(result.modelId, "p/b");
	assert.equal(result.diagnostics.exclusions.capability, 1);
});

test("missing local speed fails closed and identity labels have no routing effect", () => {
	const result = routeBenchmarkModel(
		"balanced",
		[{ id: "p/a", reasoning: true, input: ["text"], arbitraryName: "FP8 500B" } as any, { id: "p/b", reasoning: true, input: ["text"], arbitraryName: "tiny flash" } as any],
		[snapshot("a"), snapshot("b")],
		[{ ...health[0], tokensPerSecond: 0 }, { ...health[1], tokensPerSecond: undefined }],
		"digest",
	);
	assert.equal(result.modelId, undefined);
});

test("adding an unrelated low-quality candidate cannot renormalize existing scores", () => {
	const base = routeBenchmarkModel("coding", candidates, [snapshot("a", { coding: 80 }), snapshot("b", { coding: 70 })], health, "digest")!;
	const expanded = routeBenchmarkModel(
		"coding",
		[...candidates, { id: "p/c", input: ["text"] }],
		[snapshot("a", { coding: 80 }), snapshot("b", { coding: 70 }), snapshot("c", Object.fromEntries(BENCHMARK_DIMENSIONS.map((dimension) => [dimension, 1])))],
		[...health, { id: "p/c", status: "ok", latencyMs: 1, tokensPerSecond: 1000 }],
		"digest",
	)!;
	assert.equal(base.modelId, "p/a");
	assert.equal(expanded.modelId, "p/a");
});

test("AA per-task output tokens override the profile fallback when present", () => {
	const result = routeBenchmarkModel("coding", [{ id: "p/a", input: ["text"] }], [snapshot("a", {}, 100)], [health[0]], "digest")!;
	assert.equal(result.diagnostics.outputTokensSource, "artificial-analysis");
	assert.equal(result.diagnostics.predictedCompletionMs, 11_000);
});

test("routes provider-discovered canonical aliases without a separate static mapping", () => {
	const result = routeBenchmarkModel(
		"coding",
		[{ id: "alias/endpoint", canonicalId: "p/a", input: ["text"] }],
		[snapshot("a")],
		[{ id: "alias/endpoint", status: "ok", service: "chat", latencyMs: 1, tokensPerSecond: 100 }],
		"digest",
	);
	assert.equal(result.modelId, "alias/endpoint");
});

test("routes exact normalized thinking variants and returns the child argument", () => {
	const result = routeBenchmarkModel(
		"coding",
		[{ id: "p/a", reasoning: true, input: ["text"], thinkingLevelMap: { minimal: "low" } }],
		[snapshot("a", { coding: 70 }, undefined, 100, "low"), snapshot("a", { coding: 95 }, undefined, 100, "high")],
		[health[0]],
		"digest",
		"minimal",
	)!;
	assert.equal(result.thinkingLevel, "minimal");
	assert.equal(result.diagnostics.benchmarkThinkingLevel, "low");
	const maximum = routeBenchmarkModel(
		"coding",
		[{ id: "p/a", reasoning: true, input: ["text"], thinkingLevelMap: { max: "max" } }],
		[snapshot("a", { coding: 95 }, undefined, 100, "max")],
		[health[0]],
		"digest",
		"max",
	)!;
	assert.equal(maximum.thinkingLevel, "max");
	assert.equal(maximum.diagnostics.benchmarkThinkingLevel, "max");
});

test("null provider mappings preserve the child request while using Pi's clamped AA variant", () => {
	const result = routeBenchmarkModel(
		"coding",
		[{ id: "p/a", reasoning: true, input: ["text"], thinkingLevelMap: { off: null, minimal: "low" } }],
		[snapshot("a", { coding: 95 }, undefined, 100, "low")],
		[health[0]],
		"digest",
		"off",
	)!;
	assert.equal(result.thinkingLevel, "off");
	assert.equal(result.diagnostics.benchmarkThinkingLevel, "low");
	const nonCanonical = routeBenchmarkModel(
		"coding",
		[{ id: "p/a", reasoning: true, input: ["text"], thinkingLevelMap: { high: "provider-high" } }],
		[snapshot("a", { coding: 95 }, undefined, 100, "high")],
		[health[0]],
		"digest",
		"high",
	)!;
	assert.equal(nonCanonical.diagnostics.benchmarkThinkingLevel, "high");
});

test("generic snapshots work at every requested thinking level, but absent variants fail closed", () => {
	const generic = routeBenchmarkModel("coding", [{ id: "p/a", reasoning: true, input: ["text"] }], [snapshot("a")], [health[0]], "digest", "xhigh")!;
	assert.equal(generic.modelId, "p/a");
	assert.equal(generic.diagnostics.benchmarkThinkingLevel, null);
	const fixed = routeBenchmarkModel("coding", [{ id: "p/a", reasoning: true, input: ["text"], supportsReasoningEffort: false }], [snapshot("a")], [health[0]], "digest", "high")!;
	assert.equal(fixed.thinkingLevel, undefined);
	assert.equal(fixed.diagnostics.benchmarkThinkingLevel, null);
	const absent = routeBenchmarkModel("coding", [{ id: "p/a", reasoning: true, input: ["text"] }], [snapshot("a", {}, undefined, 100, "low")], [health[0]], "digest", "high");
	assert.equal(absent.modelId, undefined);
});

test("uses profile-weighted available coverage and exposes no-winner gate diagnostics", () => {
	const result = routeBenchmarkModel("balanced", [{ id: "p/a", input: ["text"] }], [snapshot("a", { agentic: null, toolUse: null, scientificReasoning: null, longContext: null, instructionFollowing: null, knowledge: null, faithfulness: null })], [health[0]], "digest");
	assert.equal(result.modelId, undefined);
	assert.equal(result.diagnostics.exclusions.minimumCoverage, 1);
	assert.ok(Math.abs((result.diagnostics.candidates[0]?.quality?.C ?? 0) - 0.4) < 1e-12);
	assert.ok(Math.abs((result.diagnostics.candidates[0]?.quality?.Q ?? 0) - 0.24) < 1e-12);
});

test("applies the one global faithfulness floor without model exceptions", () => {
	const candidate = [{ id: "p/a", input: ["text"] }];
	const fails = routeBenchmarkModel("research", candidate, [snapshot("a", { faithfulness: 7.499 })], [health[0]], "digest");
	const passes = routeBenchmarkModel("research", candidate, [snapshot("a", { faithfulness: 7.5 })], [health[0]], "digest");
	assert.equal(fails.modelId, undefined);
	assert.equal(fails.diagnostics.exclusions.faithfulnessFloor, 1);
	assert.equal(passes.modelId, "p/a");
});

test("unknown text capability fails closed", () => {
	const result = routeBenchmarkModel("balanced", [{ id: "p/a" }], [snapshot("a")], [health[0]], "digest");
	assert.equal(result.modelId, undefined);
	assert.equal(result.diagnostics.exclusions.capability, 1);
});

test("each profile requires its contractual benchmark dimensions", () => {
	const requirements = {
		balanced: ["intelligence", "coding"],
		coding: ["intelligence", "coding"],
		agentic: ["agentic", "toolUse"],
		research: ["intelligence", "scientificReasoning", "longContext", "knowledge", "faithfulness"],
		planning: ["scientificReasoning", "instructionFollowing"],
		review: ["instructionFollowing", "faithfulness"],
		"long-context": ["intelligence", "longContext"],
	} as const;
	for (const [profile, dimensions] of Object.entries(requirements) as Array<[keyof typeof requirements, readonly string[]]>) {
		for (const dimension of dimensions) {
			const result = routeBenchmarkModel(profile, [{ id: "p/a", input: ["text"], contextWindow: 262_144 }], [snapshot("a", { [dimension]: null })], [health[0]], "digest");
			assert.equal(result.modelId, undefined, `${profile}/${dimension}`);
			assert.deepEqual(result.diagnostics.candidates[0]?.rejectionReasons, ["missingRequiredDimension"]);
		}
	}
});

test("reports available-only quality, weighted coverage, and ordered no-winner reasons", () => {
	const result = routeBenchmarkModel(
		"balanced",
		[{ id: "p/a", input: ["text"] }],
		[snapshot("a", { agentic: null, toolUse: null, scientificReasoning: null, longContext: null, instructionFollowing: null, knowledge: null, faithfulness: null })],
		[health[0]],
		"digest",
	);
	const evaluation = result.diagnostics.candidates[0]!;
	assert.equal(evaluation.quality?.A, 0.6);
	assert.ok(Math.abs((evaluation.quality?.C ?? 0) - 0.4) < 1e-12);
	assert.ok(Math.abs((evaluation.quality?.Q ?? 0) - 0.24) < 1e-12);
	assert.deepEqual(evaluation.quality?.availableWeightedDimensions, ["intelligence", "coding"]);
	assert.deepEqual(evaluation.rejectionReasons, ["minimumCoverage"]);
});

test("the 7.5 global faithfulness boundary applies equally to review", () => {
	for (const profile of ["research", "review"] as const) {
		const fails = routeBenchmarkModel(profile, [{ id: "p/a", input: ["text"] }], [snapshot("a", { faithfulness: 7.499 })], [health[0]], "digest");
		const passes = routeBenchmarkModel(profile, [{ id: "p/a", input: ["text"] }], [snapshot("a", { faithfulness: 7.5 })], [health[0]], "digest");
		assert.deepEqual(fails.diagnostics.candidates[0]?.rejectionReasons, ["faithfulnessFloor"]);
		assert.equal(passes.modelId, "p/a");
	}
});

test("final equal candidates use code-point identity order", () => {
	const result = routeBenchmarkModel(
		"balanced",
		[{ id: "p/a", input: ["text"] }, { id: "p/Z", input: ["text"] }],
		[snapshot("a"), snapshot("Z")],
		[
			{ id: "p/a", status: "ok", latencyMs: 100, tokensPerSecond: 100 },
			{ id: "p/Z", status: "ok", latencyMs: 100, tokensPerSecond: 100 },
		],
		"digest",
	);
	assert.equal(result.modelId, "p/Z");
});
