// Run with: npx -y tsx --test agent/extensions/04-subagents/tests/model-selection.test.ts
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeModelMetadata } from "../model-metadata.ts";
import { BENCHMARK_DIMENSIONS } from "../benchmark-types.ts";
import { METHODOLOGY, PUBLIC_METHODOLOGY_VERSION } from "../../09-catalog/aa/schema.ts";
import { writePackageStubs } from "./_stubs.ts";

writePackageStubs();
const modelSelectionModule = import("../model-selection.ts");

test("subagent routing reads exactly the /scoped-models runtime scope", async () => {
	const { getEnabledModelsMetadata } = await modelSelectionModule;
	const available = [
		{ provider: "catalog", id: "scoped", input: ["text"] },
		{ provider: "catalog", id: "outside-scope", input: ["text"] },
	];
	assert.deepEqual(getEnabledModelsMetadata([{ model: available[0]! }], available, new Map([["catalog/scoped", "upstream/scoped"]])), [{ id: "catalog/scoped", canonicalId: "upstream/scoped", input: ["text"] }]);
	assert.deepEqual(getEnabledModelsMetadata([], available).map((model) => model.id), ["catalog/outside-scope", "catalog/scoped"]);
});

test("verified model records normalize missing input to text while unknown records fail closed", () => {
	assert.deepEqual(normalizeModelMetadata("test-provider", { id: "default-text" })?.input, ["text"]);
	assert.deepEqual(normalizeModelMetadata("test-provider", { id: "verified-image", input: ["image"] })?.input, ["image"]);
	assert.equal(normalizeModelMetadata("test-provider", { input: ["text"] }), null);
});

// ---------------------------------------------------------------------------
// selectModelForSubagent runs against a sandbox copy of the extension tree so
// that every disk-derived path it reads (the shared model-health cache, the
// settings store root, and the benchmark asset root) lives under a temp dir
// instead of the real repository. The selection module itself is the real
// source, copied verbatim.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIRS = ["04-subagents", "06-health", "08-settings"];
const SANDBOX_EXCLUDE = /[\\/](tests|node_modules|scripts|__pycache__)([\\/]|$)|[\\/]assets[\\/]aa[\\/]models([\\/]|$)|[\\/]\.[^\\/]+$/;

/** Synthetic fixture identity, deliberately unlike any real provider/model id. */
const AA_MODEL_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_MAX_AGE_MS = 60 * 60 * 1000;
const HEALTHY = { id: "p/m", status: "ok", service: "chat", latencyMs: 500, tokensPerSecond: 100 };

const canonicalize = (value: any): any => Array.isArray(value)
	? value.map(canonicalize)
	: value && typeof value === "object"
		? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
		: value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");

let sandbox = "";
let selectionModule: any;

/** Bare package stubs for the sandbox copy. The completion API throws and counts calls so a
 * regression that routes model selection through an LLM fails loudly instead of silently. */
