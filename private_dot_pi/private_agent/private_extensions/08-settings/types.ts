import type { FSWatcher } from "node:fs";

export interface SettingsPaths {
  configPath: string;
  generatedPath: string;
  mergeScriptPath: string;
}

export interface SettingsDependencies {
  paths?: Partial<SettingsPaths>;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (path: string, data: string, options?: { mode?: number }) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  runMerge?: () => Promise<void>;
}

export interface SettingsStore {
  read(): Promise<Record<string, unknown>>;
  update(update: Record<string, unknown> | ((settings: Record<string, unknown>) => Record<string, unknown> | void)): Promise<Record<string, unknown>>;
}

export type SettingsWatcher = FSWatcher;
