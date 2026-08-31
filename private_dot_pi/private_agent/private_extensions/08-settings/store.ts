import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { readSettings, resolveSettingsPaths } from "./readers.ts";
import type { GeneratedEnabledModelsSync, SettingsDependencies, SettingsPaths, SettingsStore } from "./types.ts";

const execFile = promisify(execFileCallback);
let queued: Promise<unknown> = Promise.resolve();

export async function runSettingsMerge(path: string): Promise<void> { await execFile(path); }

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = queued.then(work, work);
  queued = result.catch(() => undefined);
  return result;
}

function sameStrings(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => typeof value === "string" && value === right[index]);
}

/** Serialized source updates and generated-settings reconciliation. */
export function createSettingsStore(dependencies: SettingsDependencies = {}): SettingsStore & { paths: SettingsPaths } {
  const paths = resolveSettingsPaths(dependencies.paths);
  const reader = dependencies.readFile ?? readFile;
  const writer = dependencies.writeFile ?? writeFile;
  const move = dependencies.rename ?? rename;
  const remove = dependencies.unlink ?? unlink;
  const mergeNow = dependencies.runMerge ?? (() => runSettingsMerge(paths.mergeScriptPath));

  const readSource = async (): Promise<{ original: string; sourceExisted: boolean; current: Record<string, unknown> }> => {
    let original = "{}\n";
    let sourceExisted = true;
    try { original = await reader(paths.configPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      sourceExisted = false;
    }
    let current: Record<string, unknown>;
    try {
      const parsed = JSON.parse(original);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      current = parsed as Record<string, unknown>;
    } catch { throw new Error("settings.config.json is invalid"); }
    return { original, sourceExisted, current };
  };

  const updateNow = async (change: Record<string, unknown> | ((settings: Record<string, unknown>) => Record<string, unknown> | void)) => {
    const { original, sourceExisted, current } = await readSource();
    const next = { ...current };
    const returned = typeof change === "function" ? change(next) : Object.assign(next, change);
    const value = returned && typeof returned === "object" ? returned : next;
    const temp = resolve(dirname(paths.configPath), `.settings.${process.pid}.${randomUUID()}.tmp`);
    let installed = false;
    try {
      await writer(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await move(temp, paths.configPath); installed = true;
      await mergeNow();
      return value;
    } catch (error) {
      if (installed) {
        if (sourceExisted) {
          const rollback = `${temp}.rollback`;
          await writer(rollback, original, { mode: 0o600 });
          await move(rollback, paths.configPath);
        } else await remove(paths.configPath).catch(() => {});
      }
      throw error;
    } finally { await remove(temp).catch(() => {}); }
  };

  const update = (change: Record<string, unknown> | ((settings: Record<string, unknown>) => Record<string, unknown> | void)) => enqueue(() => updateNow(change));
  const merge = () => enqueue(mergeNow);
  const syncEnabledModelsFromGenerated = () => enqueue(async (): Promise<GeneratedEnabledModelsSync> => {
    let generated: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await reader(paths.generatedPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      generated = parsed as Record<string, unknown>;
    } catch { throw new Error("settings.json is invalid or unavailable"); }

    const hasGeneratedSelection = Object.hasOwn(generated, "enabledModels");
    const selection = generated.enabledModels;
    if (hasGeneratedSelection && (!Array.isArray(selection) || !selection.every((value) => typeof value === "string"))) {
      throw new Error("settings.json enabledModels must be an array of strings");
    }

    const { current } = await readSource();
    const hasSourceSelection = Object.hasOwn(current, "enabledModels");
    const unchanged = hasGeneratedSelection === hasSourceSelection
      && (!hasGeneratedSelection || sameStrings(current.enabledModels, selection));
    if (unchanged) return { changed: false, ...(hasGeneratedSelection ? { enabledModels: [...selection as string[]] } : {}) };

    await updateNow((settings) => {
      if (hasGeneratedSelection) settings.enabledModels = [...selection as string[]];
      else delete settings.enabledModels;
    });
    return { changed: true, ...(hasGeneratedSelection ? { enabledModels: [...selection as string[]] } : {}) };
  });

  return { paths, read: () => readSettings(paths, dependencies), update, merge, syncEnabledModelsFromGenerated };
}

export function resetSettingsStoreForTests() { queued = Promise.resolve(); }
