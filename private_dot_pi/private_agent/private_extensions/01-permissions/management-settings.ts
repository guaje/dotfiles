import { createSettingsStore } from "../08-settings/index.ts";
import { normalizeManagingStyle } from "./management-style.ts";
import type { ManagingStyle } from "./types.ts";

const store = createSettingsStore();
export const SETTINGS_CONFIG_PATH = store.paths.configPath;

let cache: ManagingStyle | undefined;
let sessionStyle: ManagingStyle | undefined;

async function readConfig(configPath = SETTINGS_CONFIG_PATH) {
  return configPath === SETTINGS_CONFIG_PATH
    ? store.read()
    : createSettingsStore({ paths: { configPath } }).read();
}

export async function refreshManagingStyleCache() {
  cache = normalizeManagingStyle((await readConfig()).managingStyle);
  return cache;
}

export async function readConfiguredManagingStyle(configPath: string) {
  return normalizeManagingStyle((await readConfig(configPath)).managingStyle);
}

export async function currentManagingStyle() {
  return sessionStyle ?? cache ?? refreshManagingStyleCache();
}

export function setSessionManagingStyle(style: ManagingStyle | undefined) {
  sessionStyle = style;
}

export function clearSessionManagingStyle() {
  sessionStyle = undefined;
}

export async function empowermentDisposableRoots() {
  const roots = (await readConfig()).empowermentDisposableRoots;
  return Array.isArray(roots) && roots.every((root) => typeof root === "string")
    ? roots
    : ["@user-temp"];
}

export async function permissionsSessionApprovalMaxRules(configPath = SETTINGS_CONFIG_PATH) {
  const value = (await readConfig(configPath)).permissionsSessionApprovalMaxRules;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

/** Uses the shared serialized atomic update and adopts cache only after merge success. */
export async function setManagingStyle(
  style: ManagingStyle,
  runMerge?: () => Promise<void>,
  configPath = SETTINGS_CONFIG_PATH,
): Promise<void> {
  const previous = cache;
  try {
    const target = runMerge || configPath !== SETTINGS_CONFIG_PATH
      ? createSettingsStore({ paths: { configPath }, runMerge })
      : store;
    await target.update({ managingStyle: style });
    cache = style;
    sessionStyle = undefined;
  }
  catch (error) {
    cache = previous;
    throw error;
  }
}

export function resetManagementSettingsForTests() {
  cache = undefined;
  sessionStyle = undefined;
}
