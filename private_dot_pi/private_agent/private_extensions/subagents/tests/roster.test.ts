// Run with: npx -y tsx --test agent/extensions/subagents/tests/roster.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writePackageStubs } from "./_stubs.ts";

const SUBAGENT_DIR = resolve("agent/extensions/subagents");
const MODULE_PATH = resolve(SUBAGENT_DIR, "roster.ts");
const TESTABLE_PATH = resolve(SUBAGENT_DIR, ".roster.testable.ts");

async function loadModule() {
	writePackageStubs();
	// roster.ts imports only a type from ./agents.ts (erased at runtime). Verbatim copy loads.
	writeFileSync(TESTABLE_PATH, readFileSync(MODULE_PATH, "utf8"));
	const moduleUrl = `${pathToFileURL(TESTABLE_PATH).href}?t=${Date.now()}`;
	return await import(moduleUrl);
}

function cleanup() {
	rmSync(TESTABLE_PATH, { force: true });
}

const AGENTS = [
	{ name: "scout", description: "Fast recon" },
	{ name: "planner", description: "Planning" },
	{ name: "worker", description: "Builds" },
	{ name: "reviewer", description: "Reviews" },
	{ name: "conventions-analyst", description: "Conventions" },
];

test("parseRosterSettings applies defaults for missing/invalid values", async () => {
	const mod = await loadModule();
	try {
		assert.deepEqual(mod.parseRosterSettings(null), { scope: "user", cap: 10 });
		assert.deepEqual(mod.parseRosterSettings({}), { scope: "user", cap: 10 });
		// invalid scope falls back to user
		assert.equal(mod.parseRosterSettings({ subagentRosterScope: "bogus" }).scope, "user");
		// invalid cap falls back to default
		assert.equal(mod.parseRosterSettings({ subagentRosterCap: -5 }).cap, 10);
		assert.equal(mod.parseRosterSettings({ subagentRosterCap: "NaN" }).cap, 10);
		// valid values pass through
		assert.deepEqual(mod.parseRosterSettings({ subagentRosterScope: "both", subagentRosterCap: 15 }), {
			scope: "both",
			cap: 15,
		});
		// string cap is parsed
		assert.equal(mod.parseRosterSettings({ subagentRosterCap: "8" }).cap, 8);
	} finally {
		cleanup();
	}
});

test("hasRosterSentinel detects an already-injected roster", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.hasRosterSentinel("some system prompt"), false);
		assert.equal(mod.hasRosterSentinel(`prompt\n${mod.ROSTER_SENTINEL}\nroster`), true);
	} finally {
		cleanup();
	}
});

test("formatRoster caps, sorts by name, and notes omissions", async () => {
	const mod = await loadModule();
	try {
		const out = mod.formatRoster(AGENTS, 10);
		// sorted by name
		assert.match(out.split("\n")[0], /conventions-analyst/);
		assert.match(out, /scout — Fast recon/);
		assert.doesNotMatch(out, /\+/); // no omission note when all fit

		// cap = 2 omits 3
		const capped = mod.formatRoster(AGENTS, 2);
		const lines = capped.split("\n");
		assert.equal(lines.filter((l) => l.startsWith("- ") && !l.startsWith("- ...")).length, 2);
		assert.match(capped, /\+3 more/);
	} finally {
		cleanup();
	}
});

test("buildRosterInjection includes the sentinel, instruction, and roster", async () => {
	const mod = await loadModule();
	try {
		const injection = mod.buildRosterInjection(AGENTS, { scope: "user", cap: 10 });
		assert.match(injection, /pi-subagent-roster/);
		assert.match(injection, /Available subagents/);
		assert.match(injection, /subagent/);
		assert.match(injection, /scout — Fast recon/);
	} finally {
		cleanup();
	}
});

test("buildRosterInjection returns empty for no agents", async () => {
	const mod = await loadModule();
	try {
		assert.equal(mod.buildRosterInjection([], { scope: "user", cap: 10 }), "");
	} finally {
		cleanup();
	}
});

test("addRosterSettingsToList injects scope + cap items and intercepts onChange", async () => {
	const mod = await loadModule();
	try {
		const changes: Array<{ id: string; value: string | number }> = [];
		const settingsList = {
			items: [{ id: "thinking", label: "Thinking", currentValue: "high", values: ["high", "low"] }],
			filteredItems: [] as any[],
			onChange: (id: string, _newValue: string) => {
				changes.push({ id, value: "passthrough" });
			},
		};

		mod.addRosterSettingsToList(
			settingsList as any,
			{ scope: "user", cap: 10 },
			(scope) => changes.push({ id: "scope", value: scope }),
			(cap) => changes.push({ id: "cap", value: cap }),
		);

		const ids = settingsList.items.map((i) => i.id);
		assert.ok(ids.includes("subagent-roster-scope"));
		assert.ok(ids.includes("subagent-roster-cap"));
		assert.equal(settingsList.filteredItems, settingsList.items);

		// Our items are intercepted; others pass through.
		settingsList.onChange("subagent-roster-scope", "both");
		settingsList.onChange("subagent-roster-cap", "15");
		settingsList.onChange("thinking", "low");
		assert.deepEqual(changes, [
			{ id: "scope", value: "both" },
			{ id: "cap", value: 15 },
			{ id: "thinking", value: "passthrough" },
		]);
	} finally {
		cleanup();
	}
});

test("addRosterSettingsToList updates existing items in place on re-open", async () => {
	const mod = await loadModule();
	try {
		const settingsList = {
			items: [
				{ id: "subagent-roster-scope", label: "old", currentValue: "user", values: ["user"] },
				{ id: "thinking", label: "Thinking", currentValue: "high" },
			],
			filteredItems: [] as any[],
			onChange: () => {},
		};

		mod.addRosterSettingsToList(
			settingsList as any,
			{ scope: "both", cap: 15 },
			() => {},
			() => {},
		);

		// No duplicate inserted; existing scope item updated.
		const scopeItems = settingsList.items.filter((i) => i.id === "subagent-roster-scope");
		assert.equal(scopeItems.length, 1);
		assert.equal(scopeItems[0].currentValue, "both");
		assert.deepEqual(scopeItems[0].values, ["user", "both"]);
		// cap item added
		assert.ok(settingsList.items.some((i) => i.id === "subagent-roster-cap"));
	} finally {
		cleanup();
	}
});
