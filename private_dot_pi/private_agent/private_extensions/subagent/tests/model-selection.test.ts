// Run with: npx -y tsx --test agent/extensions/subagent/tests/model-selection.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagent");
const MODULE_PATH = resolve(SUBAGENT_DIR, "model-selection.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".model-selection.testable.ts");
const HEALTH_STUB_PATH = resolve(SUBAGENT_DIR, ".model-health-check-stub.ts");

interface ModelMetadata {
	id: string;
	name: string;
	reasoning?: boolean;
	contextWindow?: number;
}

async function loadModule() {
	writePackageStubs();

	// Stub the relative model-health-check import via a passthrough controllable through globalThis.
	writeFileSync(
		HEALTH_STUB_PATH,
		[
			"export async function getHealthyEnabledModels(models) {",
			"  const override = globalThis.__subagentHealthyModels;",
			"  return override === undefined ? models : override;",
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
	delete (globalThis as any).__subagentHealthyModels;
}

const FIXTURE_MODELS: ModelMetadata[] = [
	{ id: "prov-a/reasoning-pro", name: "Reasoning Pro", reasoning: true, contextWindow: 200_000 },
	{ id: "prov-b/coder", name: "Coder", reasoning: false, contextWindow: 128_000 },
	{ id: "prov-c/flash-mini", name: "Flash Mini", reasoning: false, contextWindow: 32_000 },
	{ id: "prov-d/max-ultra", name: "Max Ultra", reasoning: true, contextWindow: 1_000_000 },
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
	(globalThis as any).__subagentHealthyModels = FIXTURE_MODELS;
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
	(globalThis as any).__subagentHealthyModels = FIXTURE_MODELS;
	try {
		const result = await mod.selectModelForSubagent("summarize the list quickly", {}, {
			useLlmSelector: false,
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
	(globalThis as any).__subagentHealthyModels = [];
	try {
		const result = await mod.selectModelForSubagent("any task", {}, { useLlmSelector: false });
		assert.equal(result.modelId, undefined);
		assert.equal(result.thinkingLevel, undefined);
	} finally {
		cleanup();
	}
});
