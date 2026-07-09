// Run with: npx -y tsx --test agent/extensions/subagents/tests/model-selection.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagents");
const MODULE_PATH = resolve(SUBAGENT_DIR, "model-selection.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".model-selection.testable.ts");
const HEALTH_STUB_PATH = resolve(SUBAGENT_DIR, ".model-health-check-stub.ts");

interface ModelMetadata {
	id: string;
	name: string;
	reasoning?: boolean;
	contextWindow?: number;
	params?: number;
	activeParams?: number;
	quant?: string;
}

async function loadModule() {
	writePackageStubs();

	// Stub the relative model-health-check import via a passthrough controllable through globalThis.
	writeFileSync(
		HEALTH_STUB_PATH,
		[
			"export const MODEL_HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;",
			"export async function getFreshCachedResults() {",
			"  return globalThis.__subagentHealthCache ?? null;",
			"}",
		].join("\n"),
	);

	// Patched copy: redirect the model-health-check import to the stub.
	const source = readFileSync(MODULE_PATH, "utf8").replace(
		/from "\.\.\/model-health-check\.ts"/,
		'from "./.model-health-check-stub.ts"',
	);
	writeFileSync(TESTABLE_PATH, source);

	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
	rmSync(HEALTH_STUB_PATH, { force: true });
	delete (globalThis as any).__subagentHealthCache;
}

// Helper: a fresh cache marking the given model ids as healthy (status "ok").
// Entries may carry optional perf metrics (latencyMs, tokensPerSecond) and a
// service tag ("chat" | "imageGeneration").
function healthyCache(
	ids: string[],
	opts: { latencyMs?: number; tokensPerSecond?: number; service?: string } = {},
) {
	return ids.map((id) => ({ id, status: "ok", ...opts }));
}

const FIXTURE_MODELS: ModelMetadata[] = [
	{ id: "prov-a/reasoning-pro", name: "Reasoning Pro", reasoning: true, contextWindow: 200_000 },
	{ id: "prov-b/coder", name: "Coder", reasoning: false, contextWindow: 128_000 },
	{ id: "prov-c/flash-mini", name: "Flash Mini", reasoning: false, contextWindow: 32_000 },
	{ id: "prov-d/max-ultra", name: "Max Ultra", reasoning: true, contextWindow: 1_000_000 },
];

// Models annotated with manual capability metadata (params/activeParams/quant).
// Exercises the layered capability→perf path (hasCapabilityMetadata === true).
const ANNOTATED_MODELS: ModelMetadata[] = [
	{ id: "prov-a/big-reason", name: "Big Reason", reasoning: true, contextWindow: 200_000, params: 120, activeParams: 5.1, quant: "fp8" },
	{ id: "prov-b/coder-dense", name: "Coder Dense", reasoning: false, contextWindow: 128_000, params: 31, activeParams: 31, quant: "bf16" },
	{ id: "prov-c/flash-small", name: "Flash Small", reasoning: false, contextWindow: 32_000, params: 8, activeParams: 8, quant: "bf16" },
	{ id: "prov-d/moe-thinker", name: "MoE Thinker", reasoning: true, contextWindow: 1_000_000, params: 80, activeParams: 3, quant: "fp8" },
	{ id: "prov-e/quant-crushed", name: "Quant Crushed", reasoning: true, contextWindow: 200_000, params: 70, activeParams: 70, quant: "int4" },
];

test("estimateReasoningEffort maps task keywords to thinking levels", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.estimateReasoningEffort("design the system architecture"), "xhigh");
		assert.equal(mod.estimateReasoningEffort("debug this complex issue"), "high");
		assert.equal(mod.estimateReasoningEffort("implement the login function"), "medium");
		assert.equal(mod.estimateReasoningEffort("give a quick summary"), "low");
		assert.equal(mod.estimateReasoningEffort("do the thing"), "medium");
	} finally {
		cleanup();
	}
});

test("selectModel picks a reasoning model for complex tasks", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.selectModel("analyze and debug the architecture", FIXTURE_MODELS), "prov-a/reasoning-pro");
	} finally {
		cleanup();
	}
});

