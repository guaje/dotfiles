// Run with: npx -y tsx --test agent/extensions/04-subagents/tests/widget.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/04-subagents");
const MODULE_PATH = resolve(SUBAGENT_DIR, "widget.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".widget.testable.ts");

async function loadModule() {
	writePackageStubs();
	// widget.ts has only a type-only import of ./types.ts (erased at runtime); verbatim copy is fine.
	writeFileSync(TESTABLE_PATH, readFileSync(MODULE_PATH, "utf8"));
	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
}

// Passthrough theme: colors/bold are no-ops so icons and labels pass through verbatim.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

type Entry = { agent: string; exitCode: number; step?: number };

/** Build a SubagentWidgetState directly (bypasses detailsToWidgetState). */
function state(mode: "single" | "parallel" | "chain", results: Entry[]) {
	return { mode, results };
}

/** Build a full SingleResult for detailsToWidgetState inputs. */
function fullResult(agent: string, exitCode: number, step?: number) {
	return {
		agent,
		agentSource: "user" as const,
		task: "t",
		exitCode,
		messages: [],
		stderr: "",
		usage: zeroUsage,
		step,
	};
}

// --- detailsToWidgetState ---

test("detailsToWidgetState preserves mode and maps results to minimal entries", async () => {
	const mod = await loadModule();
	try {
		const ws = mod.detailsToWidgetState({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [fullResult("scout", 0)],
		});
		assert.equal(ws.mode, "single");
		assert.deepEqual(Object.keys(ws).sort(), ["mode", "results"]);
		assert.equal(ws.results.length, 1);
		assert.deepEqual(ws.results[0], { agent: "scout", exitCode: 0, step: undefined });
	} finally {
		cleanup();
	}
});

test("detailsToWidgetState preserves step numbers for chain results", async () => {
	const mod = await loadModule();
	try {
		const ws = mod.detailsToWidgetState({
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [fullResult("scout", 0, 1), fullResult("worker", 0, 2)],
		});
		assert.equal(ws.results[0].step, 1);
		assert.equal(ws.results[1].step, 2);
	} finally {
		cleanup();
	}
});

test("detailsToWidgetState drops task, messages, usage, model and other fields", async () => {
	const mod = await loadModule();
	try {
		const ws = mod.detailsToWidgetState({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [fullResult("scout", 0)],
		});
		assert.deepEqual(Object.keys(ws.results[0]).sort(), ["agent", "exitCode", "step"]);
	} finally {
		cleanup();
	}
});

// --- renderSubagentWidget: auto-hide ---

test("renderSubagentWidget auto-hides (returns []) for null state", async () => {
	const mod = await loadModule();
	try {
		assert.deepEqual(mod.renderSubagentWidget(null, theme), []);
	} finally {
		cleanup();
	}
});

test("renderSubagentWidget auto-hides (returns []) for empty results", async () => {
	const mod = await loadModule();
	try {
		assert.deepEqual(mod.renderSubagentWidget(state("single", []), theme), []);
	} finally {
		cleanup();
	}
});

// --- renderSubagentWidget: per-status icons and header counts ---

test("single running shows 1 running in header and the running icon per agent", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(state("single", [{ agent: "scout", exitCode: -1 }]), theme);
		assert.equal(lines.length, 2);
		assert.match(lines[0], /subagents/);
		assert.match(lines[0], /⏳ 1 running/);
		assert.doesNotMatch(lines[0], /done|failed/);
		assert.match(lines[1], /⏳ scout/);
	} finally {
		cleanup();
	}
});

test("single done shows 1 done in header and the success icon per agent", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(state("single", [{ agent: "scout", exitCode: 0 }]), theme);
		assert.match(lines[0], /✓ 1 done/);
		assert.match(lines[1], /✓ scout/);
	} finally {
		cleanup();
	}
});

test("single failed shows 1 failed in header and the error icon per agent", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(state("single", [{ agent: "scout", exitCode: 1 }]), theme);
		assert.match(lines[0], /✗ 1 failed/);
		assert.match(lines[1], /✗ scout/);
	} finally {
		cleanup();
	}
});

test("any non-zero, non-negative-one exit code counts as failed", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(state("single", [{ agent: "boom", exitCode: 2 }]), theme);
		assert.match(lines[0], /✗ 1 failed/);
		assert.match(lines[1], /✗ boom/);
	} finally {
		cleanup();
	}
});

