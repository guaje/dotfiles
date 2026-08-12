import { createSettingsStore } from "../08-settings/index.ts";
import { getNested } from "../08-settings/nested.ts";
import { DEFAULT_MANAGING_STYLE, normalizeManagingStyle } from "./management-style.ts";
import { cacheHotkeys, resolveHotkeys } from "./shortcuts.ts";
import type { ManagingStyle, PersistedManagingStyle } from "./types.ts";

const store = createSettingsStore();
export const SETTINGS_CONFIG_PATH = store.paths.configPath;

let cache: PersistedManagingStyle | undefined;
let sessionStyle: ManagingStyle | undefined;
let styleBeforeYolo: PersistedManagingStyle | undefined;

async function readConfig(configPath = SETTINGS_CONFIG_PATH) {
  return configPath === SETTINGS_CONFIG_PATH
    ? store.read()
    : createSettingsStore({ paths: { configPath } }).read();
}

function managingStyleValue(settings: Record<string, unknown>): unknown {
  const nested = getNested(settings, "permissions.managingStyle");
  if (nested === "Micromanagement" || nested === "Empowerment") return nested;
  return settings.managingStyle;
}

function disposableRootsValue(settings: Record<string, unknown>): unknown {
  const nested = getNested(settings, "permissions.empowermentDisposableRoots");
  if (Array.isArray(nested) && nested.every((root) => typeof root === "string")) return nested;
  return settings.empowermentDisposableRoots;
}

function approvalCapValue(settings: Record<string, unknown>): unknown {
  const nested = getNested(settings, "permissions.sessionApprovalMaxRules");
  if (Number.isSafeInteger(nested) && (nested as number) >= 0) return nested;
  return settings.permissionsSessionApprovalMaxRules;
}

export async function refreshManagingStyleCache() {
  const settings = await readConfig();
  cache = normalizeManagingStyle(managingStyleValue(settings));
  const hotkeys = resolveHotkeys(settings);
  cacheHotkeys(hotkeys.forward, hotkeys.backward);
  return cache;
}

export async function readConfiguredManagingStyle(configPath: string) {
  return normalizeManagingStyle(managingStyleValue(await readConfig(configPath)));
}

export async function currentManagingStyle(): Promise<ManagingStyle> {
  return sessionStyle ?? cache ?? refreshManagingStyleCache();
}

/** Runtime selection only. Entering YOLO remembers a safe non-YOLO restoration target. */
export function setSessionManagingStyle(style: ManagingStyle | undefined) {
  if (style === "YOLO") {
    styleBeforeYolo = sessionStyle && sessionStyle !== "YOLO" ? sessionStyle : cache ?? DEFAULT_MANAGING_STYLE;
  }
  else if (style) {
    styleBeforeYolo = undefined;
  }
  else {
    styleBeforeYolo = undefined;
  }
  sessionStyle = style;
}

/** Route loss is fail-closed: YOLO never survives without Handoff's active remote route. */
export function restoreManagingStyleAfterYolo(): PersistedManagingStyle {
  const restored = styleBeforeYolo ?? cache ?? DEFAULT_MANAGING_STYLE;
  if (sessionStyle === "YOLO") sessionStyle = restored;
  styleBeforeYolo = undefined;
  return restored;
}

export function clearSessionManagingStyle() {
  sessionStyle = undefined;
  styleBeforeYolo = undefined;
}

export async function empowermentDisposableRoots() {
  const roots = disposableRootsValue(await readConfig());
  return Array.isArray(roots) && roots.every((root) => typeof root === "string")
    ? roots
    : ["@user-temp"];
}

export async function permissionsSessionApprovalMaxRules(configPath = SETTINGS_CONFIG_PATH) {
  const value = approvalCapValue(await readConfig(configPath));
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

/** Uses the shared serialized atomic update and adopts cache only after merge success. */
export async function setManagingStyle(
  style: PersistedManagingStyle,
  runMerge?: () => Promise<void>,
  configPath = SETTINGS_CONFIG_PATH,
): Promise<void> {
  const previous = cache;
  const persisted = normalizeManagingStyle(style);
  try {
    const target = runMerge || configPath !== SETTINGS_CONFIG_PATH
      ? createSettingsStore({ paths: { configPath }, runMerge })
      : store;
    const result = await target.update((settings) => {
      if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) {
        settings.permissions = {};
      }
      (settings.permissions as Record<string, unknown>).managingStyle = persisted;
    });
    cache = persisted;
    sessionStyle = undefined;
    styleBeforeYolo = undefined;
    const hotkeys = resolveHotkeys(result);
    cacheHotkeys(hotkeys.forward, hotkeys.backward);
  }
  catch (error) {
    cache = previous;
    throw error;
  }
}

export function resetManagementSettingsForTests() {
  cache = undefined;
  sessionStyle = undefined;
  styleBeforeYolo = undefined;
}
