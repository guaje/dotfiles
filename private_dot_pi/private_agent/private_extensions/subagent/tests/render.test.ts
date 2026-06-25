// Run with: npx -y tsx --test agent/extensions/subagent/tests/render.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagent");
const MODULE_PATH = resolve(SUBAGENT_DIR, "render.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".render.testable.ts");

async function loadModule() {
	writePackageStubs();
	// render.ts imports ./result.ts and ./types.ts (real, resolve) plus stubbed pi-tui/pi-coding-agent.
	writeFileSync(TESTABLE_PATH, readFileSync(MODULE_PATH, "utf8"));
	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function flatten(comp: any): string {
	if (!comp) return "";
	if (Array.isArray(comp.children)) return comp.children.map(flatten).join("\n");
	if (typeof comp.text === "string") return comp.text;
	return "";
}

test("formatTokens formats counts compactly", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.formatTokens(999), "999");
		assert.equal(mod.formatTokens(1500), "1.5k");
		assert.equal(mod.formatTokens(15000), "15k");
		assert.equal(mod.formatTokens(1_500_000), "1.5M");
	} finally {
		cleanup();
	}
});

test("formatUsageStats assembles usage parts and the model label", async () => {
	const mod = await loadModule();
	try {
		const usage = { input: 1500, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 3 };
		const str = mod.formatUsageStats(usage, "prov/m");
		assert.match(str, /3 turns/);
		assert.match(str, /↑1\.5k/);
		assert.match(str, /↓500/);
		assert.match(str, /\$0\.0200/);
		assert.match(str, /prov\/m/);
		// contextTokens only shown when > 0
		assert.doesNotMatch(str, /ctx:/);

		const withCtx = mod.formatUsageStats({ ...usage, contextTokens: 90000 }, "prov/m");
		assert.match(withCtx, /ctx:90k/);
	} finally {
		cleanup();
	}
});

test("modelDisplayFor appends thinking level when set", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.modelDisplayFor({ model: undefined }), undefined);
		assert.equal(mod.modelDisplayFor({ model: "prov/m" }), "prov/m");
		assert.equal(mod.modelDisplayFor({ model: "prov/m", thinkingLevel: "high" }), "prov/m • high");
	} finally {
		cleanup();
	}
});

test("formatToolCall renders bash, read, and unknown tools", async () => {
	const mod = await loadModule();
	try {
		const fg = (_c: string, t: string) => t;
		assert.match(mod.formatToolCall("bash", { command: "ls -la" }, fg), /\$ ls -la/);
		assert.match(mod.formatToolCall("read", { path: "/tmp/foo.ts" }, fg), /read .*\/tmp\/foo\.ts/);
		const unknown = mod.formatToolCall("custom", { x: 1 }, fg);
		assert.match(unknown, /custom/);
	} finally {
		cleanup();
	}
});

test("renderSubagentCall single mode shows agent + task preview", async () => {
	const mod = await loadModule();
	try {
		const comp = mod.renderSubagentCall({ agent: "scout", task: "find the auth code" }, theme);
		assert.match(flatten(comp), /subagent/);
		assert.match(flatten(comp), /scout/);
		assert.match(flatten(comp), /find the auth code/);
	} finally {
		cleanup();
	}
});

test("renderSubagentCall tags the llm selector when requested", async () => {
	const mod = await loadModule();
	try {
		const plain = flatten(mod.renderSubagentCall({ agent: "scout", task: "x" }, theme));
		assert.doesNotMatch(plain, /\bllm\b/);
		const llm = flatten(mod.renderSubagentCall({ agent: "scout", task: "x", useLlmSelector: true }, theme));
		assert.match(llm, /\bllm\b/);
	} finally {
		cleanup();
	}
});

