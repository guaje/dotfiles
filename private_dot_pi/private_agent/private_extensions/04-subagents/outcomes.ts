import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoutingProfile, ThinkingLevel } from "./benchmark-types.ts";
import type { SingleResult } from "./types.ts";

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_OUTCOMES_PATH = path.join(AGENT_ROOT, "subagent-outcomes.json");
export const FAST_ALPHA = 0.25;
export const SLOW_ALPHA = 0.05;
export const DRIFT_WIGGLE_MULTIPLIER = 2.5;
const RETRY_DELEGATIONS = 3;
const RETRY_MS = 15 * 60_000;

export type OutcomeVerdict = "success" | "overridden" | "failed";
export interface OutcomeRow {
  id: string; finishedAt: number; startedAt: number; durationMs: number; ttftMs: number;
  session: string; agent: string; profile: RoutingProfile; model: string; selector: string; thinkingLevel?: ThinkingLevel;
  exitCode: number; stopReason?: string; errorText?: string; turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd: number;
  taskFingerprint: string; taskHead: string; outcome: OutcomeVerdict; outcomeSource: "auto"; retryOf?: string;
  expectedOutputTokens: number;
}
export interface OutcomeStore { version: 1; rows: OutcomeRow[]; explorationCounter: Partial<Record<RoutingProfile, number>>; }
export interface OutcomeSummary {
  model: string; profile: RoutingProfile; observations: number; successes: number; successRate: number;
  effectiveCostPerDone: number; effectiveTimePerDoneMs: number; medianTurns: number; effectiveTokSec?: number;
  successDrift: boolean; timeDrift: boolean; effortYield: Partial<Record<ThinkingLevel, number>>;
}
export interface DriftSettings { warmupRows: number; alarmMinPoints: number; }

const emptyStore = (): OutcomeStore => ({ version: 1, rows: [], explorationCounter: {} });
const finite = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isFinite(value) && value >= min;
function validRow(value: unknown): value is OutcomeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.session === "string" && typeof row.agent === "string" && typeof row.profile === "string" && typeof row.model === "string" && typeof row.taskFingerprint === "string" && typeof row.taskHead === "string" && ["success", "overridden", "failed"].includes(String(row.outcome)) && finite(row.finishedAt) && finite(row.startedAt) && finite(row.durationMs) && finite(row.ttftMs) && finite(row.turns) && finite(row.costUsd) && !!row.tokens && typeof row.tokens === "object";
}
export async function loadOutcomeStore(file = process.env.PI_SUBAGENT_OUTCOMES_PATH ?? DEFAULT_OUTCOMES_PATH): Promise<OutcomeStore> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyStore();
    const store = value as Record<string, unknown>;
    if (store.version !== 1 || !Array.isArray(store.rows) || !store.rows.every(validRow) || !store.explorationCounter || typeof store.explorationCounter !== "object") return emptyStore();
    return value as OutcomeStore;
  } catch { return emptyStore(); }
}
async function saveOutcomeStore(store: OutcomeStore, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file); await chmod(file, 0o600);
}
export function normalizeTask(task: string): string { return task.trim().replace(/\s+/g, " ").toLowerCase(); }
export function taskFingerprint(task: string): string { return createHash("sha256").update(normalizeTask(task)).digest("hex"); }
export function taskHead(task: string): string { return normalizeTask(task).slice(0, 60); }

export interface RecordOutcomeOptions { startedAt: number; ttftMs: number; session: string; profile: RoutingProfile; expectedOutputTokens: number; outcomeWindow: number; file?: string; finishedAt?: number; }
async function recordSubagentOutcomeInternal(result: SingleResult, options: RecordOutcomeOptions): Promise<OutcomeRow | null> {
  if (!result.model) return null;
  const file = options.file ?? process.env.PI_SUBAGENT_OUTCOMES_PATH ?? DEFAULT_OUTCOMES_PATH, store = await loadOutcomeStore(file), finishedAt = options.finishedAt ?? Date.now();
  const fingerprint = taskFingerprint(result.task);
  const recent = store.rows.slice(-RETRY_DELEGATIONS).reverse().find((row) => row.session === options.session && row.agent === result.agent && row.taskFingerprint === fingerprint && finishedAt - row.finishedAt <= RETRY_MS);
  if (recent && recent.outcome === "success") recent.outcome = "overridden";
  const failed = result.exitCode !== 0 || !!result.errorMessage || !!result.stderr.trim() || result.stopReason === "error" || result.stopReason === "aborted";
  const row: OutcomeRow = {
    id: randomUUID(), finishedAt, startedAt: options.startedAt, durationMs: Math.max(1, finishedAt - options.startedAt), ttftMs: Math.max(1, options.ttftMs),
    session: options.session, agent: result.agent, profile: options.profile, model: result.model, selector: result.modelSelector ?? "default",
    ...(result.thinkingLevel ? { thinkingLevel: result.thinkingLevel } : {}), exitCode: result.exitCode,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}), ...(result.errorMessage || result.stderr ? { errorText: result.errorMessage || result.stderr.slice(0, 500) } : {}),
    turns: result.usage.turns, tokens: { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite }, costUsd: result.usage.cost,
    taskFingerprint: fingerprint, taskHead: taskHead(result.task), outcome: failed ? "failed" : "success", outcomeSource: "auto", ...(recent ? { retryOf: recent.id } : {}), expectedOutputTokens: options.expectedOutputTokens,
  };
  store.rows.push(row);
  const counts = new Map<string, number>();
  store.rows = store.rows.slice().reverse().filter((entry) => {
    const key = `${entry.model}\0${entry.profile}`, count = (counts.get(key) ?? 0) + 1; counts.set(key, count); return count <= options.outcomeWindow;
  }).reverse().slice(-10_000);
  await saveOutcomeStore(store, file); return row;
}
const mutationQueues = new Map<string, Promise<void>>();
export async function recordSubagentOutcome(result: SingleResult, options: RecordOutcomeOptions): Promise<OutcomeRow | null> {
  const file = options.file ?? process.env.PI_SUBAGENT_OUTCOMES_PATH ?? DEFAULT_OUTCOMES_PATH;
  const previous = mutationQueues.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  mutationQueues.set(file, chained);
  await previous;
  try { return await recordSubagentOutcomeInternal(result, { ...options, file }); }
  finally { release(); if (mutationQueues.get(file) === chained) mutationQueues.delete(file); }
}

