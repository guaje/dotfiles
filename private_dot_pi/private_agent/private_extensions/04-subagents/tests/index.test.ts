// Run with: npx -y tsx --test agent/extensions/04-subagents/tests/index.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/04-subagents");
const MODULE_PATH = resolve(SUBAGENT_DIR, "index.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".index.testable.ts");
const AGENTS_STUB = resolve(SUBAGENT_DIR, ".index-agents-stub.ts");
const SPAWN_STUB = resolve(SUBAGENT_DIR, ".index-spawn-stub.ts");
const ROSTER_STUB = resolve(SUBAGENT_DIR, ".index-roster-stub.ts");
const ROSTER_SETTINGS_STUB = resolve(SUBAGENT_DIR, ".index-roster-settings-stub.ts");

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function flatten(comp: any): string {
	if (!comp) return "";
	if (Array.isArray(comp.children)) return comp.children.map(flatten).join("\n");
	if (typeof comp.text === "string") return comp.text;
	return "";
}

async function loadModule() {
	writePackageStubs();

	// Controllable discoverAgents via globalThis.__subagentDiscovery.
	writeFileSync(
		AGENTS_STUB,
		"export function discoverAgents() { return globalThis.__subagentDiscovery || { agents: [], projectAgentsDir: null }; }\n",
	);

	// Controllable runSingleAgent via globalThis.__subagentRunHandler.
	writeFileSync(
		SPAWN_STUB,
		[
			"export async function runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, models, sessionModelId) {",
			"  const h = globalThis.__subagentRunHandler;",
			"  if (h) return h({ defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, models, sessionModelId });",
			"  return { agent: agentName, agentSource: 'user', task, exitCode: 0, stopReason: 'end', messages: [], stderr: '', usage: { input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,contextTokens:0,turns:0 } };",
			"}",
		].join("\n"),
	);

	// Stub roster (pure) + roster-settings (pi internals) so the test exercises
	// index.ts orchestration in isolation.
	writeFileSync(
		ROSTER_STUB,
		[
			"export const DELEGATE_GUIDELINES = 'delegate guideline';",
			"export function buildRosterInjection() { return ''; }",
			"export function hasRosterSentinel() { return false; }",
		].join("\n"),
	);
	writeFileSync(
		ROSTER_SETTINGS_STUB,
		[
			"export async function getRosterSettings() { return { scope: 'user', cap: 10 }; }",
			"export async function refreshRosterSettingsCache() { return { scope: 'user', cap: 10 }; }",
			"export function patchSettingsMenuForRoster() { return Promise.resolve(); }",
		].join("\n"),
	);

	// Testable copy: stub out discovery + spawn + roster; keep real render/result/types.
	const source = readFileSync(MODULE_PATH, "utf8")
		.replace(/from "\.\/agents\.ts"/, 'from "./.index-agents-stub.ts"')
		.replace(/from "\.\/spawn\.ts"/, 'from "./.index-spawn-stub.ts"')
		.replace(/from "\.\/roster\.ts"/, 'from "./.index-roster-stub.ts"')
		.replace(/from "\.\/roster-settings\.ts"/, 'from "./.index-roster-settings-stub.ts"');
	writeFileSync(TESTABLE_PATH, source);

	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
	rmSync(AGENTS_STUB, { force: true });
	rmSync(SPAWN_STUB, { force: true });
	rmSync(ROSTER_STUB, { force: true });
	rmSync(ROSTER_SETTINGS_STUB, { force: true });
	delete (globalThis as any).__subagentDiscovery;
	delete (globalThis as any).__subagentRunHandler;
}

function captureTool(mod: any) {
	let tool: any = null;
	mod.default({ on: () => {}, registerTool: (t: any) => { tool = t; } });
	assert.ok(tool, "tool should be registered");
	return tool;
}

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const okResult = (agent: string, task: string, text: string) => ({
	agent,
	agentSource: "user",
	task,
	exitCode: 0,
	stopReason: "end",
	messages: [{ role: "assistant", content: [{ type: "text", text }] }],
	stderr: "",
	usage: emptyUsage,
});

test("registers the subagent tool with name, label, and the expected parameters", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	try {
		assert.equal(tool.name, "subagent");
		assert.equal(tool.label, "Subagent");
		const props = tool.parameters.properties;
		assert.ok(props.agent && props.task && props.tasks && props.chain && props.agentScope);
		assert.equal(props.useLlmSelector, undefined);
	} finally {
		cleanup();
	}
});