// --- renderSubagentWidget: mode labels and step prefixes ---

test("parallel mode tags the header with (parallel) and omits step prefixes", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(
			state("parallel", [
				{ agent: "a", exitCode: 0 },
				{ agent: "b", exitCode: -1 },
			]),
			theme,
		);
		assert.match(lines[0], /\(parallel\)/);
		assert.match(lines[0], /✓ 1 done/);
		assert.match(lines[0], /⏳ 1 running/);
		// per-agent lines carry no "N." step prefix in parallel
		assert.doesNotMatch(lines[1], /\d+\./);
	} finally {
		cleanup();
	}
});

test("chain mode tags the header with (chain) and prefixes per-agent lines with step numbers", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(
			state("chain", [
				{ agent: "scout", exitCode: 0, step: 1 },
				{ agent: "worker", exitCode: -1, step: 2 },
			]),
			theme,
		);
		assert.match(lines[0], /\(chain\)/);
		assert.equal(lines.length, 3); // header + 2 agents
		assert.match(lines[1], /1\.\s+✓ scout/);
		assert.match(lines[2], /2\.\s+⏳ worker/);
	} finally {
		cleanup();
	}
});

// --- renderSubagentWidget: mixed states ---

test("mixed states surface running, done, and failed counts and preserve result order", async () => {
	const mod = await loadModule();
	try {
		const lines = mod.renderSubagentWidget(
			state("parallel", [
				{ agent: "a", exitCode: -1 },
				{ agent: "b", exitCode: 0 },
				{ agent: "c", exitCode: 1 },
			]),
			theme,
		);
		assert.match(lines[0], /⏳ 1 running/);
		assert.match(lines[0], /✓ 1 done/);
		assert.match(lines[0], /✗ 1 failed/);
		// per-agent lines preserve original order: a running, b done, c failed
		assert.match(lines[1], /⏳ a/);
		assert.match(lines[2], /✓ b/);
		assert.match(lines[3], /✗ c/);
	} finally {
		cleanup();
	}
});

// --- round-trip: detailsToWidgetState -> renderSubagentWidget ---

test("detailsToWidgetState output renders through renderSubagentWidget", async () => {
	const mod = await loadModule();
	try {
		const ws = mod.detailsToWidgetState({
			mode: "chain",
			agentScope: "user",
			projectAgentsDir: null,
			results: [fullResult("scout", 0, 1), fullResult("worker", 1, 2)],
		});
		const lines = mod.renderSubagentWidget(ws, theme);
		assert.match(lines[0], /\(chain\)/);
		assert.match(lines[0], /✓ 1 done/);
		assert.match(lines[0], /✗ 1 failed/);
		assert.match(lines[1], /1\.\s+✓ scout/);
		assert.match(lines[2], /2\.\s+✗ worker/);
	} finally {
		cleanup();
	}
});

// --- theme contract: color tokens ---

test("renderSubagentWidget uses the expected color tokens and bolds the header label", async () => {
	const mod = await loadModule();
	try {
		const fgCalls: { color: string; text: string }[] = [];
		const boldCalls: string[] = [];
		const recTheme = {
			fg: (color: string, text: string) => {
				fgCalls.push({ color, text });
				return text;
			},
			bold: (text: string) => {
				boldCalls.push(text);
				return text;
			},
		};
		mod.renderSubagentWidget(
			state("chain", [
				{ agent: "scout", exitCode: -1, step: 1 }, // running -> warning
				{ agent: "worker", exitCode: 0, step: 2 }, // done -> success
				{ agent: "reviewer", exitCode: 1, step: 3 }, // failed -> error
			]),
			recTheme,
		);
		const colors = new Set(fgCalls.map((c) => c.color));
		assert.ok(colors.has("toolTitle"), "header label uses toolTitle");
		assert.ok(colors.has("dim"), "mode label and step number use dim");
		assert.ok(colors.has("warning"), "running uses warning");
		assert.ok(colors.has("success"), "done uses success");
		assert.ok(colors.has("error"), "failed uses error");
		assert.ok(colors.has("accent"), "agent name uses accent");
		assert.ok(boldCalls.includes("subagents"), "header label is bolded");
	} finally {
		cleanup();
	}
});
