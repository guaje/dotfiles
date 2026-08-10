// Run with: npx -y tsx --test agent/extensions/04-subagents/tests/roster-settings.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore } from "../../08-settings/store.ts";
import { applyRosterSetting } from "../roster-settings.ts";

test("roster setting update callback preserves sibling root and subagents settings", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-roster-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const configPath = join(root, "settings.config.json");
	const generatedPath = join(root, "settings.json");

	const original = {
		theme: "catppuccin-mocha",
		subagents: { rosterCap: 10, maxParallelTasks: 8, maxConcurrency: 4 },
		otherKey: true,
	};
	await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);

	const store = createSettingsStore({ paths: { configPath, generatedPath }, runMerge: async () => {} });

	const result = await store.update((settings) => applyRosterSetting(settings, "rosterScope", "both"));

	// result is the resolved settings object
	assert.equal(result.theme, "catppuccin-mocha");
	assert.equal(result.otherKey, true);
	assert.deepEqual(result.subagents, {
		rosterCap: 10,
		maxParallelTasks: 8,
		maxConcurrency: 4,
		rosterScope: "both",
	});

	// file on disk must also preserve siblings
	const fileContent = JSON.parse(await readFile(configPath, "utf8"));
	assert.deepEqual(fileContent.subagents, {
		rosterCap: 10,
		maxParallelTasks: 8,
		maxConcurrency: 4,
		rosterScope: "both",
	});
	assert.equal(fileContent.theme, "catppuccin-mocha");
	assert.equal(fileContent.otherKey, true);
});

test("roster setting update callback initializes subagents object when absent", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-roster-settings-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const configPath = join(root, "settings.config.json");
	const generatedPath = join(root, "settings.json");

	const original = { theme: "catppuccin-mocha" };
	await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);

	const store = createSettingsStore({ paths: { configPath, generatedPath }, runMerge: async () => {} });

	const result = await store.update((settings) => applyRosterSetting(settings, "rosterCap", 15));
	assert.deepEqual(result.subagents, { rosterCap: 15 });
	assert.equal(result.theme, "catppuccin-mocha");

	const fileContent = JSON.parse(await readFile(configPath, "utf8"));
	assert.deepEqual(fileContent.subagents, { rosterCap: 15 });
	assert.equal(fileContent.theme, "catppuccin-mocha");
});