test("selectModel picks a coder model for coding tasks", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.selectModel("implement the function and fix the test", FIXTURE_MODELS), "prov-b/coder");
	} finally {
		cleanup();
	}
});

test("selectModel picks a fast model for lightweight tasks", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.selectModel("summarize the list quickly", FIXTURE_MODELS), "prov-c/flash-mini");
	} finally {
		cleanup();
	}
});

test("selectMostPowerfulThinkingModel prefers reasoning + larger context", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.selectMostPowerfulThinkingModel(FIXTURE_MODELS), "prov-d/max-ultra");
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent (heuristic) sets model + thinking level without touching the registry", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentHealthCache = healthyCache(FIXTURE_MODELS.map((m) => m.id));
	try {
		// Registry methods must never be called in heuristic mode.
		const registry = {
			find: () => {
				throw new Error("registry.find should not be called in heuristic mode");
			},
			getApiKeyAndHeaders: () => {
				throw new Error("registry.getApiKeyAndHeaders should not be called in heuristic mode");
			},
		};
		const result = await mod.selectModelForSubagent("analyze and debug the architecture", registry, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, "prov-a/reasoning-pro");
		assert.equal(result.thinkingLevel, "xhigh");
		assert.equal(result.selector, "heuristic");
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent (heuristic) omits thinking level for non-reasoning models", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentHealthCache = healthyCache(FIXTURE_MODELS.map((m) => m.id));
	try {
		const result = await mod.selectModelForSubagent("summarize the list quickly", {}, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, "prov-c/flash-mini");
		assert.equal(result.thinkingLevel, undefined);
		assert.equal(result.selector, "heuristic");
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent returns empty when no healthy models are available", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentHealthCache = []; // fresh cache, zero healthy
	try {
		const result = await mod.selectModelForSubagent("any task", {}, { useLlmSelector: false, models: FIXTURE_MODELS });
		assert.equal(result.modelId, undefined);
		assert.equal(result.thinkingLevel, undefined);
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent fails closed when the health cache is missing", async () => {
	const mod = await loadModule();
	// No __subagentHealthCache set -> getFreshCachedResults returns null (missing/stale).
	try {
		const result = await mod.selectModelForSubagent("analyze the architecture", {}, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, undefined, "missing cache must not auto-select");
		assert.equal(result.thinkingLevel, undefined);
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent fails closed when every configured model is unhealthy", async () => {
	const mod = await loadModule();
	// Fresh cache, but all probed models are in an error state (e.g. VPN-only).
	(globalThis as any).__subagentHealthCache = FIXTURE_MODELS.map((m) => ({
		id: m.id,
		status: "error",
		error: "unreachable",
	}));
	try {
		const result = await mod.selectModelForSubagent("analyze the architecture", {}, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, undefined, "unhealthy models must not be selected");
		assert.equal(result.thinkingLevel, undefined);
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent only selects from the healthy subset, skipping unhealthy ones", async () => {
	const mod = await loadModule();
	// prov-a/reasoning-pro is healthy; the others are unhealthy. A complex task
	// must pick the one healthy reasoning model, not fall back to the others.
	(globalThis as any).__subagentHealthCache = [
		{ id: "prov-a/reasoning-pro", status: "ok" },
		{ id: "prov-b/coder", status: "error" },
		{ id: "prov-c/flash-mini", status: "error" },
		{ id: "prov-d/max-ultra", status: "error" },
	];
	try {
		const result = await mod.selectModelForSubagent("analyze and debug the architecture", {}, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, "prov-a/reasoning-pro");
		assert.equal(result.selector, "heuristic");
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Layered selection: capability gate → capability score → perf tiebreak.
// ---------------------------------------------------------------------------

test("quantTier maps quantization strings to ordered tiers", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.quantTier("bf16"), 4);
		assert.equal(mod.quantTier("fp16"), 4);
		assert.equal(mod.quantTier("fp8"), 3);
		assert.equal(mod.quantTier("int4"), 1);
		assert.equal(mod.quantTier("mxfp4"), 1);
		assert.equal(mod.quantTier("nf4"), 1);
		assert.equal(mod.quantTier(undefined), undefined, "unannotated quant is neutral (undefined)");
		assert.equal(mod.quantTier("unknown-format"), undefined);
	} finally {
		cleanup();
	}
});

test("effectiveParams prefers activeParams, then params, then name-scrape", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.effectiveParams({ id: "p/m", name: "M", activeParams: 5.1, params: 120 }), 5.1);
		assert.equal(mod.effectiveParams({ id: "p/m", name: "M", params: 31 }), 31);
		assert.equal(mod.effectiveParams({ id: "p/7b-model", name: "7B Model" }), 7);
		assert.equal(mod.effectiveParams({ id: "p/3.5b", name: "3.5B" }), 3.5);
		assert.equal(mod.effectiveParams({ id: "p/m", name: "M" }), 0);
	} finally {
		cleanup();
	}
});