test("session start warns once when local benchmark snapshots are unavailable", async () => {
	const previousRoot = process.env.PI_AA_SNAPSHOT_ROOT;
	process.env.PI_AA_SNAPSHOT_ROOT = resolve("agent/extensions/04-subagents/tests/.missing-benchmark-root");
	const mod = await loadModule();
	const handlers: Record<string, Function> = {};
	const notifications: string[] = [];
	try {
		mod.default({
			on: (name: string, handler: Function) => { handlers[name] = handler; },
			registerTool: () => {},
		});
		const ctx = {
			hasUI: true,
			ui: {
				notify: (message: string) => notifications.push(message),
				setWidget: () => {},
			},
		};
		await handlers.session_start?.({}, ctx);
		await handlers.session_start?.({}, ctx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /--missing/);
	} finally {
		if (previousRoot === undefined) delete process.env.PI_AA_SNAPSHOT_ROOT;
		else process.env.PI_AA_SNAPSHOT_ROOT = previousRoot;
		cleanup();
	}
});

test("renderCall delegates to renderSubagentCall", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	try {
		const text = flatten(tool.renderCall({ agent: "scout", task: "find auth" }, theme, {}));
		assert.match(text, /subagent/);
		assert.match(text, /scout/);
		assert.match(text, /find auth/);
	} finally {
		cleanup();
	}
});

test("renderResult delegates to renderSubagentResult", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	try {
		const result = {
			content: [{ type: "text", text: "x" }],
			details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
		};
		const text = flatten(tool.renderResult(result, { expanded: false }, theme, {}));
		assert.equal(text, "x");
	} finally {
		cleanup();
	}
});

test("execute single mode returns the agent's final output", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	(globalThis as any).__subagentDiscovery = { agents: [], projectAgentsDir: null };
	(globalThis as any).__subagentRunHandler = ({ agentName }: any) => okResult(agentName, "find", "done");
	try {
		const out = await tool.execute("id", { agent: "scout", task: "find" }, undefined, undefined, {
			cwd: "/cwd",
			hasUI: false,
			ui: {},
		});
		assert.equal(out.content[0].text, "done");
		assert.equal(out.details.mode, "single");
	} finally {
		cleanup();
	}
});

test("execute chain mode substitutes {previous} and returns the last step's output", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	(globalThis as any).__subagentDiscovery = { agents: [], projectAgentsDir: null };
	const seen: any[] = [];
	(globalThis as any).__subagentRunHandler = ({ agentName, task, step }: any) => {
		seen.push({ agentName, task, step });
		return okResult(agentName, task, step === 1 ? "scout findings" : "the plan");
	};
	try {
		const out = await tool.execute(
			"id",
			{
				chain: [
					{ agent: "scout", task: "look around" },
					{ agent: "planner", task: "plan based on: {previous}" },
				],
			},
			undefined,
			undefined,
			{ cwd: "/cwd", hasUI: false, ui: {} },
		);
		assert.equal(out.content[0].text, "the plan");
		assert.equal(out.details.mode, "chain");
		assert.equal(out.details.results.length, 2);
		// Step 2 received step 1's output substituted into {previous}
		assert.equal(seen[1].task, "plan based on: scout findings");
	} finally {
		cleanup();
	}
});

test("execute chain stops and reports when a step fails", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	(globalThis as any).__subagentDiscovery = { agents: [], projectAgentsDir: null };
	(globalThis as any).__subagentRunHandler = ({ agentName, task, step }: any) => {
		if (step === 1)
			return { ...okResult(agentName, task, ""), exitCode: 1, stopReason: "error", errorMessage: "boom" };
		return okResult(agentName, task, "should not run");
	};
	try {
		const out = await tool.execute(
			"id",
			{ chain: [{ agent: "scout", task: "look" }, { agent: "planner", task: "plan" }] },
			undefined,
			undefined,
			{ cwd: "/cwd", hasUI: false, ui: {} },
		);
		assert.equal(out.isError, true);
		assert.match(out.content[0].text, /Chain stopped at step 1/);
		assert.match(out.content[0].text, /boom/);
	} finally {
		cleanup();
	}
});

