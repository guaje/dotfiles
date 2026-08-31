import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizeModelMetadata } from "../model-metadata.ts";
import { writePackageStubs } from "./_stubs.ts";

writePackageStubs();
const modelSelectionModule = import("../model-selection.ts");

const source = readFileSync("agent/extensions/04-subagents/model-selection.ts", "utf8")
	+ readFileSync("agent/extensions/04-subagents/model-metadata.ts", "utf8");
test("model selection is benchmark orchestration with no LLM or name/size/quant routing", () => {
	assert.match(source, /loadBenchmarkAssets/);
	assert.match(source, /routeBenchmarkModel/);
	assert.doesNotMatch(source, /completeSimple|useLlmSelector|params|activeParams|quant|FP8|selectModelByKeyword/);
});
test("model metadata retains functional capabilities only", () => {
	assert.match(source, /reasoning\?: boolean/);
	assert.match(source, /supportsReasoningEffort\?: boolean/);
	assert.match(source, /contextWindow\?: number/);
	assert.match(source, /maxTokens\?: number/);
	assert.match(source, /thinkingLevelMap\?: Partial<Record<ThinkingLevel, string \| null>>/);
	assert.match(source, /scopedModels/);
	assert.doesNotMatch(source, /models-store\.json|settings\.config\.json|models\.json/);
	assert.doesNotMatch(source, /name\?: string/);
});

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
