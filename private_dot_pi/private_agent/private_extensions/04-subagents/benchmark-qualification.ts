import { ROUTING_POLICY, validateRoutingPolicy } from "./benchmark-assets.ts";
import type { BenchmarkGateReason, BenchmarkSnapshot, RoutingProfile } from "./benchmark-types.ts";
import type { RouteCandidate } from "./benchmark-routing.ts";

export const ROUTING_PROFILES: readonly RoutingProfile[] = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"];

export interface BenchmarkProfileQualification {
  profile: RoutingProfile;
  qualified: boolean;
  reason?: BenchmarkGateReason | "capability";
}

type Candidate = Pick<RouteCandidate, "input" | "contextWindow" | "maxTokens">;

/** Pure benchmark/capability gates. Health and local speed are intentionally evaluated later by runtime routing. */
export function qualifyBenchmarkProfiles(candidate: Candidate, snapshot: BenchmarkSnapshot): BenchmarkProfileQualification[] {
  if (!validateRoutingPolicy(ROUTING_POLICY)) return ROUTING_PROFILES.map((profile) => ({ profile, qualified: false, reason: "invalidBenchmark" }));
  return ROUTING_PROFILES.map((profile) => {
    const policy = ROUTING_POLICY.profiles[profile];
    const constraints = policy.constraints;
    const capable = !!candidate.input?.includes(constraints.requiredInput)
      && (constraints.minimumContextWindow === 0 || (Number.isFinite(candidate.contextWindow) && candidate.contextWindow! >= constraints.minimumContextWindow))
      && (constraints.minimumMaxTokens === 0 || (Number.isFinite(candidate.maxTokens) && candidate.maxTokens! >= constraints.minimumMaxTokens));
    if (!capable) return { profile, qualified: false, reason: "capability" };

    let totalWeight = 0;
    let availableWeight = 0;
    let invalid = false;
    for (const dimension of Object.keys(policy.weights) as Array<keyof typeof policy.weights>) {
      const weight = policy.weights[dimension];
      if (weight <= 0) continue;
      totalWeight += weight;
      const value = snapshot.scores[dimension];
      const anchor = ROUTING_POLICY.anchors[dimension];
      if (value !== null) {
        availableWeight += weight;
        if (!Number.isFinite(value) || value < anchor.minimum || value > anchor.maximum) invalid = true;
      }
    }
    for (const dimension of policy.requiredDimensions) if (snapshot.scores[dimension] === null) return { profile, qualified: false, reason: "missingRequiredDimension" };
    for (const [dimension, floor] of Object.entries(policy.mandatoryFloors)) {
      const score = snapshot.scores[dimension as keyof typeof snapshot.scores];
      if (score === null || score < floor!) return { profile, qualified: false, reason: "mandatoryFloor" };
    }
    if (ROUTING_POLICY.faithfulnessPolicy.appliesTo.includes(profile as "research" | "review")) {
      const score = snapshot.scores.faithfulness;
      if (score === null || score < ROUTING_POLICY.faithfulnessPolicy.floor) return { profile, qualified: false, reason: "faithfulnessFloor" };
    }
    if (!(totalWeight > 0) || availableWeight / totalWeight < policy.minimumCoverage) return { profile, qualified: false, reason: "minimumCoverage" };
    if (invalid) return { profile, qualified: false, reason: "invalidBenchmark" };
    return { profile, qualified: true };
  });
}