test("execute parallel mode summarizes task outcomes", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	(globalThis as any).__subagentDiscovery = { agents: [], projectAgentsDir: null };
	(globalThis as any).__subagentRunHandler = ({ agentName, task }: any) => okResult(agentName, task, "ok");
	try {
		const out = await tool.execute(
			"id",
			{ tasks: [{ agent: "a", task: "t1" }, { agent: "b", task: "t2" }] },
			undefined,
			undefined,
			{ cwd: "/cwd", hasUI: false, ui: {} },
		);
		assert.match(out.content[0].text, /Parallel: 2\/2 succeeded/);
		assert.equal(out.details.mode, "parallel");
		assert.equal(out.details.results.length, 2);
	} finally {
		cleanup();
	}
});

test("every delegation mode forwards the model the session is actively using", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	(globalThis as any).__subagentDiscovery = { agents: [], projectAgentsDir: null };
	const forwarded: (string | undefined)[] = [];
	(globalThis as any).__subagentRunHandler = ({ agentName, sessionModelId }: any) => {
		forwarded.push(sessionModelId);
		return okResult(agentName, "find", "done");
	};
	const ctx = { cwd: "/cwd", hasUI: false, ui: {}, model: { provider: "prov", id: "session-model" } };
	try {
		await tool.execute("id", { agent: "scout", task: "find" }, undefined, undefined, ctx);
		await tool.execute("id", { chain: [{ agent: "scout", task: "look" }, { agent: "planner", task: "plan" }] }, undefined, undefined, ctx);
		await tool.execute("id", { tasks: [{ agent: "scout", task: "look" }, { agent: "worker", task: "build" }] }, undefined, undefined, ctx);
		// single (1) + chain (2 steps) + parallel (2 tasks)
		assert.equal(forwarded.length, 5, "every delegation mode must be able to inherit the session model");
		assert.deepEqual([...new Set(forwarded)], ["prov/session-model"]);
	} finally {
		cleanup();
	}
});

test("execute with no mode returns an invalid-parameters error", async () => {
	const mod = await loadModule();
	const tool = captureTool(mod);
	(globalThis as any).__subagentDiscovery = { agents: [], projectAgentsDir: null };
	let runCalled = false;
	(globalThis as any).__subagentRunHandler = () => {
		runCalled = true;
		return okResult("x", "", "");
	};
	try {
		const out = await tool.execute("id", { agent: "scout" }, undefined, undefined, {
			cwd: "/cwd",
			hasUI: false,
			ui: {},
		});
		assert.match(out.content[0].text, /Invalid parameters/);
		assert.equal(runCalled, false);
	} finally {
		cleanup();
	}
});

test("session start blames the policy generation when the policy file and code disagree", async () => {
	const previousRoot = process.env.PI_AA_SNAPSHOT_ROOT;
	const previousPolicy = process.env.PI_AA_ROUTING_POLICY;
	const root = mkdtempSync(join(tmpdir(), "pi-policy-warning-"));
	const policyPath = join(root, "routing-policy.json");
	writeFileSync(policyPath, JSON.stringify({ version: "6" }));
	process.env.PI_AA_ROUTING_POLICY = policyPath;
	try {
		const mod = await loadModule();
		const handlers: Record<string, Function> = {};
		const notifications: string[] = [];
		mod.default({ on: (name: string, handler: Function) => { handlers[name] = handler; }, registerTool: () => {} });
		const ctx = { hasUI: true, ui: { notify: (message: string) => notifications.push(message), setWidget: () => {} } };
		await handlers.session_start?.({}, ctx);
		await handlers.session_start?.({}, ctx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /generation 6/);
		assert.match(notifications[0], /model serving this conversation/);
		assert.doesNotMatch(notifications[0], /--missing/, "the snapshots are not the problem here");
	} finally {
		if (previousRoot === undefined) delete process.env.PI_AA_SNAPSHOT_ROOT; else process.env.PI_AA_SNAPSHOT_ROOT = previousRoot;
		if (previousPolicy === undefined) delete process.env.PI_AA_ROUTING_POLICY; else process.env.PI_AA_ROUTING_POLICY = previousPolicy;
		rmSync(root, { recursive: true, force: true });
		cleanup();
	}
});
