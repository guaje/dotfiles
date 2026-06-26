// Run with: npx -y tsx --test agent/extensions/subagent/tests/agents.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagent");
const MODULE_PATH = resolve(SUBAGENT_DIR, "agents.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".agents.testable.ts");

const AGENT_MD = (name: string, description: string, extra = "", body = "system prompt body") =>
	`---\nname: ${name}\ndescription: ${description}${extra ? `\n${extra}` : ""}\n---\n${body}`;

async function loadModule() {
	writePackageStubs();
	// agents.ts has no relative source imports, so the testable copy is verbatim.
	writeFileSync(TESTABLE_PATH, readFileSync(MODULE_PATH, "utf8"));
	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
	delete (globalThis as any).__subagentAgentDir;
}

interface TempTree {
	userDir: string;
	projectRoot: string;
}

function makeTree(): TempTree {
	const userDir = mkdtempSync(join(tmpdir(), "subagent-user-"));
	const projectRoot = mkdtempSync(join(tmpdir(), "subagent-proj-"));
	return { userDir, projectRoot };
}

function writeAgent(dir: string, file: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), content);
}

test("discoverAgents (user scope) loads agents from the user agent dir", async () => {
	const mod = await loadModule();
	const { userDir } = makeTree();
	(globalThis as any).__subagentAgentDir = userDir;
	try {
		writeAgent(join(userDir, "agents"), "scout.md", AGENT_MD("scout", "Fast recon", "tools: read, grep"));
		writeAgent(join(userDir, "agents"), "planner.md", AGENT_MD("planner", "Planning"));
		// Non-markdown and missing-frontmatter files are ignored.
		writeAgent(join(userDir, "agents"), "notes.txt", "not an agent");
		writeAgent(join(userDir, "agents"), "empty.md", "no frontmatter here");

		const result = mod.discoverAgents(resolve(userDir, "anywhere"), "user");
		assert.equal(result.agents.length, 2);
		const names = result.agents.map((a: any) => a.name).sort();
		assert.deepEqual(names, ["planner", "scout"]);
		assert.equal(result.agents.find((a: any) => a.name === "scout").source, "user");
		assert.deepEqual(result.agents.find((a: any) => a.name === "scout").tools, ["read", "grep"]);
		assert.equal(result.agents.find((a: any) => a.name === "planner").tools, undefined);
		assert.equal(result.projectAgentsDir, null);
	} finally {
		cleanup();
	}
});

test("discoverAgents parses thinking and contextFiles frontmatter fields", async () => {
	const mod = await loadModule();
	const { userDir } = makeTree();
	(globalThis as any).__subagentAgentDir = userDir;
	try {
		writeAgent(
			join(userDir, "agents"),
			"scout.md",
			AGENT_MD("scout", "Fast recon", "tools: read, grep\nthinking: high\ncontextFiles: false"),
		);
		writeAgent(
			join(userDir, "agents"),
			"planner.md",
			AGENT_MD("planner", "Planning", "thinking: xhigh"),
		);
		// Invalid thinking level is dropped (falls back to undefined).
		writeAgent(
			join(userDir, "agents"),
			"bad.md",
			AGENT_MD("bad", "Bad thinking", "thinking: bogus"),
		);

		const result = mod.discoverAgents(resolve(userDir, "anywhere"), "user");
		const byName = new Map(result.agents.map((a: any) => [a.name, a]));
		assert.equal(byName.get("scout").thinking, "high");
		assert.equal(byName.get("scout").contextFiles, false);
		assert.equal(byName.get("planner").thinking, "xhigh");
		// contextFiles defaults to undefined when omitted.
		assert.equal(byName.get("planner").contextFiles, undefined);
		// Invalid thinking value is rejected.
		assert.equal(byName.get("bad").thinking, undefined);
	} finally {
		cleanup();
	}
});

test("discoverAgents (project scope) walks up to find .pi/agents", async () => {
	const mod = await loadModule();
	const { userDir, projectRoot } = makeTree();
	(globalThis as any).__subagentAgentDir = userDir;
	try {
		const projAgentsDir = join(projectRoot, ".pi", "agents");
		writeAgent(projAgentsDir, "reviewer.md", AGENT_MD("reviewer", "Code review", "tools: read, bash"));
		// cwd is a deep subdirectory; discovery must walk up to projectRoot.
		const deepCwd = join(projectRoot, "src", "modules", "deep");
		mkdirSync(deepCwd, { recursive: true });

		const result = mod.discoverAgents(deepCwd, "project");
		assert.equal(result.agents.length, 1);
		assert.equal(result.agents[0].name, "reviewer");
		assert.equal(result.agents[0].source, "project");
		assert.equal(result.projectAgentsDir, projAgentsDir);
	} finally {
		cleanup();
	}
});

test("discoverAgents (both scope) unions user + project, project wins on name conflict", async () => {
	const mod = await loadModule();
	const { userDir, projectRoot } = makeTree();
	(globalThis as any).__subagentAgentDir = userDir;
	try {
		writeAgent(join(userDir, "agents"), "worker.md", AGENT_MD("worker", "user worker"));
		writeAgent(join(userDir, "agents"), "scout.md", AGENT_MD("scout", "user scout"));
		const projAgentsDir = join(projectRoot, ".pi", "agents");
		writeAgent(projAgentsDir, "worker.md", AGENT_MD("worker", "project worker override"));

		const result = mod.discoverAgents(projectRoot, "both");
		const byName = new Map(result.agents.map((a: any) => [a.name, a]));
		assert.equal(result.agents.length, 2);
		assert.equal(byName.get("worker").source, "project");
		assert.equal(byName.get("worker").description, "project worker override");
		assert.equal(byName.get("scout").source, "user");
	} finally {
		cleanup();
	}
});

test("discoverAgents returns empty when no agent dir exists and no project agents found", async () => {
	const mod = await loadModule();
	const { userDir } = makeTree();
	(globalThis as any).__subagentAgentDir = join(userDir, "does-not-exist");
	try {
		const result = mod.discoverAgents(userDir, "user");
		assert.equal(result.agents.length, 0);
		assert.equal(result.projectAgentsDir, null);
	} finally {
		cleanup();
	}
});

test("formatAgentList truncates to maxItems and reports the remainder", async () => {
	const mod = await loadModule();
	try {
		const agents = [
			{ name: "a", source: "user", description: "da" },
			{ name: "b", source: "user", description: "db" },
			{ name: "c", source: "project", description: "dc" },
		];
		const full = mod.formatAgentList(agents, 10);
		assert.equal(full.remaining, 0);
		assert.match(full.text, /a \(user\): da/);
		assert.match(full.text, /c \(project\): dc/);

		const truncated = mod.formatAgentList(agents, 1);
		assert.equal(truncated.remaining, 2);
		assert.match(truncated.text, /a \(user\): da/);
		assert.doesNotMatch(truncated.text, /c \(project\)/);

		const empty = mod.formatAgentList([], 5);
		assert.equal(empty.text, "none");
		assert.equal(empty.remaining, 0);
	} finally {
		cleanup();
	}
});
