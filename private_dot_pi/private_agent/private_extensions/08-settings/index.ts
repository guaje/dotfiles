import { watch as nodeWatch, type FSWatcher } from "node:fs";
import { createSettingsStore, runSettingsMerge } from "./store.ts";
export * from "./types.ts";
export * from "./readers.ts";
export * from "./schema.ts";
export * from "./store.ts";

export interface SettingsExtensionDependencies {
  configPath?: string;
  debounceMs?: number;
  merge?: () => Promise<void>;
  watch?: (path: string, listener: () => void) => Pick<FSWatcher, "close">;
}

/** Registers the settings merge/watch lifecycle with injectable deterministic boundaries. */
export function registerSettingsExtension(
  pi: { on: (event: string, handler: (event?: any, ctx?: any) => Promise<void> | void) => void },
  dependencies: SettingsExtensionDependencies = {},
) {
  const store = createSettingsStore();
  const configPath = dependencies.configPath ?? store.paths.configPath;
  const mergeSettings = dependencies.merge ?? (() => runSettingsMerge(store.paths.mergeScriptPath));
  const watchSettings = dependencies.watch ?? ((path, listener) => nodeWatch(path, listener));
  const debounceMs = dependencies.debounceMs ?? 50;
  let watcher: Pick<FSWatcher, "close"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const merge = async (ctx: any) => {
    try { await mergeSettings(); }
    catch (error) { ctx?.ui?.notify?.(`Failed to merge settings: ${error instanceof Error ? error.message : String(error)}`, "error"); }
  };
  const schedule = (ctx: any) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void merge(ctx); }, debounceMs);
  };
  pi.on("session_start", async (_event, ctx) => {
    await merge(ctx);
    watcher?.close();
    watcher = watchSettings(configPath, () => schedule(ctx));
  });
  pi.on("session_shutdown", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  });
}

export default function settingsExtension(pi: { on: (event: string, handler: (event?: any, ctx?: any) => Promise<void> | void) => void }) {
  registerSettingsExtension(pi);
}