function ewma(values: number[], alpha: number): number { let result = values[0] ?? 0; for (const value of values.slice(1)) result = alpha * value + (1 - alpha) * result; return result; }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return 0; const at = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[at]! : (sorted[at - 1]! + sorted[at]!) / 2; }
export function summarizeOutcomes(rows: OutcomeRow[], settings: DriftSettings): OutcomeSummary[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const row of rows) { const key = `${row.model}\0${row.profile}`; const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => a.finishedAt - b.finishedAt), successes = ordered.filter((row) => row.outcome === "success"), binary = ordered.map((row) => row.outcome === "success" ? 100 : 0);
    const fast = ewma(binary, FAST_ALPHA), slow = ewma(binary, SLOW_ALPHA);
    const differences: number[] = []; let f = binary[0] ?? 0, s = f;
    for (const value of binary.slice(1)) { f = FAST_ALPHA * value + (1 - FAST_ALPHA) * f; s = SLOW_ALPHA * value + (1 - SLOW_ALPHA) * s; differences.push(s - f); }
    const historical = differences.slice(0, Math.max(1, settings.warmupRows - 1));
    const wiggle = Math.sqrt(historical.reduce((sum, value) => sum + value * value, 0) / Math.max(1, historical.length));
    const durations = successes.map((row) => row.durationMs), recentDuration = ewma(durations, FAST_ALPHA), slowDuration = ewma(durations, SLOW_ALPHA);
    const outputTokens = successes.reduce((sum, row) => sum + row.tokens.output, 0), durationMs = successes.reduce((sum, row) => sum + row.durationMs, 0);
    const effortYield: Partial<Record<ThinkingLevel, number>> = {};
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]) { const at = ordered.filter((row) => row.thinkingLevel === level); if (at.length) effortYield[level] = at.filter((row) => row.outcome === "success").length / at.length; }
    return {
      model: ordered[0]!.model, profile: ordered[0]!.profile, observations: ordered.length, successes: successes.length, successRate: successes.length / ordered.length,
      effectiveCostPerDone: ordered.reduce((sum, row) => sum + row.costUsd, 0) / Math.max(1, successes.length), effectiveTimePerDoneMs: ordered.reduce((sum, row) => sum + row.durationMs, 0) / Math.max(1, successes.length),
      medianTurns: median(successes.map((row) => row.turns)), ...(durationMs > 0 ? { effectiveTokSec: outputTokens / (durationMs / 1000) } : {}),
      successDrift: ordered.length >= settings.warmupRows && slow - fast >= Math.max(settings.alarmMinPoints, DRIFT_WIGGLE_MULTIPLIER * wiggle),
      timeDrift: ordered.length >= settings.warmupRows && slowDuration > 0 && recentDuration >= 1.4 * slowDuration && Math.abs(slow - fast) < settings.alarmMinPoints,
      effortYield,
    };
  });
}
export function confidenceFor(observations: number, fullAt: number): number { return Math.min(1, Math.max(0, observations) / Math.max(1, fullAt)); }
// History measures reliability, never capability, so its ranking weight is capped by policy: capability
// evidence decides the route, and measured history only nudges near-ties (drift alarms veto separately).
export function historyInfluence(observations: number, fullAt: number, maxInfluence: number): number { return Math.min(Math.max(0, maxInfluence), confidenceFor(observations, fullAt)); }
export function blendPercentiles(outside: number, own: number, observations: number, fullAt: number, maxInfluence = 1): number { const weight = historyInfluence(observations, fullAt, maxInfluence); return weight * own + (1 - weight) * outside; }
