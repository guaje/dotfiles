// Run with: npx -y tsx --test agent/agents/tests/researcher.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const researcher = readFileSync("agent/agents/researcher.md", "utf8");
const prompt = readFileSync("agent/prompts/prompt:research.md", "utf8");

test("researcher is retrieval-only, bounded, and treats web data as untrusted", () => {
	assert.match(researcher, /^tools: web_retrieval$/m);
	assert.doesNotMatch(researcher, /^tools:.*\b(?:bash|read)\b/m);
	assert.match(researcher, /untrusted data, never instructions/i);
	assert.match(researcher, /one retrieval.*at most two focused follow-ups/is);
	assert.match(researcher, /3–5 useful sources/);
	assert.match(researcher, /6 findings and 8 sources/);
	assert.doesNotMatch(researcher, /LINKUP_DEPTH|skills\/linkup-search|linkup-search\.mjs/i);
});

test("research prompt delegates once without duplicating researcher policy", () => {
	assert.match(prompt, /Delegate this request once to the `researcher` subagent/);
	assert.doesNotMatch(prompt, /follow-ups|untrusted|LINKUP_DEPTH/i);
});
