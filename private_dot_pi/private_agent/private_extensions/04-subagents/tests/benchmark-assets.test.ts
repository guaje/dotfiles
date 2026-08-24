import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBenchmarkAssets, ROUTING_POLICY, validateRoutingPolicy } from "../benchmark-assets.ts";
import { BENCHMARK_DIMENSIONS } from "../benchmark-types.ts";

const methodology = { id: "artificial-analysis-intelligence-index", version: "4.1" };
const scores = Object.fromEntries(BENCHMARK_DIMENSIONS.map((dimension) => [dimension, 50]));
const canonical = (value: any): any => Array.isArray(value)
	? value.map(canonical)
	: value && typeof value === "object"
		? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
		: value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function fixture(mutator?: (manifest: any, snapshot: any) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-bench-"));
	chmodSync(root, 0o700);
	mkdirSync(join(root, "models"), { mode: 0o700 });
	const snapshot = {
		version: 4,
		provider: "p",
		model: "m",
		thinkingLevel: null,
		modelId: "opaque",
		capturedAt: 1000,
		methodology: { ...methodology },
		mapping: { status: "mapped", matchBasis: "manual", reviewedAt: 900, thinkingLevel: null },
		source: { name: "Synthetic", slug: "synthetic", openrouterApiId: "p/m" },
		publicPage: { url: "https://artificialanalysis.ai/models/synthetic", retrievedAt: 1000, contentSha256: "a".repeat(64), recordSha256: "b".repeat(64), extractorVersion: "aa-current-model-rsc-v1", intelligenceIndexMethodologyVersion: "4.1.1" },
		scores: { ...scores },
		toolUse: { components: { tau3Banking: null, gdpvalAaNormalized: null, tau2Telecom: { normalizedScore: 50, sourceKind: "api", fieldPath: "evaluations.tau2_telecom", benchmark: { id: "tau2-telecom", version: "test", status: "current" }, retrievedAt: 1000, sourceUrl: "https://artificialanalysis.ai/api/v2/language/models", sourceRecordDigest: "c".repeat(64) } }, derivation: { version: "v1", rule: "tau2-telecom-fallback", score: 50 } },
		outputTokens: { balanced: 100 },
		taskTimeMs: { balanced: 10 },
		coverage: 1,
	};
	const manifest = {
		version: 4,
		generatedAt: 1000,
		digest: "",
		methodology: { ...methodology },
		models: [{ provider: "p", model: "m", thinkingLevel: null, modelId: "opaque", file: "a9_z.json", capturedAt: 1000, contentDigest: "" }],
	};
	mutator?.(manifest, snapshot);
	const contentDigest = digest(snapshot);
	for (const entry of manifest.models) entry.contentDigest ||= contentDigest;
	manifest.digest = digest([...manifest.models].sort((a, b) => `${a.provider}/${a.model}/${a.thinkingLevel ?? ""}`.localeCompare(`${b.provider}/${b.model}/${b.thinkingLevel ?? ""}`)));
	writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	writeFileSync(join(root, "models", "a9_z.json"), JSON.stringify(snapshot), { mode: 0o600 });
	return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("routing policy validation fails closed for contract drift", () => {
	assert.equal(validateRoutingPolicy(ROUTING_POLICY), true);
	const drift = structuredClone(ROUTING_POLICY) as any; drift.profiles.review.minimumCoverage = 0.84;
	assert.equal(validateRoutingPolicy(drift), false);
	const wrongVersion = structuredClone(ROUTING_POLICY) as any; wrongVersion.version = "3";
	assert.equal(validateRoutingPolicy(wrongVersion), false);
	const duplicateFaith = structuredClone(ROUTING_POLICY) as any; duplicateFaith.profiles.research.mandatoryFloors.faithfulness = 7.5;
	assert.equal(validateRoutingPolicy(duplicateFaith), false);
});

test("loads opaque exact snapshots in stable order", async () => {
	const f = fixture();
	try {
		const loaded = await loadBenchmarkAssets(f.root, 2000, 2000);
		assert.equal(loaded?.snapshots[0]?.provider, "p");
		assert.match(loaded?.manifest.digest ?? "", /^[a-f0-9]{64}$/);
	} finally {
		f.dispose();
	}
});

test("fails closed for stale manifests, duplicate identities/files, and methodology mismatches", async () => {
	for (const mutate of [
		(manifest: any) => { manifest.version = 3; },
		(manifest: any) => { manifest.generatedAt = 1; },
		(manifest: any) => { manifest.models.push({ ...manifest.models[0] }); },
		(manifest: any) => { manifest.models.push({ ...manifest.models[0], provider: "other", model: "alias" }); },
		(_: any, snapshot: any) => { snapshot.methodology.version = "other"; },
	]) {
		const f = fixture(mutate);
		try {
			assert.equal(await loadBenchmarkAssets(f.root, 100, 2000), null);
		} finally {
			f.dispose();
		}
	}
});

test("the same AA model may map to distinct Pi providers", async () => {
	const f = fixture();
	try {
		const manifestPath = join(f.root, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const other = { ...JSON.parse(readFileSync(join(f.root, "models", "a9_z.json"), "utf8")), provider: "other" };
		manifest.models.push({ provider: "other", model: "m", thinkingLevel: null, modelId: "opaque", file: "other.json", capturedAt: 1000, contentDigest: digest(other) });
		manifest.digest = digest([...manifest.models].sort((a: any, b: any) => `${a.provider}/${a.model}/${a.thinkingLevel ?? ""}`.localeCompare(`${b.provider}/${b.model}/${b.thinkingLevel ?? ""}`)));
		writeFileSync(manifestPath, JSON.stringify(manifest));
		writeFileSync(join(f.root, "models", "other.json"), JSON.stringify(other), { mode: 0o600 });
		assert.equal((await loadBenchmarkAssets(f.root, 2000, 2000))?.snapshots.length, 2);
	} finally {
		f.dispose();
	}
});

test("generic and variant mappings for one model fail closed", async () => {
	const f = fixture((manifest: any) => {
		manifest.models.push({ ...manifest.models[0], thinkingLevel: "low", file: "variant.json" });
	});
	try {
		assert.equal(await loadBenchmarkAssets(f.root, 2000, 2000), null);
	} finally {
		f.dispose();
	}
});

test("group- or world-readable benchmark files fail closed", async () => {
	const f = fixture();
	try {
		chmodSync(join(f.root, "models", "a9_z.json"), 0o644);
		assert.equal(await loadBenchmarkAssets(f.root, 2000, 2000), null);
	} finally {
		f.dispose();
	}
});

test("content, manifest, and public provenance tampering fails closed", async () => {
	const f = fixture();
	try {
		const snapshotPath = join(f.root, "models", "a9_z.json");
		const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
		snapshot.scores.coding = 99;
		writeFileSync(snapshotPath, JSON.stringify(snapshot));
		assert.equal(await loadBenchmarkAssets(f.root, 2000, 2000), null);
		const f2 = fixture((_: any, publicSnapshot: any) => { publicSnapshot.publicPage.url = "https://example.test/models/synthetic"; });
		try { assert.equal(await loadBenchmarkAssets(f2.root, 2000, 2000), null); } finally { f2.dispose(); }
		const f3 = fixture((_: any, publicSnapshot: any) => {
			const component = publicSnapshot.toolUse.components.tau2Telecom;
			component.sourceKind = "public-page";
			component.sourceRecordDigest = publicSnapshot.publicPage.recordSha256;
			component.sourceUrl = "https://artificialanalysis.ai/models/different-model";
		});
		try { assert.equal(await loadBenchmarkAssets(f3.root, 2000, 2000), null); } finally { f3.dispose(); }
	} finally {
		f.dispose();
	}
});

test("null benchmark values remain unavailable without fuzzy identity", async () => {
	const f = fixture((_: any, snapshot: any) => {
		snapshot.scores.coding = null;
		snapshot.coverage = (BENCHMARK_DIMENSIONS.length - 1) / BENCHMARK_DIMENSIONS.length;
	});
	try {
		assert.equal((await loadBenchmarkAssets(f.root, 2000, 2000))?.snapshots[0]?.scores.coding, null);
	} finally {
		f.dispose();
	}
});

test("recomputes strict Tool Use derivations after digest verification", async () => {
	const f = fixture((_: any, snapshot: any) => { snapshot.toolUse.derivation.score = 49; snapshot.scores.toolUse = 49; });
	try { assert.equal(await loadBenchmarkAssets(f.root, 2000, 2000), null); } finally { f.dispose(); }
});

test("accepts only the tau3-plus-GDP primary pair or the legacy tau2 fallback", async () => {
	const component = (id: "tau3-banking" | "gdpval-aa", score: number) => ({
		normalizedScore: score,
		sourceKind: "api",
		fieldPath: `evaluations.${id}`,
		benchmark: { id, version: "test", status: "current" },
		retrievedAt: 1000,
		sourceUrl: "https://artificialanalysis.ai/api/v2/language/models",
		sourceRecordDigest: "c".repeat(64),
	});
	const primary = fixture((_: any, snapshot: any) => {
		snapshot.toolUse.components.tau3Banking = component("tau3-banking", 80);
		snapshot.toolUse.components.gdpvalAaNormalized = component("gdpval-aa", 70);
		snapshot.toolUse.derivation = { version: "v1", rule: "tau3-banking+gdpval-aa", score: 75 };
		snapshot.scores.toolUse = 75;
	});
	try { assert.equal((await loadBenchmarkAssets(primary.root, 2000, 2000))?.snapshots[0]?.scores.toolUse, 75); } finally { primary.dispose(); }
	const fallback = fixture((_: any, snapshot: any) => {
		snapshot.toolUse.components.tau3Banking = component("tau3-banking", 80);
		snapshot.toolUse.derivation = { version: "v1", rule: "tau2-telecom-fallback", score: 50 };
	});
	try { assert.equal((await loadBenchmarkAssets(fallback.root, 2000, 2000))?.snapshots[0]?.scores.toolUse, 50); } finally { fallback.dispose(); }
	const loneCurrent = fixture((_: any, snapshot: any) => {
		snapshot.toolUse.components.tau3Banking = component("tau3-banking", 80);
		snapshot.toolUse.components.tau2Telecom = null;
		snapshot.toolUse.derivation = { version: "v1", rule: "unavailable", score: null };
		snapshot.scores.toolUse = null;
		snapshot.coverage = 8 / 9;
	});
	try { assert.equal((await loadBenchmarkAssets(loneCurrent.root, 2000, 2000))?.snapshots[0]?.scores.toolUse, null); } finally { loneCurrent.dispose(); }
});
