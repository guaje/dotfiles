import { boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import { getNested } from "../08-settings/nested.ts";
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_PARALLEL_TASKS, HARD_MAX_CONCURRENCY, HARD_MAX_PARALLEL_TASKS } from "./types.ts";

export interface SubagentExecutionSettings {
  maxParallelTasks: number; maxConcurrency: number; benchmarkSnapshotMaxAgeMs: number;
  researchMinimumContextWindow: number; outcomeWindow: number; outcomeInfluenceFullAt: number;
  maxProbeLatencyMs: number; measuredSpeedMinimumRuns: number; driftWarmupRows: number;
  driftAlarmMinPoints: number; healthProbeBudgetMs: number;
}
export const DEFAULT_BENCHMARK_SNAPSHOT_MAX_AGE_MS = 2_592_000_000;
const defaults = {
  researchMinimumContextWindow: 131072, outcomeWindow: 100, outcomeInfluenceFullAt: 60,
  // Probes run with thinking enabled at the cheapest level (see 06-health), so a healthy
  // reasoning model legitimately takes seconds, not the sub-second of a no-thinking ping.
  maxProbeLatencyMs: 15_000, measuredSpeedMinimumRuns: 10, driftWarmupRows: 20,
  driftAlarmMinPoints: 12, healthProbeBudgetMs: 30_000,
} as const;
function nestedOrFlatInteger(settings: Record<string, unknown>, path: string, flatKey: string, minimum: number, maximum: number): unknown {
  const nested = getNested(settings, path);
  if (Number.isSafeInteger(nested) && (nested as number) >= minimum && (nested as number) <= maximum) return nested;
  return settings[flatKey];
}
function sub(settings: Record<string, unknown>, key: keyof typeof defaults, minimum: number, maximum: number): number {
  return boundedSafeInteger(getNested(settings, `subagents.${key}`), defaults[key], minimum, maximum);
}
export function resolveSubagentExecutionSettings(settings: Record<string, unknown>): SubagentExecutionSettings {
  const maxParallelTasks = boundedSafeInteger(nestedOrFlatInteger(settings, "subagents.maxParallelTasks", "subagentMaxParallelTasks", 1, HARD_MAX_PARALLEL_TASKS), DEFAULT_MAX_PARALLEL_TASKS, 1, HARD_MAX_PARALLEL_TASKS);
  const configuredConcurrency = boundedSafeInteger(nestedOrFlatInteger(settings, "subagents.maxConcurrency", "subagentMaxConcurrency", 1, HARD_MAX_CONCURRENCY), DEFAULT_MAX_CONCURRENCY, 1, HARD_MAX_CONCURRENCY);
  return {
    maxParallelTasks, maxConcurrency: Math.min(maxParallelTasks, configuredConcurrency),
    benchmarkSnapshotMaxAgeMs: boundedSafeInteger(getNested(settings, "subagents.autoModelSelection.benchmarkSnapshotMaxAgeMs"), DEFAULT_BENCHMARK_SNAPSHOT_MAX_AGE_MS, 60_000, 31_536_000_000),
    researchMinimumContextWindow: sub(settings, "researchMinimumContextWindow", 1, 10_000_000),
    outcomeWindow: sub(settings, "outcomeWindow", 10, 10_000),
    outcomeInfluenceFullAt: sub(settings, "outcomeInfluenceFullAt", 1, 10_000),
    maxProbeLatencyMs: sub(settings, "maxProbeLatencyMs", 1, 120_000),
    measuredSpeedMinimumRuns: sub(settings, "measuredSpeedMinimumRuns", 1, 10_000),
    driftWarmupRows: sub(settings, "driftWarmupRows", 2, 10_000),
    driftAlarmMinPoints: sub(settings, "driftAlarmMinPoints", 1, 100),
    healthProbeBudgetMs: sub(settings, "healthProbeBudgetMs", 100, 120_000),
  };
}
export async function getSubagentExecutionSettings(): Promise<SubagentExecutionSettings> { return resolveSubagentExecutionSettings(await createSettingsStore().read()); }
