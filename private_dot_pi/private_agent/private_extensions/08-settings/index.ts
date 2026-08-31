import { watch as nodeWatch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createSettingsStore } from "./store.ts";
export * from "./types.ts";
export * from "./readers.ts";
export * from "./schema.ts";
export * from "./store.ts";
export * from "./nested.ts";
export * from "./hotkeys.ts";

export interface SettingsExtensionDependencies {
  configPath?: string;
  generatedPath?: string;
  debounceMs?: number;
  merge?: () => Promise<void>;
  syncGenerated?: () => Promise<{ changed: boolean }>;
  watch?: (path: string, listener: (eventType?: string, filename?: string | Buffer | null) => void) => Pick<FSWatcher, "close">;
}

/** Registers source merging plus Pi's scoped-model save reconciliation. */
export function registerSettingsExtension(
  pi: { on: (event: string, handler: (event?: any, ctx?: any) => Promise<void> | void) => void },
  dependencies: SettingsExtensionDependencies = {},
) {
  const store = createSettingsStore();
  const configPath = resolve(dependencies.configPath ?? store.paths.configPath);
  const generatedPath = resolve(dependencies.generatedPath ?? store.paths.generatedPath);
  const mergeSettings = dependencies.merge ?? (() => store.merge());
  const syncGenerated = dependencies.syncGenerated ?? (() => store.syncEnabledModelsFromGenerated());
  const watchSettings = dependencies.watch ?? ((path, listener) => nodeWatch(path, listener));
  const debounceMs = dependencies.debounceMs ?? 50;
  let watchers: Array<Pick<FSWatcher, "close">> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let configDirty = false;
  let generatedDirty = false;

  const notifyError = (ctx: any, label: string, error: unknown) => {
    ctx?.ui?.notify?.(`${label}: ${error instanceof Error ? error.message : String(error)}`, "error");
  };
  const merge = async (ctx: any) => {
    try { await mergeSettings(); return true; }
    catch (error) { notifyError(ctx, "Failed to merge settings", error); return false; }
  };
  const reconcile = async (ctx: any) => {
    const shouldSyncGenerated = generatedDirty;
    const shouldMergeConfig = configDirty;
    generatedDirty = false;
    configDirty = false;

    let generatedChanged = false;
    if (shouldSyncGenerated) {
      try { generatedChanged = (await syncGenerated()).changed; }
      catch (error) { notifyError(ctx, "Failed to persist scoped models", error); }
    }
    if (shouldMergeConfig && !generatedChanged) await merge(ctx);
  };
  const schedule = (ctx: any) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile(ctx);
    }, debounceMs);
  };

  pi.on("session_start", async (_event, ctx) => {
    await merge(ctx);
    for (const watcher of watchers) watcher.close();
    watchers = [];

    const configName = basename(configPath);
    const generatedName = basename(generatedPath);
    for (const directory of new Set([dirname(configPath), dirname(generatedPath)])) {
      watchers.push(watchSettings(directory, (_eventType, filename) => {
        const name = filename == null ? undefined : filename.toString();
        if (!name) {
          if (dirname(configPath) === directory) configDirty = true;
          if (dirname(generatedPath) === directory) generatedDirty = true;
        } else {
          const changedPath = resolve(directory, name);
          if (changedPath === configPath || name === configName && dirname(configPath) === directory) configDirty = true;
          if (changedPath === generatedPath || name === generatedName && dirname(generatedPath) === directory) generatedDirty = true;
        }
        if (configDirty || generatedDirty) schedule(ctx);
      }));
    }
  });
  pi.on("session_shutdown", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    configDirty = false;
    generatedDirty = false;
    for (const watcher of watchers) watcher.close();
    watchers = [];
  });
}

export default function settingsExtension(pi: { on: (event: string, handler: (event?: any, ctx?: any) => Promise<void> | void) => void }) {
  registerSettingsExtension(pi);
}
