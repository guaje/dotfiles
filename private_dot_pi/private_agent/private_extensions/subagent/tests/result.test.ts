// Run with: npx -y tsx --test agent/extensions/subagent/tests/result.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagent");
const MODULE_PATH = resolve(SUBAGENT_DIR, "result.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".result.testable.ts");

async function loadModule() {
	writePackageStubs();
	// result.ts imports ./types.ts (real, resolves) and a type-only Message from pi-ai.
	writeFileSync(TESTABLE_PATH, readFileSync(MODULE_PATH, "utf8"));
	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
}

const msg = (role: string, content: any[]) => ({ role, content });

test("getFinalOutput returns the last assistant text part", async () => {
	const mod = await loadModule();
	try {
		const messages = [
			msg("assistant", [{ type: "text", text: "first" }]),
			msg("toolResult", [{ type: "toolResult", toolCallId: "1", content: [] }]),
			msg("assistant", [{ type: "text", text: "final answer" }]),
		];
		assert.equal(mod.getFinalOutput(messages), "final answer");
		assert.equal(mod.getFinalOutput([]), "");
	} finally {
		cleanup();
	}
});

test("isFailedResult flags non-zero exit, error, and aborted", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.isFailedResult({ exitCode: 1, stopReason: "end" }), true);
		assert.equal(mod.isFailedResult({ exitCode: 0, stopReason: "error" }), true);
		assert.equal(mod.isFailedResult({ exitCode: 0, stopReason: "aborted" }), true);
		assert.equal(mod.isFailedResult({ exitCode: 0, stopReason: "end" }), false);
	} finally {
		cleanup();
	}
});

test("getResultOutput prefers errorMessage/stderr on failure, else final output", async () => {
	const mod = await loadModule();
	try {
		const ok = {
			exitCode: 0,
			stopReason: "end",
			messages: [msg("assistant", [{ type: "text", text: "done" }])],
			stderr: "",
		};
		assert.equal(mod.getResultOutput(ok), "done");

		const failed = {
			exitCode: 1,
			stopReason: "error",
			errorMessage: "boom",
			messages: [msg("assistant", [{ type: "text", text: "partial" }])],
			stderr: "some stderr",
		};
		assert.equal(mod.getResultOutput(failed), "boom");

		const failedNoMsg = { exitCode: 1, stopReason: "error", messages: [], stderr: "err out" };
		assert.equal(mod.getResultOutput(failedNoMsg), "err out");

		const empty = { exitCode: 0, stopReason: "end", messages: [], stderr: "" };
		assert.equal(mod.getResultOutput(empty), "(no output)");
	} finally {
		cleanup();
	}
});

test("truncateParallelOutput leaves small output intact and truncates large output", async () => {
	const mod = await loadModule();
	try {
		const small = "hello world";
		assert.equal(mod.truncateParallelOutput(small), small);

		// PER_TASK_OUTPUT_CAP is 50 * 1024 bytes.
		const big = "x".repeat(60 * 1024);
		const truncated = mod.truncateParallelOutput(big);
		assert.ok(truncated.length < big.length, "large output should be truncated");
		assert.match(truncated, /\[Output truncated:/);
	} finally {
		cleanup();
	}
});

test("getDisplayItems extracts text and toolCall items from assistant messages", async () => {
	const mod = await loadModule();
	try {
		const messages = [
			msg("assistant", [
				{ type: "text", text: "thinking..." },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			]),
			msg("assistant", [{ type: "text", text: "done" }]),
		];
		const items = mod.getDisplayItems(messages);
		assert.equal(items.length, 3);
		assert.equal(items[0].type, "text");
		assert.equal(items[1].type, "toolCall");
		assert.equal(items[1].name, "bash");
		assert.equal(items[2].text, "done");
	} finally {
		cleanup();
	}
});

test("mapWithConcurrencyLimit preserves order and respects the concurrency limit", async () => {
	const mod = await loadModule();
	try {
		let active = 0;
		let maxActive = 0;
		const items = [1, 2, 3, 4, 5];
		const results = await mod.mapWithConcurrencyLimit(items, 2, async (item) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 10));
			active--;
			return item * 10;
		});
		assert.deepEqual(results, [10, 20, 30, 40, 50]);
		assert.ok(maxActive <= 2, `max concurrency exceeded: ${maxActive}`);
		assert.ok(maxActive >= 2, `expected at least 2 concurrent: ${maxActive}`);
	} finally {
		cleanup();
	}
});
