import { createSettingsStore } from "../08-settings/index.ts";
import { importPiModule } from "../packages/pi-package.ts";
import {
  addRosterSettingsToList,
  DEFAULT_ROSTER_CAP,
  DEFAULT_ROSTER_SCOPE,
  parseRosterSettings,
  type RosterScope,
  type RosterSettings,
} from "./roster.ts";

const PI_SETTINGS_SELECTOR_RELATIVE_PATH = "dist/modes/interactive/components/settings-selector.js";
const PI_SETTINGS_SELECTOR_SENTINEL = "__subagentRosterSettingsPatched";

const store = createSettingsStore();
let rosterSettingsCache: RosterSettings | undefined;
let settingsMenuPatchPromise: Promise<void> | undefined;

export async function refreshRosterSettingsCache(): Promise<RosterSettings> {
  rosterSettingsCache = parseRosterSettings(await store.read());
  return rosterSettingsCache;
}

export async function getRosterSettings(): Promise<RosterSettings> {
  return rosterSettingsCache ?? refreshRosterSettingsCache();
}

async function setRosterSetting(
  key: "subagentRosterScope" | "subagentRosterCap",
  value: RosterScope | number,
): Promise<void> {
  rosterSettingsCache = parseRosterSettings(await store.update({ [key]: value }));
}

export async function setRosterScope(scope: RosterScope): Promise<void> {
  await setRosterSetting("subagentRosterScope", scope);
}

export async function setRosterCap(cap: number): Promise<void> {
  await setRosterSetting("subagentRosterCap", cap);
}

export function patchSettingsMenuForRoster(): Promise<void> {
  if (!settingsMenuPatchPromise) {
    settingsMenuPatchPromise = (async () => {
      const module = await importPiModule(PI_SETTINGS_SELECTOR_RELATIVE_PATH);
      const prototype = module.SettingsSelectorComponent?.prototype;
      if (!prototype || prototype[PI_SETTINGS_SELECTOR_SENTINEL] || !prototype.getSettingsList) return;

      const original = prototype.getSettingsList;
      prototype[PI_SETTINGS_SELECTOR_SENTINEL] = true;
      prototype.getSettingsList = function (this: unknown) {
        const list = original.call(this);
        addRosterSettingsToList(
          list,
          rosterSettingsCache ?? { scope: DEFAULT_ROSTER_SCOPE, cap: DEFAULT_ROSTER_CAP },
          setRosterScope,
          setRosterCap,
        );
        return list;
      };
    })().catch((error) => {
      settingsMenuPatchPromise = undefined;
      console.error("Failed to patch pi settings menu for subagent roster:", error);
    });
  }
  return settingsMenuPatchPromise;
}
