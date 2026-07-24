import { rename, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeManagingStyle } from "./management-style.ts";
import type { ManagingStyle } from "./types.ts";

const extensionDir = import.meta.dirname;
export const SETTINGS_CONFIG_PATH = resolve(extensionDir, "../../settings.config.json");
let cache: ManagingStyle | undefined;
let sessionStyle: ManagingStyle | undefined;
let pendingWrite = Promise.resolve();
async function readConfig(configPath = SETTINGS_CONFIG_PATH) { try { return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>; } catch { return {}; } }
export async function refreshManagingStyleCache() { cache = normalizeManagingStyle((await readConfig()).managingStyle); return cache; }
export async function readConfiguredManagingStyle(configPath: string) { return normalizeManagingStyle((await readConfig(configPath)).managingStyle); }
export async function currentManagingStyle() { return sessionStyle ?? cache ?? refreshManagingStyleCache(); }
export function setSessionManagingStyle(style: ManagingStyle | undefined) { sessionStyle = style; }
export function clearSessionManagingStyle() { sessionStyle = undefined; }
export async function empowermentDisposableRoots() { const roots = (await readConfig()).empowermentDisposableRoots; return Array.isArray(roots) && roots.every((root) => typeof root === "string") ? roots : ["@user-temp"]; }
/** Serializes atomic writes; cache changes only after the normal merge completes. */
export function setManagingStyle(style: ManagingStyle, runMerge: () => Promise<void>, configPath = SETTINGS_CONFIG_PATH): Promise<void> {
  const work = async () => {
    const previousCache = cache;
    const original = await readFile(configPath, "utf8").catch(() => "{}\n");
    const config = JSON.parse(original) as Record<string, unknown>; config.managingStyle = style;
    const temp = resolve(dirname(configPath), `.settings.config.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    try { await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); await rename(temp, configPath); renamed = true; await runMerge(); cache = style; sessionStyle = undefined; }
    catch (error) {
      cache = previousCache;
      if (renamed) { const restore = `${temp}.restore`; await writeFile(restore, original, { mode: 0o600 }); await rename(restore, configPath); }
      await unlink(temp).catch(() => {}); throw error;
    }
  };
  pendingWrite = pendingWrite.then(work, work); return pendingWrite;
}
export function resetManagementSettingsForTests() { cache = undefined; sessionStyle = undefined; pendingWrite = Promise.resolve(); }
