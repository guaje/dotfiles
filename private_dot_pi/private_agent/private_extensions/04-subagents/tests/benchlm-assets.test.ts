import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRoutingBenchmarkAssets } from "../benchlm-assets.ts";
import { DIMENSIONS as AA_DIMENSIONS, METHODOLOGY, PUBLIC_METHODOLOGY_VERSION } from "../../09-catalog/aa/schema.ts";
import type { BenchmarkSnapshot } from "../benchmark-types.ts";

const canonical = (value: any): any => Array.isArray(value)
	? value.map(canonical)
	: value && typeof value === "object"
		? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
		: value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const BENCH_METHOD = "bench-align-v5.8-2026-09-30";

const UUIDS: Record<string, string> = { "p/covered": "11111111-1111-4111-8111-111111111111", "p/gone-from-feed": "22222222-2222-4222-8222-222222222222" };
function aaSnapshot(provider: string, model: string, overrides: Record<string, unknown> = {}) {
	return {
		version: 4, provider, model, thinkingLevel: null, modelId: UUIDS[`${provider}/${model}`]!, capturedAt: 1000,
		methodology: { id: METHODOLOGY.id, version: METHODOLOGY.version },
		mapping: { status: "mapped", matchBasis: "manual", reviewedAt: 900, thinkingLevel: null },
		source: { name: model, slug: model, openrouterApiId: `${provider}/${model}` },
		publicPage: { url: `https://artificialanalysis.ai/models/${model}`, retrievedAt: 1000, contentSha256: "a".repeat(64), recordSha256: "b".repeat(64), extractorVersion: "aa-current-model-rsc-v1", intelligenceIndexMethodologyVersion: PUBLIC_METHODOLOGY_VERSION },
		scores: Object.fromEntries(AA_DIMENSIONS.map((dimension) => [dimension, 40])),
		toolUse: { components: { tau3Banking: null, gdpvalAaNormalized: null, tau2Telecom: { normalizedScore: 40, sourceKind: "api", fieldPath: "evaluations.tau2_telecom", benchmark: { id: "tau2-telecom", version: "test", status: "current" }, retrievedAt: 1000, sourceUrl: "https://artificialanalysis.ai/api/v2/language/models", sourceRecordDigest: "c".repeat(64) } }, derivation: { version: "v1", rule: "tau2-telecom-fallback", score: 40 } },
		outputTokens: { balanced: 100 }, taskTimeMs: { balanced: 10 }, coverage: 1, ...overrides,
	} as any;
}

function benchSnapshot(runtimeId: string, canonicalId: string, categoryScores: Record<string, number>) {
	return {
		version: 1, runtimeId, canonicalId, model: runtimeId.split("/")[1], creator: "Test Lab", capturedAt: 2000,
		lastUpdated: "2026-10-29", methodologyVersion: BENCH_METHOD, sourceSnapshotId: "2026-10-29-abc", attribution: "Data from BenchLM.ai", license: "CC BY-NC 4.0",
		categoryScores, categoryProvenance: Object.fromEntries(Object.keys(categoryScores).map((key) => [key, "leaderboard"])),
		categories: Object.entries(categoryScores).map(([key, score]) => ({ key, score, rank: 1, total: 10 })),
		details: [{ category: "coding", key: "fixture", name: "Fixture Bench", value: 50, formatted: "50%", verificationStatus: "benchmark_exact", verificationLabel: "Independently run", source: { label: "BenchLM run" } }],
	} as any;
}

