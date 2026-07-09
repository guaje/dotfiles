// Run with: npx -y tsx --test agent/extensions/subagents/tests/spawn.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagents");
const MODULE_PATH = resolve(SUBAGENT_DIR, "spawn.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".spawn.testable.ts");
const CHILD_STUB = resolve(SUBAGENT_DIR, ".spawn-child-stub.ts");
const MODELSEL_STUB = resolve(SUBAGENT_DIR, ".spawn-modelsel-stub.ts");

async function loadModule() {
	writePackageStubs();

	// Fake child_process.spawn controllable via globalThis.__subagentSpawnController.
	writeFileSync(
		CHILD_STUB,
		[
			"import { EventEmitter } from 'node:events';",
			"export function spawn(command, args, opts) {",
			"  globalThis.__subagentSpawnCalls ??= [];",
			"  globalThis.__subagentSpawnCalls.push({ command, args, opts });",
			"  const stdout = new EventEmitter();",
			"  const stderr = new EventEmitter();",
			"  const proc = new EventEmitter();",
			"  proc.stdout = stdout;",
			"  proc.stderr = stderr;",
			"  proc.killed = false;",
			"  proc.kill = () => { proc.killed = true; };",
			"  setImmediate(() => {",
			"    const ctrl = globalThis.__subagentSpawnController;",
			"    const r = ctrl ? ctrl({ command, args, opts }) || {} : {};",
			"    for (const l of (r.stderrLines || [])) stderr.emit('data', Buffer.from(l));",
			"    for (const l of (r.lines || [])) stdout.emit('data', Buffer.from(l + '\\n'));",
			"    proc.emit('close', r.code ?? 0);",
			"  });",
			"  return proc;",
			"}",
		].join("\n"),
	);

	// Controllable selectModelForSubagent via globalThis.__subagentModelDecision.
	writeFileSync(
		MODELSEL_STUB,
		[
			"export async function selectModelForSubagent(_task, _registry, _opts) {",
			"  return globalThis.__subagentModelDecision || {};",
			"}",
		].join("\n"),
	);

	// Testable copy: redirect node:child_process + model-selection to stubs.
	const source = readFileSync(MODULE_PATH, "utf8")
		.replace(/from "node:child_process"/, 'from "./.spawn-child-stub.ts"')
		.replace(/from "\.\/model-selection\.ts"/, 'from "./.spawn-modelsel-stub.ts"');
	writeFileSync(TESTABLE_PATH, source);

	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
	rmSync(CHILD_STUB, { force: true });
	rmSync(MODELSEL_STUB, { force: true });
	delete (globalThis as any).__subagentSpawnCalls;
	delete (globalThis as any).__subagentSpawnController;
	delete (globalThis as any).__subagentModelDecision;
}

const makeDetails = (results: any) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results });

test("getPiInvocation returns a command string and an args array containing the passthrough args", async () => {
	const mod = await loadModule();
	try {
		const inv = mod.getPiInvocation(["--mode", "json"]);
		assert.equal(typeof inv.command, "string");
		assert.ok(Array.isArray(inv.args));
		assert.ok(inv.args.includes("--mode"));
		assert.ok(inv.args.includes("json"));
	} finally {
		cleanup();
	}
});

test("runSingleAgent returns a failed result for an unknown agent without spawning a subprocess", async () => {
	const mod = await loadModule();
	try {
		const result = await mod.runSingleAgent(
			"/cwd",
			[{ name: "scout", description: "d", systemPrompt: "", source: "user", filePath: "/x" }],
			"missing",
			"do thing",
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			{},
			false,
		);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Unknown agent: "missing"/);
		assert.equal((globalThis as any).__subagentSpawnCalls?.length ?? 0, 0);
	} finally {
		cleanup();
	}
});