test("hasCapabilityMetadata detects any manual annotation", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.hasCapabilityMetadata(FIXTURE_MODELS), false);
		assert.equal(mod.hasCapabilityMetadata(ANNOTATED_MODELS), true);
		assert.equal(mod.hasCapabilityMetadata([{ id: "p/m", name: "M", quant: "fp8" }]), true);
	} finally {
		cleanup();
	}
});

test("capabilityScore makes reasoning the dominant signal", async () => {
	const mod = await loadModule();
	try {
		const smallReasoning = { id: "p/small-r", name: "Small R", reasoning: true, params: 8 };
		const bigNonReasoning = { id: "p/big-nr", name: "Big NR", reasoning: false, params: 500 };
		assert.ok(
			mod.capabilityScore(smallReasoning) > mod.capabilityScore(bigNonReasoning),
			"small reasoning model must outscore a much larger non-reasoning model",
		);
	} finally {
		cleanup();
	}
});

test("passesCapabilityGate hard-excludes for xhigh/high and respects the fp8 floor", async () => {
	const mod = await loadModule();
	try {
		const reasoningFp8 = { id: "p/r-fp8", name: "R", reasoning: true, quant: "fp8" };
		const reasoningInt4 = { id: "p/r-int4", name: "R", reasoning: true, quant: "int4" };
		const nonReasoning = { id: "p/nr", name: "NR", reasoning: false };
		const reasoningUnannotated = { id: "p/r-u", name: "R", reasoning: true };

		// xhigh/high: only reasoning + at/above fp8 floor pass.
		assert.equal(mod.passesCapabilityGate(reasoningFp8, "xhigh"), true);
		assert.equal(mod.passesCapabilityGate(reasoningInt4, "xhigh"), false, "int4 below fp8 floor excluded");
		assert.equal(mod.passesCapabilityGate(nonReasoning, "high"), false, "non-reasoning excluded for high");
		assert.equal(
			mod.passesCapabilityGate(reasoningUnannotated, "xhigh"),
			true,
			"unannotated reasoning passes (cannot prove below floor)",
		);

		// medium/low: no gate.
		assert.equal(mod.passesCapabilityGate(nonReasoning, "medium"), true);
		assert.equal(mod.passesCapabilityGate(reasoningInt4, "low"), true);
	} finally {
		cleanup();
	}
});

test("estimateTaskLength classifies tasks by expected token volume", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.estimateTaskLength("summarize the list"), "short");
		assert.equal(mod.estimateTaskLength("implement the full migration"), "long");
		assert.equal(mod.estimateTaskLength("review this"), "balanced");
	} finally {
		cleanup();
	}
});

