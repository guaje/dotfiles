import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SNAPSHOT_ROOT, loadBenchmarkAssets } from "../benchmark-assets.ts";
import { routeBenchmarkModel } from "../benchmark-routing.ts";

const health = (id: string) => [{ id, status: "ok", service: "chat", latencyMs: 1, tokensPerSecond: 1_000 }];
const candidate = (id: string) => [{ id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"], contextWindow: 262_144, maxTokens: 262_144 }];

async function realSnapshots() {
	const assets = await loadBenchmarkAssets(DEFAULT_SNAPSHOT_ROOT, 31_536_000_000);
	assert.ok(assets, "the checked-in v4 benchmark artifact must load");
	return assets;
}

for (const model of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
	for (const thinking of ["low", "medium", "high", "xhigh", "max"] as const) {
		test(`${model} ${thinking} is eligible for research and review`, async () => {
			const assets = await realSnapshots();
			const id = `openai-codex/${model}`;
			const snapshot = assets.snapshots.find((entry) => entry.provider === "openai-codex" && entry.model === model && entry.thinkingLevel === thinking);
			assert.ok(snapshot, `${id}/${thinking} artifact is required`);
			for (const profile of ["research", "review"] as const) {
				const route = routeBenchmarkModel(profile, candidate(id), [snapshot], health(id), assets.manifest.digest, thinking);
				assert.equal(route.modelId, id, `${profile} should route ${id}/${thinking}`);
			}
		});
	}
}

test("Kimi-K2.7-Code is benchmark-selectable for its eligible profiles", async () => {
	const assets = await realSnapshots();
	const id = "reallms-dev/Kimi-K2.7-Code";
	const snapshot = assets.snapshots.find((entry) => entry.provider === "reallms-dev" && entry.model === "Kimi-K2.7-Code" && entry.thinkingLevel === null);
	assert.ok(snapshot, `${id} artifact is required`);
	assert.equal(snapshot.scores.coding, 60.8);
	const kimi = [{ id, reasoning: true, input: ["text", "image"], contextWindow: 131_072, maxTokens: 163_840, supportsReasoningEffort: false }];
	for (const profile of ["balanced", "coding", "research", "planning", "review", "long-context"] as const) {
		const route = routeBenchmarkModel(profile, kimi, [snapshot], health(id), assets.manifest.digest);
		assert.equal(route.modelId, id, `${profile} should route ${id}`);
	}
	const agentic = routeBenchmarkModel("agentic", kimi, [snapshot], health(id), assets.manifest.digest);
	assert.equal(agentic.modelId, undefined);
	assert.deepEqual(agentic.diagnostics.candidates[0]?.rejectionReasons, ["mandatoryFloor"]);
});

test("reviewed canonical AA UUID routing is independent of the snapshot's legacy provider alias", async () => {
	const assets = await realSnapshots();
	const id = "reallms-dev/Kimi-K2.7-Code";
	const snapshot = assets.snapshots.find((entry) => entry.provider === "reallms-dev" && entry.model === "Kimi-K2.7-Code" && entry.thinkingLevel === null);
	assert.ok(snapshot);
	const detached = { ...snapshot, provider: "legacy-provider", model: "legacy-alias" };
	const route = routeBenchmarkModel("coding", candidate(id), [detached], health(id), assets.manifest.digest);
	assert.equal(route.modelId, id);
});

for (const [id, thinking] of [["openai-codex/gpt-5.6-luna", "high"], ["reallms-dev/DeepSeek-V4-Flash-API", undefined]] as const) {
	test(`${id} remains research-eligible but review rejects missing instruction following`, async () => {
		const assets = await realSnapshots();
		const [provider, model] = id.split("/");
		const snapshot = assets.snapshots.find((entry) => entry.provider === provider && entry.model === model && entry.thinkingLevel === (thinking ?? null));
		assert.ok(snapshot, `${id} artifact is required`);
		assert.equal(snapshot.scores.instructionFollowing, null);
		for (const profile of ["balanced", "coding", "agentic", "research", "long-context"] as const) {
			const route = routeBenchmarkModel(profile, candidate(id), [snapshot], health(id), assets.manifest.digest, thinking);
			assert.equal(route.modelId, id, `${profile} should route ${id}`);
		}
		for (const profile of ["planning", "review"] as const) {
			const route = routeBenchmarkModel(profile, candidate(id), [snapshot], health(id), assets.manifest.digest, thinking);
			assert.equal(route.modelId, undefined);
			assert.deepEqual(route.diagnostics.candidates[0]?.rejectionReasons, ["missingRequiredDimension"]);
		}
	});
}
