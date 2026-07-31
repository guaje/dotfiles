import { boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_PARALLEL_TASKS,
  HARD_MAX_CONCURRENCY,
  HARD_MAX_PARALLEL_TASKS,
} from "./types.ts";

export interface SubagentExecutionSettings { maxParallelTasks: number; maxConcurrency: number }

export function resolveSubagentExecutionSettings(settings: Record<string, unknown>): SubagentExecutionSettings {
  const maxParallelTasks = boundedSafeInteger(settings.subagentMaxParallelTasks, DEFAULT_MAX_PARALLEL_TASKS, 1, HARD_MAX_PARALLEL_TASKS);
  const configuredConcurrency = boundedSafeInteger(settings.subagentMaxConcurrency, DEFAULT_MAX_CONCURRENCY, 1, HARD_MAX_CONCURRENCY);
  return { maxParallelTasks, maxConcurrency: Math.min(maxParallelTasks, configuredConcurrency) };
}

export async function getSubagentExecutionSettings(): Promise<SubagentExecutionSettings> {
  return resolveSubagentExecutionSettings(await createSettingsStore().read());
}
