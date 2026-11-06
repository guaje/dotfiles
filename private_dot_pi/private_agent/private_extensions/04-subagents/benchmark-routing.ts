import type { BenchmarkRouteDiagnostics, BenchmarkSnapshot, BenchmarkThinkingLevel, CandidateEvaluationDiagnostics, RoutingProfile, ThinkingLevel } from "./benchmark-types.ts";
import { ROUTING_POLICY, validateRoutingPolicy } from "./benchmark-assets.ts";
import { candidateHasCapabilities, evaluateBenchmarkGates, scoreFor, type BenchmarkGateMode } from "./benchmark-qualification.ts";
import type { BenchmarkHealth, BenchmarkDimension, QualityDiagnostics } from "./benchmark-types.ts";
import { aaModelIdForCanonical, canonicalIdForRuntime } from "./canonical-mappings.ts";
import { blendPercentiles, confidenceFor, type OutcomeSummary } from "./outcomes.ts";

export interface RouteCandidate { id: string; canonicalId?: string; reasoning?: boolean; supportsReasoningEffort?: boolean; supportsTools?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>; contextWindow?: number; maxTokens?: number; input?: string[]; }
export interface LocalHealth { id: string; latencyMs?: number; tokensPerSecond?: number; status?: string; service?: string; checkedAt?: number; }
export interface BenchmarkRoute { modelId?: string; diagnostics: BenchmarkRouteDiagnostics; thinkingLevel?: ThinkingLevel; }
export interface RouteOptions { maxProbeLatencyMs?: number; researchMinimumContextWindow?: number; taskChars?: number; outcomeSummaries?: OutcomeSummary[]; outcomeInfluenceFullAt?: number; measuredSpeedMinimumRuns?: number; explorationCounter?: number; }
interface RankedCandidate { candidate: RouteCandidate; snapshot: BenchmarkSnapshot; health: LocalHealth; quality: QualityDiagnostics; predictedCompletionMs: number; outputTokensSource: "artificial-analysis" | "profile-default"; childThinking?: ThinkingLevel; confidence: number; outside: number; own: number; combined: number; speedDisagreement: boolean; }
const snapshotKey = (id: string, level: BenchmarkThinkingLevel) => `${id}\0${level ?? ""}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const AA_LEVELS = new Set<BenchmarkThinkingLevel>(["off", "low", "medium", "high", "xhigh", "max"]);
function clampPiThinking(candidate: RouteCandidate, requested: ThinkingLevel): ThinkingLevel { const supported = (level: ThinkingLevel) => level === "xhigh" || level === "max" ? typeof candidate.thinkingLevelMap?.[level] === "string" : candidate.thinkingLevelMap?.[level] !== null; const at = LEVELS.indexOf(requested); for (const level of LEVELS.slice(at)) if (supported(level)) return level; for (const level of LEVELS.slice(0, at).reverse()) if (supported(level)) return level; return "off"; }
function benchmarkThinkingFor(candidate: RouteCandidate, clamped: ThinkingLevel): BenchmarkThinkingLevel { const mapped = candidate.thinkingLevelMap?.[clamped]; if (typeof mapped === "string" && AA_LEVELS.has(mapped as BenchmarkThinkingLevel)) return mapped as BenchmarkThinkingLevel; return clamped === "minimal" ? "low" : clamped; }
function percentile(value: number, values: number[]): number { if (values.length <= 1) return 100; const below = values.filter((entry) => entry < value).length, equal = values.filter((entry) => entry === value).length; return 100 * (below + (equal - 1) / 2) / (values.length - 1); }
function expectedTokens(profile: RoutingProfile, taskChars: number): number { const base = ROUTING_POLICY.profiles[profile].expectedOutputTokens; return base * Math.max(0.5, Math.min(3, taskChars / 2000)); }
export function predictCompletionTime(profile: RoutingProfile, health: LocalHealth, summary: OutcomeSummary | undefined, measuredMinimum: number, taskChars = 2000): { milliseconds: number; warm: boolean; speedDisagreement: boolean } | null {
  if (!Number.isFinite(health.latencyMs) || !Number.isFinite(health.tokensPerSecond) || health.latencyMs! < 0 || health.tokensPerSecond! <= 0) return null;
  const tokens = expectedTokens(profile, taskChars);
  const warm = !!summary && summary.successes >= measuredMinimum && Number.isFinite(summary.effectiveTokSec) && summary.effectiveTokSec! > 0;
  const throughput = warm ? summary!.effectiveTokSec! : health.tokensPerSecond!;
  const turns = warm ? Math.max(1, summary!.medianTurns) : 1;
  return { milliseconds: turns * health.latencyMs! + 1000 * tokens / throughput, warm, speedDisagreement: warm && health.tokensPerSecond! > 2 * throughput };
}

export function routeBenchmarkModel(profile: RoutingProfile, candidates: RouteCandidate[], snapshots: BenchmarkSnapshot[], health: LocalHealth[], snapshotDigest: string, requestedThinking?: ThinkingLevel, benchmarkHealth?: BenchmarkHealth, mode: BenchmarkGateMode = "strict", options: RouteOptions = {}): BenchmarkRoute {
  const exclusions: Record<string, number> = { noSnapshot: 0, staleCache: 0, probeFailed: 0, probeOverThreshold: 0, unprobedBudget: 0, capability: 0, insufficientEvidence: 0, insufficientProfileEvidence: 0, invalidBenchmark: 0, speed: 0, pareto: 0, qualityBand: 0 };
  const evaluations: CandidateEvaluationDiagnostics[] = [];
  const empty = (): BenchmarkRoute => ({ diagnostics: { policyVersion: ROUTING_POLICY.version, routingProfile: profile, snapshotDigest, benchmarkThinkingLevel: null, qualityScore: 0, predictedCompletionMs: 0, outputTokensSource: "profile-default", candidateCount: 0, exclusions, candidates: evaluations, ...(mode === "interim" ? { interim: true } : {}) } });
  if (!validateRoutingPolicy(ROUTING_POLICY)) return empty();
  const bySnapshot = new Map(snapshots.map((snapshot) => [snapshotKey(`${snapshot.provider}/${snapshot.model}`, snapshot.thinkingLevel), snapshot]));
  const byModelId = new Map(snapshots.map((snapshot) => [snapshot.modelId, snapshot]));
  const variants = new Map<string, Set<BenchmarkThinkingLevel>>();
  for (const snapshot of snapshots) { const id = `${snapshot.provider}/${snapshot.model}`, set = variants.get(id) ?? new Set<BenchmarkThinkingLevel>(); set.add(snapshot.thinkingLevel); variants.set(id, set); }
  const resolved = candidates.map((candidate) => {
    const requested = requestedThinking ?? ROUTING_POLICY.profiles[profile].defaultThinking;
    const childThinking = candidate.supportsReasoningEffort === false ? undefined : candidate.reasoning ? requested : "off";
    const benchmarkThinking = benchmarkThinkingFor(candidate, clampPiThinking(candidate, childThinking ?? requested));
    const canonicalId = canonicalIdForRuntime(candidate.id, candidate.canonicalId), aaId = aaModelIdForCanonical(canonicalId, benchmarkThinking), direct = variants.has(canonicalId) ? canonicalId : candidate.id, levels = variants.get(direct), specific = !!levels && [...levels].some((level) => level !== null);
    // An exact thinking-level match is the finest ruler and wins. When that level was never published, fall
    // back to the model's level-agnostic evidence rather than discarding the model entirely.
    const exact = bySnapshot.get(snapshotKey(direct, benchmarkThinking)), anyLevel = bySnapshot.get(snapshotKey(direct, null));
    const snapshot = aaId !== undefined ? byModelId.get(aaId) : specific ? exact ?? anyLevel : anyLevel;
    return { candidate, snapshot, childThinking };
  });
  // Rank each publisher column only against this eligible fleet. Raw values never enter the combined score.
  const dimensions = Object.keys(ROUTING_POLICY.anchors) as BenchmarkDimension[];
  const distributions = new Map<BenchmarkDimension, number[]>();
  for (const dimension of dimensions) distributions.set(dimension, resolved.flatMap(({ snapshot }) => { const value = snapshot ? scoreFor(snapshot, dimension) : null; return value === null ? [] : [value]; }));
  const byHealth = new Map(health.map((entry) => [entry.id, entry])), prelim: RankedCandidate[] = [];
  const outcomeRates = (options.outcomeSummaries ?? []).filter((entry) => entry.profile === profile && candidates.some((candidate) => candidate.id === entry.model)).map((entry) => entry.successRate);
  for (const { candidate, snapshot, childThinking } of resolved) {
    if (!snapshot) { exclusions.noSnapshot++; evaluations.push({ modelId: candidate.id, eligible: false, rejectionReasons: ["noSnapshot"] }); continue; }
    const percentileSnapshot: BenchmarkSnapshot = { ...snapshot, scores: { ...snapshot.scores } };
    for (const dimension of dimensions) { const raw = scoreFor(snapshot, dimension); (percentileSnapshot.scores as any)[dimension] = raw === null ? null : percentile(raw, distributions.get(dimension)!); }
    const reasons: CandidateEvaluationDiagnostics["rejectionReasons"] = [], local = byHealth.get(candidate.id);
    if (!local || local.status === "stale") reasons.push("staleCache");
    else if (local.status === "unprobed-budget") reasons.push("unprobedBudget");
    else if (local.status !== "ok" || (local.service ?? "chat") !== "chat" || !Number.isFinite(local.latencyMs) || !Number.isFinite(local.tokensPerSecond) || local.tokensPerSecond! <= 0) reasons.push("probeFailed");
    else if (local.latencyMs! > (options.maxProbeLatencyMs ?? Infinity)) reasons.push("probeOverThreshold");
    if (!candidateHasCapabilities(candidate, profile) || (profile === "research" && Number.isFinite(options.researchMinimumContextWindow) && (candidate.contextWindow ?? 0) < options.researchMinimumContextWindow!)) reasons.push("capability");
    const evaluated = evaluateBenchmarkGates(percentileSnapshot, profile, benchmarkHealth, mode); if (evaluated.gateReason) reasons.push(evaluated.gateReason);
    const summary = options.outcomeSummaries?.find((entry) => entry.model === candidate.id && entry.profile === profile);
    const completion = reasons.length ? null : predictCompletionTime(profile, local!, summary, options.measuredSpeedMinimumRuns ?? Infinity, options.taskChars ?? 2000); if (!reasons.length && !completion) reasons.push("speed");
    const own = summary ? percentile(summary.successRate, outcomeRates) : evaluated.quality?.A ?? 0, outside = evaluated.quality?.A ?? 0, confidence = confidenceFor(summary?.observations ?? 0, options.outcomeInfluenceFullAt ?? 60), combined = blendPercentiles(outside, own, summary?.observations ?? 0, options.outcomeInfluenceFullAt ?? 60);
    const evaluation: CandidateEvaluationDiagnostics = { modelId: candidate.id, benchmarkThinkingLevel: snapshot.thinkingLevel, eligible: reasons.length === 0, rejectionReasons: reasons, ...(evaluated.gateReason ? { gateReason: evaluated.gateReason } : {}), ...(evaluated.quality ? { quality: evaluated.quality } : {}), confidence, outsidePercentile: outside, ownPercentile: own, combinedPercentile: combined };
    evaluations.push(evaluation);
    if (reasons.length) { exclusions[reasons[0]] = (exclusions[reasons[0]] ?? 0) + 1; continue; }
    prelim.push({ candidate, snapshot, health: local!, quality: evaluated.quality!, predictedCompletionMs: completion!.milliseconds, outputTokensSource: "profile-default", childThinking, confidence, outside, own, combined, speedDisagreement: completion!.speedDisagreement });
  }
  const dominates = (a: RankedCandidate, b: RankedCandidate) => a.combined >= b.combined && a.predictedCompletionMs <= b.predictedCompletionMs && (a.combined > b.combined || a.predictedCompletionMs < b.predictedCompletionMs);
  const pareto = prelim.filter((entry) => !prelim.some((other) => other !== entry && dominates(other, entry))); exclusions.pareto = prelim.length - pareto.length;
  if (!pareto.length) return empty();
  const best = Math.max(...pareto.map((entry) => entry.combined)), tolerance = ROUTING_POLICY.profiles[profile].qualityTolerance;
  const band = pareto.filter((entry) => entry.combined >= best - tolerance); exclusions.qualityBand = pareto.length - band.length;
  band.sort((a, b) => b.combined - a.combined || a.predictedCompletionMs - b.predictedCompletionMs || (b.health.checkedAt ?? 0) - (a.health.checkedAt ?? 0) || compare(a.candidate.id, b.candidate.id));
  let winner = band[0]!, exploration = false;
  const low = prelim.filter((entry) => entry.confidence < 0.25).sort((a, b) => b.combined - a.combined || compare(a.candidate.id, b.candidate.id))[0];
  if (low && winner.combined - low.combined <= 8 && (options.explorationCounter ?? 0) > 0 && options.explorationCounter! % 4 === 0) { winner = low; exploration = low !== band[0]; }
  return { modelId: winner.candidate.id, thinkingLevel: winner.childThinking, diagnostics: { policyVersion: ROUTING_POLICY.version, routingProfile: profile, snapshotDigest, benchmarkThinkingLevel: winner.snapshot.thinkingLevel, qualityScore: winner.combined, predictedCompletionMs: winner.predictedCompletionMs, outputTokensSource: winner.outputTokensSource, candidateCount: prelim.length, exclusions, candidates: evaluations, sources: [...new Set(Object.values(winner.quality.sources ?? {}))], unmeasured: winner.quality.missingWeightedDimensions, confidence: winner.confidence, exploration, speedDisagreement: winner.speedDisagreement, ...(mode === "interim" ? { interim: true } : {}) } };
}
