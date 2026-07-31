import { readFile as nodeReadFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SettingsDependencies, SettingsPaths } from "./types.ts";

const root = resolve(import.meta.dirname, "../..");
export const defaultSettingsPaths: SettingsPaths = {
  configPath: resolve(root, "settings.config.json"),
  generatedPath: resolve(root, "settings.json"),
  mergeScriptPath: resolve(root, "scripts/merge-settings.sh"),
};

export function resolveSettingsPaths(paths: Partial<SettingsPaths> = {}): SettingsPaths {
  return { ...defaultSettingsPaths, ...paths };
}

export async function readJsonObject(path: string, readFile = nodeReadFile): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** The editable source is authoritative; generated settings are a compatibility fallback only. */
export async function readSettings(paths: SettingsPaths, dependencies: SettingsDependencies = {}): Promise<Record<string, unknown>> {
  const readFile = dependencies.readFile ?? nodeReadFile;
  return (await readJsonObject(paths.configPath, readFile)) ?? (await readJsonObject(paths.generatedPath, readFile)) ?? {};
}
