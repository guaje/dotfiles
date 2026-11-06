import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SNAPSHOT_ROOT, loadBenchmarkAssets, loadBenchmarkHealth } from "../benchmark-assets.ts";
import { routeBenchmarkModel } from "../benchmark-routing.ts";
import { qualifyBenchmarkProfiles, ROUTING_PROFILES } from "../benchmark-qualification.ts";
import type { BenchmarkSnapshot } from "../benchmark-types.ts";

const health = (id: string) => [{ id, status: "ok" as const, service: "chat", latencyMs: 1, tokensPerSecond: 1_000 }];
/** Capability-neutral candidate: only benchmark evidence can gate these profiles. */
const candidate = (id: string) => ({ id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 1_000_000 });

async function published() {
	const assets = await loadBenchmarkAssets(DEFAULT_SNAPSHOT_ROOT, 31_536_000_000);
	assert.ok(assets, "the published v4 benchmark artifact must load");
	const benchmarkHealth = await loadBenchmarkHealth(DEFAULT_SNAPSHOT_ROOT, 31_536_000_000);
	return { assets, benchmarkHealth: benchmarkHealth?.fields };
}

const snapshotId = (snapshot: BenchmarkSnapshot) => `${snapshot.provider}/${snapshot.model}/${snapshot.thinkingLevel ?? "generic"}`;

// The published generation is user data that changes with every reviewed sync, so these tests assert the
// contract between catalog qualification and runtime routing over whatever set is published, never a
// hardcoded model list or score literal.
test("every published snapshot routes for exactly the profiles it qualifies for", async () => {
	const { assets, benchmarkHealth } = await published();
	let qualifiedPairs = 0;
	for (const snapshot of assets.snapshots) {
		const id = `${snapshot.provider}/${snapshot.model}`;
		const profiles = ROUTING_PROFILES.filter((profile) => qualifyBenchmarkProfiles(candidate(id), snapshot, benchmarkHealth).some((entry) => entry.profile === profile && entry.qualified));
		for (const profile of ROUTING_PROFILES) {
			const route = routeBenchmarkModel(profile, [candidate(id)], [snapshot], health(id), assets.manifest.digest, snapshot.thinkingLevel ?? undefined, benchmarkHealth);
			if (profiles.includes(profile)) {
				qualifiedPairs++;
				assert.equal(route.modelId, id, `${profile} should route ${snapshotId(snapshot)}`);
			} else {
				assert.equal(route.modelId, undefined, `${profile} must not route ${snapshotId(snapshot)}`);
			}
		}
	}
	assert.ok(qualifiedPairs > 0, "a published generation must route at least one profile");
});

test("a published snapshot with too little counted evidence is rejected rather than guessed", async () => {
	const { assets, benchmarkHealth } = await published();
	const original = assets.snapshots[0]!;
	const id = `${original.provider}/${original.model}`;
	const sparse = { ...original, evidenceDensity: 2 };
	const qualification = qualifyBenchmarkProfiles(candidate(id), sparse, benchmarkHealth).find((entry) => entry.profile === "coding")!;
	assert.equal(qualification.reason, "insufficientEvidence");
	const route = routeBenchmarkModel("coding", [candidate(id)], [sparse], health(id), assets.manifest.digest, sparse.thinkingLevel ?? undefined, benchmarkHealth);
	assert.equal(route.modelId, undefined);
	assert.deepEqual(route.diagnostics.candidates[0]?.rejectionReasons, ["insufficientEvidence"]);
});

test("reviewed AA UUID routing is independent of the snapshot's legacy provider alias", async () => {
	const { assets, benchmarkHealth } = await published();
	const snapshot = assets.snapshots.find((entry) => qualifyBenchmarkProfiles(candidate(`${entry.provider}/${entry.model}`), entry, benchmarkHealth).some((profile) => profile.qualified));
	assert.ok(snapshot, "a published generation must contain at least one routable snapshot");
	const id = `${snapshot.provider}/${snapshot.model}`;
	const detached = { ...snapshot, provider: "legacy-provider", model: "legacy-alias" };
	const qualified = ROUTING_PROFILES.find((profile) => qualifyBenchmarkProfiles(candidate(id), snapshot, benchmarkHealth).some((entry) => entry.profile === profile && entry.qualified))!;
	const route = routeBenchmarkModel(qualified, [candidate(id)], [detached], health(id), assets.manifest.digest, snapshot.thinkingLevel ?? undefined, benchmarkHealth);
	assert.equal(route.modelId, id);
});
