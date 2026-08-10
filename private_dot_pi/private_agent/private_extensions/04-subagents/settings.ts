import { boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import { getNested } from "../08-settings/nested.ts";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_PARALLEL_TASKS,
  HARD_MAX_CONCURRENCY,
  HARD_MAX_PARALLEL_TASKS,
} from "./types.ts";

export interface SubagentExecutionSettings { maxParallelTasks: number; maxConcurrency: number }

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
  return { maxParallelTasks, maxConcurrency: Math.min(maxParallelTasks, configuredConcurrency) };
}

export async function getSubagentExecutionSettings(): Promise<SubagentExecutionSettings> {
  return resolveSubagentExecutionSettings(await createSettingsStore().read());
}