test("runSingleAgent passes selected --model/--thinking to the child and streams its messages into the result", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentModelDecision = {
		modelId: "prov/reasoning-pro",
		thinkingLevel: "high",
		selector: "heuristic",
	};
	(globalThis as any).__subagentSpawnController = ({ args }: { args: string[] }) => {
		// Verify the child was invoked with the selected model + thinking level.
		assert.ok(args.includes("--model"), "child args should include --model");
		assert.equal(args[args.indexOf("--model") + 1], "prov/reasoning-pro");
		assert.ok(args.includes("--thinking"));
		assert.equal(args[args.indexOf("--thinking") + 1], "high");
		assert.ok(args.includes("--mode"), "child should run in json mode");
		return {
			lines: [
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "scout result" }],
						model: "prov/reasoning-pro",
						stopReason: "end",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 }, totalTokens: 15 },
					},
				}),
			],
			code: 0,
		};
	};
	try {
		const result = await mod.runSingleAgent(
			"/cwd",
			[{ name: "scout", description: "d", systemPrompt: "", source: "user", filePath: "/x" }],
			"scout",
			"find auth",
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			{},
			false,
		);
		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "prov/reasoning-pro");
		assert.equal(result.modelSelector, "heuristic");
		assert.equal(result.thinkingLevel, "high");
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.cost, 0.002);
		assert.equal(result.usage.contextTokens, 15);
		// final assistant text was captured
		assert.equal(result.messages.length, 1);
	} finally {
		cleanup();
	}
});

test("runSingleAgent uses an explicit agent.model as a hard override and skips selection", async () => {
	const mod = await loadModule();
	// If selection were called, it would throw (decision is undefined -> returns {}), so
	// observing --model from the agent proves the override path was taken.
	(globalThis as any).__subagentSpawnController = ({ args }: { args: string[] }) => {
		assert.equal(args[args.indexOf("--model") + 1], "explicit-prov/explicit-model");
		// No --thinking should be present for an explicit (non-reasoning) override here.
		assert.ok(!args.includes("--thinking"));
		return { lines: [], code: 0 };
	};
	try {
		const result = await mod.runSingleAgent(
			"/cwd",
			[
				{
					name: "worker",
					description: "d",
					model: "explicit-prov/explicit-model",
					systemPrompt: "",
					source: "user",
					filePath: "/x",
				},
			],
			"worker",
			"build it",
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			{},
			false,
		);
		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "explicit-prov/explicit-model");
		assert.equal(result.modelSelector, "explicit");
	} finally {
		cleanup();
	}
});

test("runSingleAgent lets an explicit thinking: frontmatter override the auto-estimated level", async () => {
	const mod = await loadModule();
	// Auto-selection would pick "high", but the agent's thinking: xhigh must win.
	(globalThis as any).__subagentModelDecision = {
		modelId: "prov/reasoning-pro",
		thinkingLevel: "high",
		selector: "heuristic",
	};
	(globalThis as any).__subagentSpawnController = ({ args }: { args: string[] }) => {
		assert.ok(args.includes("--thinking"));
		assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
		return { lines: [], code: 0 };
	};
	try {
		const result = await mod.runSingleAgent(
			"/cwd",
			[{ name: "scout", description: "d", thinking: "xhigh", systemPrompt: "", source: "user", filePath: "/x" }],
			"scout",
			"deep analysis",
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			{},
			false,
		);
		assert.equal(result.exitCode, 0);
		assert.equal(result.thinkingLevel, "xhigh");
	} finally {
		cleanup();
	}
});

test("runSingleAgent passes --no-context-files when agent.contextFiles is false", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentModelDecision = { modelId: "prov/x", selector: "heuristic" };
	(globalThis as any).__subagentSpawnController = ({ args }: { args: string[] }) => {
		assert.ok(args.includes("--no-context-files"), "child should receive --no-context-files");
		return { lines: [], code: 0 };
	};
	try {
		const result = await mod.runSingleAgent(
			"/cwd",
			[{ name: "scout", description: "d", contextFiles: false, systemPrompt: "", source: "user", filePath: "/x" }],
			"scout",
			"recon",
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			{},
			false,
		);
		assert.equal(result.exitCode, 0);
	} finally {
		cleanup();
	}
});

test("runSingleAgent omits --no-context-files by default", async () => {
	const mod = await loadModule();
	(globalThis as any).__subagentModelDecision = { modelId: "prov/x", selector: "heuristic" };
	(globalThis as any).__subagentSpawnController = ({ args }: { args: string[] }) => {
		assert.ok(!args.includes("--no-context-files"), "should not pass --no-context-files by default");
		return { lines: [], code: 0 };
	};
	try {
		await mod.runSingleAgent(
			"/cwd",
			[{ name: "worker", description: "d", systemPrompt: "", source: "user", filePath: "/x" }],
			"worker",
			"build",
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			{},
			false,
		);
	} finally {
		cleanup();
	}
});