test("perfScore treats missing metrics as neutral, never zero", async () => {
	const mod = await loadModule();
	try {
		const model = { id: "p/m", name: "M" };
		const empty = new Map();
		// No metrics → 0.5 latency + 0.5 throughput weighted 0.5/0.5 (balanced) = 0.5.
		assert.equal(mod.perfScore(model, empty, "balanced"), 0.5);
		// A model with excellent metrics scores higher than one with none.
		const fast = new Map([[
			"p/m",
			{ latencyMs: 100, tokensPerSecond: 90 },
		]]);
		assert.ok(mod.perfScore(model, fast, "balanced") > 0.5, "good metrics should beat missing metrics");
		// A reasoning model with no throughput (8-token probe) must not be zero-penalized.
		const noThroughput = new Map([[
			"p/m",
			{ latencyMs: 500, tokensPerSecond: undefined },
		]]);
		assert.ok(mod.perfScore(model, noThroughput, "long") > 0, "missing throughput must not zero the score");
	} finally {
		cleanup();
	}
});

test("selectModel (annotated) picks the strongest reasoning model for hard tasks", async () => {
	const mod = await loadModule();
	try {
		// Hard task: capability dominates. big-reason (5.1B active) outranks
		// moe-thinker (3B active); quant-crushed (int4) is gate-excluded.
		const id = mod.selectModel("analyze the deep architecture and root cause", ANNOTATED_MODELS);
		assert.equal(id, "prov-a/big-reason");
	} finally {
		cleanup();
	}
});

test("selectModel returns undefined when no model passes the hard gate for xhigh", async () => {
	const mod = await loadModule();
	try {
		// Only non-reasoning + below-floor models: none pass the xhigh gate.
		const weak: ModelMetadata[] = [
			{ id: "p/coder", name: "Coder", reasoning: false, params: 31, quant: "bf16" },
			{ id: "p/crushed", name: "Crushed", reasoning: true, params: 70, quant: "int4" },
		];
		assert.equal(mod.selectModel("analyze the deep architecture", weak), undefined);
	} finally {
		cleanup();
	}
});

test("selectModel (annotated) lets performance dominate low tasks", async () => {
	const mod = await loadModule();
	try {
		// Low task: perf weight 1.0, cap weight -0.3 (prefers smaller/cheaper).
		// flash-small gets the best metrics and should win despite being smallest.
		const metrics = new Map<string, { latencyMs?: number; tokensPerSecond?: number }>([
			["prov-a/big-reason", { latencyMs: 9000, tokensPerSecond: 5 }],
			["prov-b/coder-dense", { latencyMs: 2000, tokensPerSecond: 40 }],
			["prov-c/flash-small", { latencyMs: 100, tokensPerSecond: 90 }],
			["prov-d/moe-thinker", { latencyMs: 8000, tokensPerSecond: 8 }],
		]);
		const id = mod.selectModel("give a quick summary", ANNOTATED_MODELS, metrics);
		assert.equal(id, "prov-c/flash-small");
	} finally {
		cleanup();
	}
});

test("selectModel falls back to keyword heuristic for unannotated models", async () => {
	const mod = await loadModule();
	try {
		// FIXTURE_MODELS have no params/activeParams/quant → keyword path.
		assert.equal(mod.selectModel("implement the function", FIXTURE_MODELS), "prov-b/coder");
	} finally {
		cleanup();
	}
});

