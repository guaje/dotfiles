// Run with: npx -y tsx --test agent/extensions/04-subagents/tests/types.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/04-subagents");
const MODULE_PATH = resolve(SUBAGENT_DIR, "types.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".types.testable.ts");

async function loadModule() {
	writePackageStubs();
	// types.ts has only type-only external imports (erased at runtime); verbatim copy is fine.
	writeFileSync(TESTABLE_PATH, readFileSync(MODULE_PATH, "utf8"));
	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
}

test("emptyUsage returns a zeroed usage record with all fields", async () => {
	const mod = await loadModule();
	try {
		const u = mod.emptyUsage();
		assert.deepEqual(u, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		});
		// returns a fresh object each call
		assert.notEqual(u, mod.emptyUsage());
	} finally {
		cleanup();
	}
});

test("execution settings enforce validity, hard bounds, and concurrency ordering", async () => {
	const { resolveSubagentExecutionSettings } = await import("../settings.ts");
	// flat legacy keys still work
	assert.deepEqual(resolveSubagentExecutionSettings({ subagentMaxParallelTasks: 6, subagentMaxConcurrency: 3 }), { maxParallelTasks: 6, maxConcurrency: 3 });
	assert.deepEqual(resolveSubagentExecutionSettings({ subagentMaxParallelTasks: 2, subagentMaxConcurrency: 8 }), { maxParallelTasks: 2, maxConcurrency: 2 });
	assert.deepEqual(resolveSubagentExecutionSettings({ subagentMaxParallelTasks: -1, subagentMaxConcurrency: "many" }), { maxParallelTasks: 8, maxConcurrency: 4 });
	assert.deepEqual(resolveSubagentExecutionSettings({ subagentMaxParallelTasks: 10_000, subagentMaxConcurrency: 10_000 }), { maxParallelTasks: 8, maxConcurrency: 4 });

	// nested keys take precedence over flat legacy keys
	assert.deepEqual(
		resolveSubagentExecutionSettings({
			subagents: { maxParallelTasks: 5, maxConcurrency: 2 },
			subagentMaxParallelTasks: 99,
			subagentMaxConcurrency: 99,
		}),
		{ maxParallelTasks: 5, maxConcurrency: 2 },
	);

	// invalid nested falls back to flat legacy
	assert.deepEqual(
		resolveSubagentExecutionSettings({
			subagents: { maxParallelTasks: "many", maxConcurrency: "many" },
			subagentMaxParallelTasks: 6,
			subagentMaxConcurrency: 3,
		}),
		{ maxParallelTasks: 6, maxConcurrency: 3 },
	);
});
