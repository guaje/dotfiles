import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describePolicyGenerationMismatch, loadBenchmarkAssets, loadBenchmarkHealth, ROUTING_POLICY, ROUTING_POLICY_VERSION, validateRoutingPolicy } from "../benchmark-assets.ts";
import { benchmarkHealthDigest, BENCHMARK_HEALTH_FIELDS, DIMENSIONS as AA_DIMENSIONS, METHODOLOGY, PUBLIC_METHODOLOGY_VERSION } from "../../09-catalog/aa/schema.ts";

const methodology = { id: METHODOLOGY.id, version: METHODOLOGY.version };
const AA_MODEL_ID = "11111111-1111-4111-8111-111111111111";
const scores = Object.fromEntries(AA_DIMENSIONS.map((dimension) => [dimension, 50]));
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
		modelId: AA_MODEL_ID,
		capturedAt: 1000,
		methodology: { ...methodology },
		mapping: { status: "mapped", matchBasis: "manual", reviewedAt: 900, thinkingLevel: null },
		source: { name: "Synthetic", slug: "synthetic", openrouterApiId: "p/m" },
		publicPage: { url: "https://artificialanalysis.ai/models/synthetic", retrievedAt: 1000, contentSha256: "a".repeat(64), recordSha256: "b".repeat(64), extractorVersion: "aa-current-model-rsc-v1", intelligenceIndexMethodologyVersion: PUBLIC_METHODOLOGY_VERSION },
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
		models: [{ provider: "p", model: "m", thinkingLevel: null, modelId: AA_MODEL_ID, file: "a9_z.json", capturedAt: 1000, contentDigest: "" }],
	};
	mutator?.(manifest, snapshot);
	const contentDigest = digest(snapshot);
	for (const entry of manifest.models) entry.contentDigest ||= contentDigest;
	manifest.digest = digest([...manifest.models].sort((a, b) => `${a.provider}/${a.model}/${a.thinkingLevel ?? ""}`.localeCompare(`${b.provider}/${b.model}/${b.thinkingLevel ?? ""}`)));
	writeFileSync(join(root, "aa-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
	writeFileSync(join(root, "models", "a9_z.json"), JSON.stringify(snapshot), { mode: 0o600 });
	return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("routing policy validation fails closed for contract drift", () => {
	assert.equal(validateRoutingPolicy(ROUTING_POLICY), true);
	const drift = structuredClone(ROUTING_POLICY) as any; drift.profiles.review.weights.coding = 0.1;
	assert.equal(validateRoutingPolicy(drift), false);
	const wrongVersion = structuredClone(ROUTING_POLICY) as any; wrongVersion.version = "3";
	assert.equal(validateRoutingPolicy(wrongVersion), false);
	const extraGate = structuredClone(ROUTING_POLICY) as any; extraGate.profiles.research.minimumCoverage = 0.7;
	assert.equal(validateRoutingPolicy(extraGate), false);
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

test("retries a missing snapshot only after an atomic manifest switch", async () => {
	const f = fixture();
	try {
		const manifestPath = join(f.root, "aa-manifest.json");
		const oldManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const oldFile = oldManifest.models[0].file;
		const nextFile = "next.json";
		const nextEntry = { ...oldManifest.models[0], file: nextFile };
		const nextManifest = { ...oldManifest, models: [nextEntry], digest: digest([nextEntry]) };
		writeFileSync(join(f.root, "models", nextFile), readFileSync(join(f.root, "models", oldFile)), { mode: 0o600 });
		let switched = false; let snapshotReads = 0;
		const loaded = await loadBenchmarkAssets(f.root, 2000, 2000, { beforeSnapshotRead() {
			snapshotReads++;
			if (switched) return;
			switched = true;
			const staged = join(f.root, "next-manifest.json");
			writeFileSync(staged, JSON.stringify(nextManifest), { mode: 0o600 });
			renameSync(staged, manifestPath);
			rmSync(join(f.root, "models", oldFile));
		} });
		assert.equal(switched, true);
		assert.equal(snapshotReads, 2);
		assert.equal(loaded?.manifest.models[0]?.file, nextFile);
	} finally {
		f.dispose();
	}
});

test("missing snapshots without a manifest switch remain unavailable", async () => {
	const f = fixture();
	try {
		rmSync(join(f.root, "models", "a9_z.json"));
		assert.equal(await loadBenchmarkAssets(f.root, 2000, 2000), null);
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
		const manifestPath = join(f.root, "aa-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const other = { ...JSON.parse(readFileSync(join(f.root, "models", "a9_z.json"), "utf8")), provider: "other" };
		manifest.models.push({ provider: "other", model: "m", thinkingLevel: null, modelId: AA_MODEL_ID, file: "other.json", capturedAt: 1000, contentDigest: digest(other) });
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
		snapshot.coverage = (AA_DIMENSIONS.length - 1) / AA_DIMENSIONS.length;
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

test("benchmark health artifacts load only when valid, fresh, digest-intact, and private", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-benchmark-health-"));
	try {
		const entry = (field: string) => ({ checked: 15, scored: field === "ifbench" ? 0 : 12, status: field === "ifbench" ? "retired" : "lagging", newestScoredRelease: field === "ifbench" ? "2026-07-09" : "2026-08-20" });
		const base = { version: 1 as const, methodology: { id: METHODOLOGY.id, version: METHODOLOGY.version }, fields: Object.fromEntries(BENCHMARK_HEALTH_FIELDS.map((field) => [field, entry(field)])) };
		const artifact = { ...base, generatedAt: 1_500, digest: benchmarkHealthDigest(base) };
		const file = join(root, "benchmark-health.json");
		const publish = (value: unknown, mode = 0o600) => { writeFileSync(file, JSON.stringify(value)); chmodSync(file, mode); };
		publish(artifact);
		const loaded = await loadBenchmarkHealth(root, 1_000, 2_000);
		assert.equal(loaded?.fields.ifbench.status, "retired");
		assert.equal(loaded?.fields.gpqa.status, "lagging");
		assert.equal(await loadBenchmarkHealth(root, 400, 2_000), null);
		assert.equal(await loadBenchmarkHealth(root, 1_000, 60_000), null);
		publish({ ...artifact, digest: "0".repeat(64) });
		assert.equal(await loadBenchmarkHealth(root, 1_000, 2_000), null);
		publish({ ...artifact, fields: { ...artifact.fields, extra: entry("extra") } });
		assert.equal(await loadBenchmarkHealth(root, 1_000, 2_000), null);
		// A dropped watched field is rejected even with a matching digest, so every reviewed metric is assessed.
		const reducedFields = Object.fromEntries(Object.entries(base.fields).filter(([field]) => field !== "tau3Banking"));
		const reduced = { ...base, fields: reducedFields };
		publish({ ...reduced, generatedAt: 1_500, digest: benchmarkHealthDigest(reduced) });
		assert.equal(await loadBenchmarkHealth(root, 1_000, 2_000), null);
		publish(artifact);
		publish(artifact, 0o640);
		assert.equal(await loadBenchmarkHealth(root, 1_000, 2_000), null);
		publish(artifact);
		writeFileSync(file, "{corrupt"); chmodSync(file, 0o600);
		assert.equal(await loadBenchmarkHealth(root, 1_000, 2_000), null);
		assert.equal(await loadBenchmarkHealth(join(root, "absent"), 1_000, 2_000), null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("routing policy v8 contains only percentile rubrics", () => {
	assert.equal(ROUTING_POLICY.version, ROUTING_POLICY_VERSION);
	assert.equal(ROUTING_POLICY.profiles.planning.weights.math, 0.15);
	assert.equal(ROUTING_POLICY.profiles.research.weights.knowledge, 0.30);
	assert.equal(ROUTING_POLICY.profiles["long-context"].constraints.minimumContextWindow, 131072);
	for (const removed of ["mandatoryFloors", "requiredDimensions", "minimumCoverage", "faithfulnessPolicy", "intelligence"]) assert.equal(JSON.stringify(ROUTING_POLICY).includes(removed), false);
});

// Routing degrades to interim ranking only when the operational bound has expired but the reviewed generation is
// still usable for comparison, so the two bounds must actually differ.
test("the reviewed interim age bound accepts a generation the operational bound rejects", async () => {
	const f = fixture();
	try {
		assert.equal(await loadBenchmarkAssets(f.root, 100, 2000), null, "the operational bound has expired");
		const frozen = await loadBenchmarkAssets(f.root, ROUTING_POLICY.interim.maxAssetAgeMs, 2000);
		assert.equal(frozen?.snapshots.length, 1, "the same generation still ranks");
	} finally {
		f.dispose();
	}
});

test("a routing policy file from another generation is named instead of failing routing silently", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-policy-"));
	const policyPath = join(root, "routing-policy.json");
	try {
		writeFileSync(policyPath, JSON.stringify({ ...ROUTING_POLICY, version: "6" }));
		const notice = await describePolicyGenerationMismatch(policyPath);
		assert.match(notice ?? "", /generation 6/);
		assert.match(notice ?? "", new RegExp(`accepts ${ROUTING_POLICY_VERSION}`));

		writeFileSync(policyPath, JSON.stringify({ ...ROUTING_POLICY, version: ROUTING_POLICY_VERSION }));
		assert.equal(await describePolicyGenerationMismatch(policyPath), null);
		assert.equal(await describePolicyGenerationMismatch(join(root, "absent.json")), null, "a missing file is not a generation mismatch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
