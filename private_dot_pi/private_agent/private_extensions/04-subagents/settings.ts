import { boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import { getNested } from "../08-settings/nested.ts";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_PARALLEL_TASKS,
  HARD_MAX_CONCURRENCY,
  HARD_MAX_PARALLEL_TASKS,
} from "./types.ts";

export interface SubagentExecutionSettings { maxParallelTasks: number; maxConcurrency: number; benchmarkSnapshotMaxAgeMs: number }
export const DEFAULT_BENCHMARK_SNAPSHOT_MAX_AGE_MS = 2_592_000_000;
const MIN_BENCHMARK_SNAPSHOT_MAX_AGE_MS = 60_000;
const MAX_BENCHMARK_SNAPSHOT_MAX_AGE_MS = 31_536_000_000;

function nestedOrFlatInteger(settings: Record<string, unknown>, path: string, flatKey: string, minimum: number, maximum: number): unknown {
  const nested = getNested(settings, path);
  if (Number.isSafeInteger(nested) && (nested as number) >= minimum && (nested as number) <= maximum) return nested;
  return settings[flatKey];
}

export function resolveSubagentExecutionSettings(settings: Record<string, unknown>): SubagentExecutionSettings {
  const maxParallelTasks = boundedSafeInteger(
    nestedOrFlatInteger(settings, "subagents.maxParallelTasks", "subagentMaxParallelTasks", 1, HARD_MAX_PARALLEL_TASKS),
    DEFAULT_MAX_PARALLEL_TASKS,
    1,
    HARD_MAX_PARALLEL_TASKS,
  );
  const configuredConcurrency = boundedSafeInteger(
    nestedOrFlatInteger(settings, "subagents.maxConcurrency", "subagentMaxConcurrency", 1, HARD_MAX_CONCURRENCY),
    DEFAULT_MAX_CONCURRENCY,
    1,
    HARD_MAX_CONCURRENCY,
  );
  const benchmarkSnapshotMaxAgeMs = boundedSafeInteger(
    getNested(settings, "subagents.autoModelSelection.benchmarkSnapshotMaxAgeMs"),
    DEFAULT_BENCHMARK_SNAPSHOT_MAX_AGE_MS,
    MIN_BENCHMARK_SNAPSHOT_MAX_AGE_MS,
    MAX_BENCHMARK_SNAPSHOT_MAX_AGE_MS,
  );
  return { maxParallelTasks, maxConcurrency: Math.min(maxParallelTasks, configuredConcurrency), benchmarkSnapshotMaxAgeMs };
}

export async function getSubagentExecutionSettings(): Promise<SubagentExecutionSettings> {
  return resolveSubagentExecutionSettings(await createSettingsStore().read());
}
