/**
 * Stateful roster settings: in-memory cache, disk persistence, and the
 * coexistence-safe /settings menu patch.
 *
 * Pure logic lives in roster.ts; this module owns I/O + pi-internals glue
 * (not unit-tested — the patching requires pi's bundled modules at runtime).
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { importPiModule } from "../packages/pi-package.ts";
import {
	addRosterSettingsToList,
	DEFAULT_ROSTER_CAP,
	DEFAULT_ROSTER_SCOPE,
	parseRosterSettings,
	type RosterScope,
	type RosterSettings,
	type RosterSettingsListLike,
} from "./roster.ts";

const execFile = promisify(execFileCallback);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// extensions/04-subagents/ -> ../../settings.config.json
const SETTINGS_CONFIG_PATH = path.resolve(__dirname, "../../settings.config.json");
const SETTINGS_PATH = path.resolve(__dirname, "../../settings.json");
const MERGE_SETTINGS_SCRIPT_PATH = path.resolve(__dirname, "../../scripts/merge-settings.sh");
const PI_SETTINGS_SELECTOR_RELATIVE_PATH = "dist/modes/interactive/components/settings-selector.js";

const PI_SETTINGS_SELECTOR_SENTINEL = "__subagentRosterSettingsPatched";

let rosterSettingsCache: RosterSettings | undefined;

async function readSettingsFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const data = await readFile(filePath, "utf8");
		return JSON.parse(data) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function readSettings(): Promise<Record<string, unknown>> {
	return (await readSettingsFile(SETTINGS_CONFIG_PATH)) ?? (await readSettingsFile(SETTINGS_PATH)) ?? {};
}

/** Refresh the in-memory cache from disk. Called on session_start. */
export async function refreshRosterSettingsCache(): Promise<RosterSettings> {
	const settings = parseRosterSettings(await readSettings());
	rosterSettingsCache = settings;
	return settings;
}

/** Get current roster settings (cache, falling back to disk). */
export async function getRosterSettings(): Promise<RosterSettings> {
	if (rosterSettingsCache) return rosterSettingsCache;
	return refreshRosterSettingsCache();
}

/** Update one roster setting: write to settings.config.json, run merge, update cache. */
async function setRosterSetting(key: "subagentRosterScope" | "subagentRosterCap", value: RosterScope | number): Promise<void> {
	const settings = await readSettings();
	settings[key] = value;
	await writeFile(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	try {
		await execFile(MERGE_SETTINGS_SCRIPT_PATH);
	} catch (error) {
		console.error("Failed to merge settings after subagent roster update:", error);
	}
	rosterSettingsCache = parseRosterSettings(settings);
}

export async function setRosterScope(scope: RosterScope): Promise<void> {
	await setRosterSetting("subagentRosterScope", scope);
}

export async function setRosterCap(cap: number): Promise<void> {
	await setRosterSetting("subagentRosterCap", cap);
}

let settingsMenuPatchPromise: Promise<void> | undefined;

/**
 * Patch the built-in /settings menu to add the two roster items.
 *
 * Coexistence-safe: wraps `SettingsSelectorComponent.prototype.getSettingsList`
 * (calls the original, injects our items, returns). Uses a sentinel so we
 * never double-patch, and so other extensions using the same pattern chain
 * cleanly.
 */
export function patchSettingsMenuForRoster(): Promise<void> {
	if (!settingsMenuPatchPromise) {
		settingsMenuPatchPromise = (async () => {
			const settingsSelectorModule = await importPiModule(PI_SETTINGS_SELECTOR_RELATIVE_PATH);
			const SettingsSelectorComponent = settingsSelectorModule.SettingsSelectorComponent as {
				prototype: {
					getSettingsList?: () => RosterSettingsListLike;
					[PI_SETTINGS_SELECTOR_SENTINEL]?: boolean;
				};
			};

			const proto = SettingsSelectorComponent?.prototype;
			if (!proto || proto[PI_SETTINGS_SELECTOR_SENTINEL]) return;
			const originalGetSettingsList = proto.getSettingsList;
			if (!originalGetSettingsList) return;

			proto[PI_SETTINGS_SELECTOR_SENTINEL] = true;
			proto.getSettingsList = function getSettingsList(this: unknown) {
				const settingsList = originalGetSettingsList.call(this);
				const current = rosterSettingsCache ?? {
					scope: DEFAULT_ROSTER_SCOPE,
					cap: DEFAULT_ROSTER_CAP,
				};
				addRosterSettingsToList(
					settingsList,
					current,
					(scope) => setRosterScope(scope),
					(cap) => setRosterCap(cap),
				);
				return settingsList;
			};
		})().catch((error) => {
			settingsMenuPatchPromise = undefined;
			console.error("Failed to patch pi settings menu for subagent roster:", error);
		});
	}

	return settingsMenuPatchPromise;
}
