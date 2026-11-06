import { ROUTING_POLICY, validateRoutingPolicy } from "./benchmark-assets.ts";
import type { BenchmarkDimension, BenchmarkGateReason, BenchmarkHealth, BenchmarkSnapshot, QualityDiagnostics, RoutingProfile } from "./benchmark-types.ts";
import type { RouteCandidate } from "./benchmark-routing.ts";

export const ROUTING_PROFILES: readonly RoutingProfile[] = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"];
export interface BenchmarkProfileQualification { profile: RoutingProfile; qualified: boolean; reason?: BenchmarkGateReason | "capability"; }
type Candidate = Pick<RouteCandidate, "input" | "contextWindow" | "maxTokens" | "supportsTools">;
export interface BenchmarkGateEvaluation { quality?: QualityDiagnostics; gateReason?: BenchmarkGateReason; }
export type BenchmarkGateMode = "strict" | "interim";

export function scoreFor(snapshot: BenchmarkSnapshot, dimension: BenchmarkDimension): number | null {
  const value = snapshot.scores[dimension] ?? (dimension === "reasoning" ? snapshot.scores.scientificReasoning : null);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Missing evidence is ignored and measured weights are renormalised. */
export function evaluateBenchmarkGates(snapshot: BenchmarkSnapshot, profile: RoutingProfile, _health?: BenchmarkHealth, mode: BenchmarkGateMode = "strict"): BenchmarkGateEvaluation {
  const policy = ROUTING_POLICY.profiles[profile];
  const stable = mode === "interim" ? new Set(ROUTING_POLICY.interim.stableDimensions) : undefined;
  const allMeasured = BENCHMARK_SCORE_DIMENSIONS.filter((dimension) => scoreFor(snapshot, dimension) !== null);
  let totalWeight = 0, availableWeight = 0, weighted = 0;
  const availableWeightedDimensions: BenchmarkDimension[] = [], missingWeightedDimensions: BenchmarkDimension[] = [];
  let invalid = false;
  for (const dimension of Object.keys(policy.weights) as BenchmarkDimension[]) {
    const weight = policy.weights[dimension];
    if (weight <= 0 || (stable && !stable.has(dimension))) continue;
    totalWeight += weight;
    const value = scoreFor(snapshot, dimension);
    if (value === null) { missingWeightedDimensions.push(dimension); continue; }
    if (value < 0 || value > 100) invalid = true;
    availableWeight += weight; weighted += weight * value;
    availableWeightedDimensions.push(dimension);
  }
  const C = totalWeight > 0 ? availableWeight / totalWeight : 0;
  const A = availableWeight > 0 ? weighted / availableWeight : 0;
  const quality: QualityDiagnostics = {
    A, C, Q: A, totalWeight, availableWeight, availableWeightedDimensions, missingWeightedDimensions,
    sources: Object.fromEntries(availableWeightedDimensions.map((dimension) => [dimension, snapshot.scoreSources?.[dimension] ?? "artificial-analysis"])),
  };
  if (invalid || totalWeight <= 0) return { quality, gateReason: "invalidBenchmark" };
  if ((snapshot.evidenceDensity ?? allMeasured.length) < 3) return { quality, gateReason: "insufficientEvidence" };
  if (!availableWeightedDimensions.length || C < 0.60) return { quality, gateReason: "insufficientProfileEvidence" };
  return { quality };
}
const BENCHMARK_SCORE_DIMENSIONS = Object.freeze([...Object.keys(ROUTING_POLICY.anchors)] as BenchmarkDimension[]);

export function candidateHasCapabilities(candidate: Candidate, profile: RoutingProfile): boolean {
  const constraints = ROUTING_POLICY.profiles[profile].constraints;
  return !!candidate.input?.includes(constraints.requiredInput)
    && (!constraints.requiresTools || candidate.supportsTools !== false)
    && (constraints.minimumContextWindow === 0 || (Number.isFinite(candidate.contextWindow) && candidate.contextWindow! >= constraints.minimumContextWindow))
    && (constraints.minimumMaxTokens === 0 || (Number.isFinite(candidate.maxTokens) && candidate.maxTokens! >= constraints.minimumMaxTokens));
}

export function qualifyBenchmarkProfiles(candidate: Candidate, snapshot: BenchmarkSnapshot, health?: BenchmarkHealth): BenchmarkProfileQualification[] {
  if (!validateRoutingPolicy(ROUTING_POLICY)) return ROUTING_PROFILES.map((profile) => ({ profile, qualified: false, reason: "invalidBenchmark" }));
  return ROUTING_PROFILES.map((profile) => {
    if (!candidateHasCapabilities(candidate, profile)) return { profile, qualified: false, reason: "capability" };
    const evaluated = evaluateBenchmarkGates(snapshot, profile, health);
    return { profile, qualified: !evaluated.gateReason, ...(evaluated.gateReason ? { reason: evaluated.gateReason } : {}) };
  });
}