test("selectMostPowerfulThinkingModel tiebreaks equal-power candidates by latency", async () => {
	const mod = await loadModule();
	try {
		// Two identical reasoning models; the faster one wins the tiebreak.
		const twins: ModelMetadata[] = [
			{ id: "p/twin-a", name: "Twin", reasoning: true, contextWindow: 200_000 },
			{ id: "p/twin-b", name: "Twin", reasoning: true, contextWindow: 200_000 },
		];
		const metrics = new Map([
			["p/twin-a", { latencyMs: 2000, tokensPerSecond: 10 }],
			["p/twin-b", { latencyMs: 500, tokensPerSecond: 50 }],
		]);
		assert.equal(mod.selectMostPowerfulThinkingModel(twins, metrics), "p/twin-b");
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent excludes image-generation service models", async () => {
	const mod = await loadModule();
	// The only healthy model is tagged imageGeneration — it must be filtered out
	// so no chat executor is available and selection returns empty.
	(globalThis as any).__subagentHealthCache = [
		{ id: "prov-c/flash-mini", status: "ok", service: "imageGeneration" },
	];
	try {
		const result = await mod.selectModelForSubagent("summarize quickly", {}, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, undefined, "image-gen models must not be selected as chat executors");
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent includes chat-service models (explicit service tag)", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentHealthCache = healthyCache(["prov-c/flash-mini"], { service: "chat" });
	try {
		const result = await mod.selectModelForSubagent("summarize quickly", {}, {
			useLlmSelector: false,
			models: FIXTURE_MODELS,
		});
		assert.equal(result.modelId, "prov-c/flash-mini");
	} finally {
		cleanup();
	}
});

test("selectModelForSubagent flows perf metrics from the cache into selection", async () => {
	const mod = await loadModule();
	// Annotated models; low task. flash-small gets the best metrics so perf
	// dominates and flash-small is chosen over the bigger models.
	(globalThis as any).__subagentHealthCache = [
		...healthyCache(["prov-a/big-reason", "prov-b/coder-dense", "prov-d/moe-thinker"], {
			latencyMs: 5000,
			tokensPerSecond: 10,
		}),
		...healthyCache(["prov-c/flash-small"], { latencyMs: 100, tokensPerSecond: 90 }),
	];
	try {
		const result = await mod.selectModelForSubagent("give a quick summary", {}, {
			useLlmSelector: false,
			models: ANNOTATED_MODELS,
		});
		assert.equal(result.modelId, "prov-c/flash-small");
	} finally {
		cleanup();
	}
});

test("LLM selector prompt includes capability + perf annotations", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentHealthCache = healthyCache(
		["prov-a/big-reason", "prov-c/flash-small"],
		{ latencyMs: 250, tokensPerSecond: 60 },
	);
	let capturedPrompt = "";
	(globalThis as any).__subagentCompleteSimple = async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
		capturedPrompt = context.messages[0]!.content[0]!.text;
		return {
			content: [{ type: "text", text: '{"modelId":"prov-c/flash-small","reasoningEffort":"low","reason":"fast"}' }],
			stopReason: "stop",
		};
	};
	try {
		await mod.selectModelForSubagent(
			"summarize quickly",
			{ find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true }) },
			{ useLlmSelector: true, models: ANNOTATED_MODELS },
		);
		assert.ok(capturedPrompt.length > 0, "selector prompt should have been captured");
		assert.ok(capturedPrompt.includes("reasoning"), "prompt should annotate reasoning");
		assert.ok(capturedPrompt.includes("5.1B active"), "prompt should include MoE active params");
		assert.ok(capturedPrompt.includes("fp8"), "prompt should include quant");
		assert.ok(/latency/.test(capturedPrompt), "prompt should include latency");
		assert.ok(/tok\/s/.test(capturedPrompt), "prompt should include throughput");
	} finally {
		delete (globalThis as any).__subagentCompleteSimple;
		cleanup();
	}
});

test("LLM selector choice is overridden by the capability hard gate for xhigh tasks", async () => {
	const mod = await loadModule();
	// Healthy set: big-reason (reasoning, fp8) + flash-small (non-reasoning).
	(globalThis as any).__subagentHealthCache = healthyCache(["prov-a/big-reason", "prov-c/flash-small"]);
	// The LLM picks flash-small (non-reasoning) for an xhigh task — the gate
	// must override this to the capable fallback (big-reason).
	(globalThis as any).__subagentCompleteSimple = async () => ({
		content: [{ type: "text", text: '{"modelId":"prov-c/flash-small","reasoningEffort":"low","reason":"fast"}' }],
		stopReason: "stop",
	});
	try {
		const result = await mod.selectModelForSubagent(
			"analyze the deep architecture and root cause",
			{ find: () => ({}), getApiKeyAndHeaders: async () => ({ ok: true }) },
			{ useLlmSelector: true, models: ANNOTATED_MODELS },
		);
		assert.equal(result.modelId, "prov-a/big-reason", "gate must override the LLM's non-reasoning pick for xhigh");
		assert.equal(result.selector, "llm");
	} finally {
		delete (globalThis as any).__subagentCompleteSimple;
		cleanup();
	}
});
