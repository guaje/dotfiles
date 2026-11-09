import { PUBLIC_METHODOLOGY_VERSION } from "../09-catalog/aa/schema.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type BenchmarkThinkingLevel = Exclude<ThinkingLevel, "minimal"> | null;
export type SubBenchmarkField = "critpt" | "gpqa" | "hle" | "ifbench";
export type BenchmarkHealthStatus = "active" | "lagging" | "retired" | "unknown";
export type BenchmarkHealth = Partial<Record<string, { checked: number; scored: number; status: BenchmarkHealthStatus; newestScoredRelease: string | null }>>;
export interface BenchmarkHealthState { generatedAt: number; fields: BenchmarkHealth; }

export const BENCHMARK_DIMENSIONS = [
  "coding", "agentic", "toolUse", "reasoning", "math", "longContext", "instructionFollowing", "knowledge", "faithfulness",
] as const;
export type BenchmarkDimension = (typeof BENCHMARK_DIMENSIONS)[number];
export type RoutingProfile = "balanced" | "coding" | "agentic" | "research" | "planning" | "review" | "long-context";
export interface BenchmarkMethodology { id: string; version: string; }
export interface PublicPageProvenance { url: string; retrievedAt: number; contentSha256: string; recordSha256: string; extractorVersion: "aa-current-model-rsc-v1"; intelligenceIndexMethodologyVersion: typeof PUBLIC_METHODOLOGY_VERSION; }
export interface BenchmarkComponent { normalizedScore: number; sourceKind: "api" | "public-page"; fieldPath: string; benchmark: { id: "tau3-banking" | "gdpval-aa" | "tau2-telecom"; version: string; status: string }; retrievedAt: number; sourceUrl: string; sourceRecordDigest: string; }
export interface ToolUseProvenance { components: { tau3Banking: BenchmarkComponent | null; gdpvalAaNormalized: BenchmarkComponent | null; tau2Telecom: BenchmarkComponent | null }; derivation: { version: "v1" | "v2"; rule: string; score: number | null }; }

/** Runtime evidence can combine archived BenchLM categories with AA-only fallback columns. */
export interface BenchmarkSnapshot {
  version: number; provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel; modelId: string; capturedAt: number;
  methodology: BenchmarkMethodology;
  mapping: { status: "mapped"; matchBasis: "manual"; reviewedAt: number; thinkingLevel: BenchmarkThinkingLevel };
  source: { name: string; slug: string; openrouterApiId: string | null };
  publicPage?: PublicPageProvenance;
  scores: Partial<Record<BenchmarkDimension | "scientificReasoning" | "intelligence", number | null>>;
  /** Number of independently populated outside-evidence categories. */
  evidenceDensity?: number;
  scoreSources?: Partial<Record<BenchmarkDimension, "benchlm" | "artificial-analysis">>;
  subBenchmarks?: Record<SubBenchmarkField, number | null>;
  capabilities?: { input?: ("text" | "image")[]; reasoning?: boolean };
  toolUse: ToolUseProvenance;
  outputTokens: Partial<Record<RoutingProfile, number | null>>;
  taskTimeMs: Partial<Record<RoutingProfile, number | null>>;
  coverage: number;
}
export interface BenchmarkManifestEntry { provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel; modelId: string; file: string; capturedAt: number; contentDigest: string; }
export interface BenchmarkManifest { version: 4; generatedAt: number; digest: string; methodology: BenchmarkMethodology; models: BenchmarkManifestEntry[]; }
export interface RoutingProfilePolicy {
  weights: Record<BenchmarkDimension, number>;
  constraints: { requiredInput: "text"; minimumContextWindow: number; minimumMaxTokens: number; requiresTools: boolean };
  outputTokensMetric: RoutingProfile; expectedOutputTokens: number; qualityTolerance: number; defaultThinking: ThinkingLevel;
}
export interface RoutingInterimPolicy { stableDimensions: BenchmarkDimension[]; maxAssetAgeMs: number; basis: string; }
export interface RoutingPolicy { version: string; methodology: BenchmarkMethodology; history: { maxRankInfluence: number; basis: string }; interim: RoutingInterimPolicy; anchors: Record<BenchmarkDimension, { minimum: number; maximum: number }>; profiles: Record<RoutingProfile, RoutingProfilePolicy>; }
export interface QualityDiagnostics {
  A: number; C: number; Q: number; totalWeight: number; availableWeight: number;
  availableWeightedDimensions: BenchmarkDimension[]; missingWeightedDimensions: BenchmarkDimension[];
  sources?: Partial<Record<BenchmarkDimension, string>>;
}
export type BenchmarkGateReason = "insufficientEvidence" | "insufficientProfileEvidence" | "invalidBenchmark";
export type BenchmarkRejectionReason = "noSnapshot" | "staleCache" | "probeFailed" | "probeOverThreshold" | "unprobedBudget" | "capability" | BenchmarkGateReason | "speed" | "driftAlarm";
export interface CandidateEvaluationDiagnostics { modelId: string; benchmarkThinkingLevel?: BenchmarkThinkingLevel; basis?: "outside" | "history"; eligible: boolean; gateReason?: BenchmarkGateReason; rejectionReasons: BenchmarkRejectionReason[]; quality?: QualityDiagnostics; confidence?: number; outsidePercentile?: number; ownPercentile?: number; combinedPercentile?: number; }
export interface BenchmarkRouteDiagnostics {
  policyVersion: string; routingProfile: RoutingProfile; snapshotDigest: string; benchmarkThinkingLevel: BenchmarkThinkingLevel;
  qualityScore: number; predictedCompletionMs: number; outputTokensSource: "artificial-analysis" | "profile-default";
  candidateCount: number; exclusions: Record<string, number>; candidates: CandidateEvaluationDiagnostics[];
  sources?: string[]; unmeasured?: BenchmarkDimension[]; confidence?: number; speedDisagreement?: boolean; historyBasis?: boolean; interim?: true;
}