test("renderSubagentCall parallel and chain modes show counts and agents", async () => {
	const mod = await loadModule();
	try {
		const parallel = flatten(
			mod.renderSubagentCall({ tasks: [{ agent: "a", task: "t1" }, { agent: "b", task: "t2" }] }, theme),
		);
		assert.match(parallel, /parallel \(2 tasks\)/);
		assert.match(parallel, /a/);
		assert.match(parallel, /b/);

		const chain = flatten(
			mod.renderSubagentCall(
				{ chain: [{ agent: "a", task: "do {previous}" }, { agent: "b", task: "then" }] },
				theme,
			),
		);
		assert.match(chain, /chain \(2 steps\)/);
		assert.match(chain, /a/);
		assert.match(chain, /b/);
		// {previous} placeholder is cleaned for display
		assert.doesNotMatch(chain, /\{previous\}/);
	} finally {
		cleanup();
	}
});

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 };
const okResult = {
	content: [{ type: "text", text: "ok" }],
	details: {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [
			{
				agent: "scout",
				agentSource: "user",
				task: "find auth",
				exitCode: 0,
				stopReason: "end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "found it" }] }],
				stderr: "",
				usage,
				model: "prov/x",
				modelSelector: "heuristic",
			},
		],
	},
};
const errResult = {
	content: [{ type: "text", text: "failed" }],
	details: {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [
			{
				agent: "scout",
				agentSource: "user",
				task: "find auth",
				exitCode: 1,
				stopReason: "error",
				errorMessage: "boom",
				messages: [],
				stderr: "",
				usage,
				model: "prov/x",
			},
		],
	},
};

test("renderSubagentResult single collapsed shows success icon, agent, and usage", async () => {
	const mod = await loadModule();
	try {
		const text = flatten(mod.renderSubagentResult(okResult, { expanded: false }, theme));
		assert.match(text, /✓/);
		assert.match(text, /scout/);
		assert.match(text, /prov\/x/);
	} finally {
		cleanup();
	}
});

test("renderSubagentResult single collapsed shows error icon and message on failure", async () => {
	const mod = await loadModule();
	try {
		const text = flatten(mod.renderSubagentResult(errResult, { expanded: false }, theme));
		assert.match(text, /✗/);
		assert.match(text, /Error: boom/);
	} finally {
		cleanup();
	}
});

test("renderSubagentResult single expanded shows task and output sections", async () => {
	const mod = await loadModule();
	try {
		const text = flatten(mod.renderSubagentResult(okResult, { expanded: true }, theme));
		assert.match(text, /─── Task ───/);
		assert.match(text, /find auth/);
		assert.match(text, /─── Output ───/);
		assert.match(text, /found it/);
	} finally {
		cleanup();
	}
});

test("renderSubagentResult parallel shows task status counts", async () => {
	const mod = await loadModule();
	try {
		const result = {
			content: [{ type: "text", text: "Parallel: 2/2 succeeded" }],
			details: {
				mode: "parallel",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{ agent: "a", agentSource: "user", task: "t1", exitCode: 0, stopReason: "end", messages: [], stderr: "", usage, model: "prov/x" },
					{ agent: "b", agentSource: "user", task: "t2", exitCode: 0, stopReason: "end", messages: [], stderr: "", usage, model: "prov/y" },
				],
			},
		};
		const text = flatten(mod.renderSubagentResult(result, { expanded: false }, theme));
		assert.match(text, /parallel/);
		assert.match(text, /2\/2 tasks/);
	} finally {
		cleanup();
	}
});

test("renderSubagentResult chain shows step count and per-step agents", async () => {
	const mod = await loadModule();
	try {
		const result = {
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{ agent: "scout", agentSource: "user", task: "look", exitCode: 0, stopReason: "end", messages: [], stderr: "", usage, model: "prov/x", step: 1 },
					{ agent: "worker", agentSource: "user", task: "build", exitCode: 0, stopReason: "end", messages: [], stderr: "", usage, model: "prov/x", step: 2 },
				],
			},
		};
		const text = flatten(mod.renderSubagentResult(result, { expanded: false }, theme));
		assert.match(text, /chain/);
		assert.match(text, /2\/2 steps/);
		assert.match(text, /scout/);
		assert.match(text, /worker/);
	} finally {
		cleanup();
	}
});
