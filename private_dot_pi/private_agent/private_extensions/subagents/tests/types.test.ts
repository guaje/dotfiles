// Run with: npx -y tsx --test agent/extensions/subagents/tests/types.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagents");
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

test("tuning constants are exported with expected values", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.MAX_PARALLEL_TASKS, 8);
		assert.equal(mod.MAX_CONCURRENCY, 4);
		assert.equal(mod.COLLAPSED_ITEM_COUNT, 10);
		assert.equal(mod.PER_TASK_OUTPUT_CAP, 50 * 1024);
	} finally {
		cleanup();
	}
});