/** One Artificial Analysis generation holding two models, one of which BenchLM also lists. */
function aaRoot(snapshots: any[]) {
	const root = mkdtempSync(join(tmpdir(), "pi-aa-"));
	chmodSync(root, 0o700); mkdirSync(join(root, "models"), { mode: 0o700 });
	const models = snapshots.map((snapshot) => ({ provider: snapshot.provider, model: snapshot.model, thinkingLevel: snapshot.thinkingLevel, modelId: snapshot.modelId, file: `${snapshot.model}.json`, capturedAt: snapshot.capturedAt, contentDigest: digest(snapshot) }));
	const manifest = { version: 4, generatedAt: 3000, digest: digest([...models].sort((a, b) => a.model.localeCompare(b.model))), methodology: { id: METHODOLOGY.id, version: METHODOLOGY.version }, models };
	writeFileSync(join(root, "aa-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	for (const [index, snapshot] of snapshots.entries()) writeFileSync(join(root, "models", `${snapshot.model}.json`), JSON.stringify(snapshot), { mode: 0o600 });
	return root;
}
function benchRoot(snapshots: any[]) {
	const root = mkdtempSync(join(tmpdir(), "pi-bench-"));
	chmodSync(root, 0o700); mkdirSync(join(root, "models"), { mode: 0o700 });
	const models = snapshots.map((snapshot) => ({ runtimeId: snapshot.runtimeId, canonicalId: snapshot.canonicalId, file: `${snapshot.runtimeId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`, contentDigest: digest(snapshot) }));
	const manifest = { version: 1, generatedAt: 3000, methodologyVersion: BENCH_METHOD, sourceSnapshotId: "2026-10-29-abc", digest: digest(models), models };
	writeFileSync(join(root, "benchlm-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	for (const [index, snapshot] of snapshots.entries()) writeFileSync(join(root, "models", `${snapshot.runtimeId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), JSON.stringify(snapshot), { mode: 0o600 });
	return root;
}

const NOW = 3000 + 1000;
const AGE = 2_592_000_000;
const find = (snapshots: BenchmarkSnapshot[], model: string) => snapshots.find((entry) => entry.model === model);

test("BenchLM evidence supplies its columns while Artificial Analysis keeps the two it alone measures", async () => {
	const aa = aaRoot([aaSnapshot("p", "covered")]);
	const bench = benchRoot([benchSnapshot("p/covered", "lab/covered", { coding: 91, agentic: 80, knowledge: 70, reasoning: 60 })]);
	try {
		const assets = await loadRoutingBenchmarkAssets(aa, bench, AGE, NOW);
		assert.ok(assets?.benchLm, "the BenchLM generation is recognised");
		const merged = find(assets!.snapshots, "covered")!;
		assert.equal(merged.scores.coding, 91, "coding comes from BenchLM, not Artificial Analysis");
		assert.equal(merged.scoreSources?.coding, "benchlm");
		assert.equal(merged.scores.longContext, 40, "long context still comes from Artificial Analysis");
		assert.equal(merged.scoreSources?.longContext, "artificial-analysis");
		assert.equal(merged.scores.faithfulness, 40);
		assert.equal(merged.scores.toolUse, 40);
	} finally { rmSync(aa, { recursive: true, force: true }); rmSync(bench, { recursive: true, force: true }); }
});

test("a model scored only at other thinking levels keeps a level-agnostic view of its report card", async () => {
	const aa = aaRoot([aaSnapshot("p", "covered", { thinkingLevel: "low", modelId: UUIDS["p/covered"], mapping: { status: "mapped", matchBasis: "manual", reviewedAt: 900, thinkingLevel: "low" } })]);
	const bench = benchRoot([benchSnapshot("p/covered", "lab/covered", { coding: 91, agentic: 80, knowledge: 70 })]);
	try {
		const assets = await loadRoutingBenchmarkAssets(aa, bench, AGE, NOW);
		const levels = assets!.snapshots.filter((entry) => entry.model === "covered").map((entry) => String(entry.thinkingLevel)).sort();
		assert.deepEqual(levels, ["low", "null"], "the variant and a level-agnostic view both exist");
		const agnostic = assets!.snapshots.find((entry) => entry.model === "covered" && entry.thinkingLevel === null)!;
		assert.equal(agnostic.scores.coding, 91, "the level-agnostic view still carries the published BenchLM figures");
	} finally { rmSync(aa, { recursive: true, force: true }); rmSync(bench, { recursive: true, force: true }); }
});

test("a model BenchLM dropped keeps ranking on Artificial Analysis instead of becoming unroutable", async () => {
	const aa = aaRoot([aaSnapshot("p", "covered"), aaSnapshot("p", "gone-from-feed")]);
	const bench = benchRoot([benchSnapshot("p/covered", "lab/covered", { coding: 91, agentic: 80, knowledge: 70 })]);
	try {
		const assets = await loadRoutingBenchmarkAssets(aa, bench, AGE, NOW);
		const ids = assets!.snapshots.map((entry) => `${entry.provider}/${entry.model}`).sort();
		assert.deepEqual(ids, ["p/covered", "p/gone-from-feed"], "losing a publisher must not shrink the fleet");
		const dropped = find(assets!.snapshots, "gone-from-feed")!;
		assert.equal(dropped.scores.coding, 40, "its Artificial Analysis figures are used as-is");
		assert.equal(assets!.benchLm, true);
	} finally { rmSync(aa, { recursive: true, force: true }); rmSync(bench, { recursive: true, force: true }); }
});

test("routing falls back to Artificial Analysis alone when no BenchLM generation was reviewed", async () => {
	const aa = aaRoot([aaSnapshot("p", "covered")]);
	const empty = mkdtempSync(join(tmpdir(), "pi-bench-empty-"));
	try {
		const assets = await loadRoutingBenchmarkAssets(aa, empty, AGE, NOW);
		assert.equal(assets?.benchLm, false);
		assert.equal(assets?.snapshots.length, 1);
	} finally { rmSync(aa, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});

test("a BenchLM snapshot that does not match its manifest digest is not loaded", async () => {
	const aa = aaRoot([aaSnapshot("p", "covered")]);
	const root = mkdtempSync(join(tmpdir(), "pi-bench-"));
	chmodSync(root, 0o700); mkdirSync(join(root, "models"), { mode: 0o700 });
	const snapshot = benchSnapshot("p/covered", "lab/covered", { coding: 91 });
	writeFileSync(join(root, "benchlm-manifest.json"), JSON.stringify({ version: 1, generatedAt: 3000, methodologyVersion: BENCH_METHOD, sourceSnapshotId: "2026-10-29-abc", digest: digest([snapshot]), models: [{ runtimeId: "p/covered", canonicalId: "lab/covered", file: "p_covered.json", contentDigest: "0".repeat(64) }] }), { mode: 0o600 });
	writeFileSync(join(root, "models", "p_covered.json"), JSON.stringify(snapshot), { mode: 0o600 });
	try {
		const assets = await loadRoutingBenchmarkAssets(aa, root, AGE, NOW);
		assert.equal(assets?.benchLm, false, "a tampered generation is treated as absent, not trusted");
		assert.equal(assets?.snapshots.length, 1, "Artificial Analysis evidence is still usable");
	} finally { rmSync(aa, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