function writeSandboxPackages(extensionsDir: string): void {
	const packages: Record<string, string> = {
		"@earendil-works/pi-ai": [
			"export async function completeSimple() {",
			"  globalThis.__modelSelectionCompletionCalls = (globalThis.__modelSelectionCompletionCalls ?? 0) + 1;",
			"  throw new Error('model selection must not call a completion API');",
			"}",
			"export function StringEnum(values) { return { type: 'string', enum: [...values] }; }",
		].join("\n"),
		"@earendil-works/pi-coding-agent": [
			"export function getAgentDir() { return '/nonexistent-model-selection-test'; }",
		].join("\n"),
		"@earendil-works/pi-tui": [
			"export class Container { constructor() { this.children = []; } addChild(child) { this.children.push(child); return child; } }",
			"export class Text { constructor(text) { this.text = text; } }",
		].join("\n"),
	};
	for (const [name, indexContent] of Object.entries(packages)) {
		const dir = join(extensionsDir, "node_modules", ...name.split("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
		writeFileSync(join(dir, "index.js"), `${indexContent}\n`);
	}
}

function buildSandbox(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-model-selection-"));
	chmodSync(root, 0o700);
	const extensionsDir = join(root, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	for (const dir of SANDBOX_DIRS) {
		cpSync(resolve(HERE, "../..", dir), join(extensionsDir, dir), {
			recursive: true,
			filter: (source: string) => !SANDBOX_EXCLUDE.test(source),
		});
	}
	mkdirSync(join(extensionsDir, "09-catalog", "aa"), { recursive: true });
	cpSync(resolve(HERE, "../../09-catalog/aa/schema.ts"), join(extensionsDir, "09-catalog", "aa", "schema.ts"));
	writeSandboxPackages(extensionsDir);
	// Empty settings: every consumer falls back to its own code-owned policy defaults.
	writeFileSync(join(root, "settings.config.json"), "{}\n");
	return root;
}

/** The smallest complete, current benchmark generation: manifest + one exact snapshot. */
function writeBenchmarkAssets(root: string, generatedAt: number): string {
	const assetRoot = join(root, "aa");
	mkdirSync(join(assetRoot, "models"), { recursive: true });
	chmodSync(assetRoot, 0o700);
	chmodSync(join(assetRoot, "models"), 0o700);
	const snapshot = {
		version: 4,
		provider: "p",
		model: "m",
		thinkingLevel: null,
		modelId: AA_MODEL_ID,
		capturedAt: generatedAt,
		methodology: { id: METHODOLOGY.id, version: METHODOLOGY.version },
		mapping: { status: "mapped", matchBasis: "manual", reviewedAt: generatedAt, thinkingLevel: null },
		source: { name: "Synthetic", slug: "synthetic", openrouterApiId: "p/m" },
		publicPage: {
			url: "https://artificialanalysis.ai/models/synthetic",
			retrievedAt: generatedAt,
			contentSha256: "a".repeat(64),
			recordSha256: "b".repeat(64),
			extractorVersion: "aa-current-model-rsc-v1",
			intelligenceIndexMethodologyVersion: PUBLIC_METHODOLOGY_VERSION,
		},
		scores: Object.fromEntries(BENCHMARK_DIMENSIONS.map((dimension) => [dimension, 50])),
		toolUse: {
			components: {
				tau3Banking: null,
				gdpvalAaNormalized: null,
				tau2Telecom: {
					normalizedScore: 50,
					sourceKind: "api",
					fieldPath: "evaluations.tau2_telecom",
					benchmark: { id: "tau2-telecom", version: "test", status: "current" },
					retrievedAt: generatedAt,
					sourceUrl: "https://artificialanalysis.ai/api/v2/language/models",
					sourceRecordDigest: "c".repeat(64),
				},
			},
			derivation: { version: "v1", rule: "tau2-telecom-fallback", score: 50 },
		},
		outputTokens: { balanced: 100 },
		taskTimeMs: { balanced: 10 },
		coverage: 1,
	};
	const manifest = {
		version: 4,
		generatedAt,
		digest: "",
		methodology: { id: METHODOLOGY.id, version: METHODOLOGY.version },
		models: [{ provider: "p", model: "m", thinkingLevel: null, modelId: AA_MODEL_ID, file: "fixture.json", capturedAt: generatedAt, contentDigest: digest(snapshot) }],
	};
	manifest.digest = digest(manifest.models);
	writeFileSync(join(assetRoot, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	writeFileSync(join(assetRoot, "models", "fixture.json"), JSON.stringify(snapshot), { mode: 0o600 });
	return assetRoot;
}

function writeHealthCache(checkedAt: number, results: unknown[]): void {
	writeFileSync(join(sandbox, "model-health-cache.json"), JSON.stringify({ checkedAt, results }));
}

/** Fresh assets + fresh healthy cache, which is the only arrangement that can select. */
function readyFixture(): { snapshotRoot: string; models: unknown[] } {
	const snapshotRoot = writeBenchmarkAssets(sandbox, Date.now());
	writeHealthCache(Date.now(), [HEALTHY]);
	return { snapshotRoot, models: [{ id: "p/m", input: ["text"], reasoning: true }] };
}

before(async () => {
	sandbox = buildSandbox();
	selectionModule = await import(`${pathToFileURL(join(sandbox, "extensions/04-subagents/model-selection.ts")).href}?t=${Date.now()}`);
});

after(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	sandbox = "";
	delete (globalThis as any).__modelSelectionCompletionCalls;
});

test("a healthy scoped model with current benchmarks selects its benchmark route", async () => {
	const { snapshotRoot, models } = readyFixture();
	try {
		const result = await selectionModule.selectModelForSubagent({
			task: "recon the repo",
			models,
			snapshotRoot,
			snapshotMaxAgeMs: FIXTURE_MAX_AGE_MS,
		});
		assert.deepEqual(
			{ modelId: result.modelId, thinkingLevel: result.thinkingLevel, selector: result.selector },
			{ modelId: "p/m", thinkingLevel: "medium", selector: "benchmark" },
		);
		assert.equal(result.benchmarkRoute?.routingProfile, "balanced");
		assert.equal(result.benchmarkRoute?.candidateCount, 1);
	} finally {
		rmSync(snapshotRoot, { recursive: true, force: true });
	}
});

test("model selection stays empty when the benchmark asset root is absent", async () => {
	writeHealthCache(Date.now(), [HEALTHY]);
	const result = await selectionModule.selectModelForSubagent({
		models: [{ id: "p/m", input: ["text"] }],
		snapshotRoot: join(sandbox, "missing-aa-root"),
		snapshotMaxAgeMs: FIXTURE_MAX_AGE_MS,
	});
	assert.deepEqual(result, {});
});

test("model selection stays empty when the local model-health cache is stale", async () => {
	const snapshotRoot = writeBenchmarkAssets(sandbox, Date.now());
	writeHealthCache(1, [HEALTHY]);
	try {
		const result = await selectionModule.selectModelForSubagent({
			models: [{ id: "p/m", input: ["text"] }],
			snapshotRoot,
			snapshotMaxAgeMs: FIXTURE_MAX_AGE_MS,
		});
		assert.deepEqual(result, {});
	} finally {
		rmSync(snapshotRoot, { recursive: true, force: true });
	}
});

test("model selection stays empty when no models are available", async () => {
	const { snapshotRoot } = readyFixture();
	try {
		const result = await selectionModule.selectModelForSubagent({ models: [], snapshotRoot, snapshotMaxAgeMs: FIXTURE_MAX_AGE_MS });
		assert.deepEqual(result, {});
	} finally {
		rmSync(snapshotRoot, { recursive: true, force: true });
	}
});

test("model selection swallows a malformed runtime model record and fails closed", async () => {
	const { snapshotRoot } = readyFixture();
	try {
		const result = await selectionModule.selectModelForSubagent({
			models: [null],
			snapshotRoot,
			snapshotMaxAgeMs: FIXTURE_MAX_AGE_MS,
		});
		assert.deepEqual(result, {});
	} finally {
		rmSync(snapshotRoot, { recursive: true, force: true });
	}
});

test("model selection resolves without calling a completion API", async () => {
	const { snapshotRoot, models } = readyFixture();
	(globalThis as any).__modelSelectionCompletionCalls = 0;
	try {
		const result = await selectionModule.selectModelForSubagent({ models, snapshotRoot, snapshotMaxAgeMs: FIXTURE_MAX_AGE_MS });
		assert.equal(result.modelId, "p/m");
		assert.equal((globalThis as any).__modelSelectionCompletionCalls, 0);
	} finally {
		rmSync(snapshotRoot, { recursive: true, force: true });
		delete (globalThis as any).__modelSelectionCompletionCalls;
	}
});
