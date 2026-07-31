import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { readSettings, resolveSettingsPaths } from "./readers.ts";
import type { SettingsDependencies, SettingsPaths, SettingsStore } from "./types.ts";

const execFile = promisify(execFileCallback);
let queued: Promise<unknown> = Promise.resolve();

export async function runSettingsMerge(path: string): Promise<void> { await execFile(path); }

/** Serialized source update. A failed merge restores the exact original bytes. */
export function createSettingsStore(dependencies: SettingsDependencies = {}): SettingsStore & { paths: SettingsPaths } {
  const paths = resolveSettingsPaths(dependencies.paths);
  const reader = dependencies.readFile ?? readFile;
  const writer = dependencies.writeFile ?? writeFile;
  const move = dependencies.rename ?? rename;
  const remove = dependencies.unlink ?? unlink;
  const update = (change: Record<string, unknown> | ((settings: Record<string, unknown>) => Record<string, unknown> | void)) => {
    const work = async () => {
      let original = "{}\n";
      let sourceExisted = true;
      try { original = await reader(paths.configPath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        sourceExisted = false;
      }
      let current: Record<string, unknown>;
      try { current = JSON.parse(original) as Record<string, unknown>; } catch { throw new Error("settings.config.json is invalid"); }
      const next = { ...current };
      const returned = typeof change === "function" ? change(next) : Object.assign(next, change);
      const value = returned && typeof returned === "object" ? returned : next;
      const temp = resolve(dirname(paths.configPath), `.settings.${process.pid}.${randomUUID()}.tmp`);
      let installed = false;
      try {
        await writer(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await move(temp, paths.configPath); installed = true;
        await (dependencies.runMerge ?? (() => runSettingsMerge(paths.mergeScriptPath)))();
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
    const result = queued.then(work, work);
    queued = result.catch(() => undefined);
    return result;
  };
  return { paths, read: () => readSettings(paths, dependencies), update };
}

export function resetSettingsStoreForTests() { queued = Promise.resolve(); }
