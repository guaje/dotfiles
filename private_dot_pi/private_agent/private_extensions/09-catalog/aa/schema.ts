import { createHash } from "node:crypto";

export type ThinkingLevel = null | "off" | "low" | "medium" | "high" | "xhigh" | "max";
export interface BatchMapping { provider: string; model: string; thinkingLevel: ThinkingLevel; aaModelId: string; }
export interface CanonicalMapping extends BatchMapping { canonicalId: string; }
export interface ManifestEntry { provider: string; model: string; thinkingLevel: ThinkingLevel; modelId: string; file: string; capturedAt: number; contentDigest: string; }
export interface ManifestV4 { version: 4; generatedAt: number; digest: string; methodology: { id: string; version: string }; models: ManifestEntry[]; }

export const METHODOLOGY = { id: "artificial-analysis-intelligence-index", version: "5" };
export const PUBLIC_METHODOLOGY_VERSION = "5.0.1";
/** Reviewed public methodology labels retained at read time so a version bump --refresh-all can replace an
 * old generation rather than making it unreadable. A snapshot must still name its exact published label. */
export const PUBLIC_METHODOLOGY_VERSIONS = ["5.0.1", "5.0"] as const;
/** Thrown when the pinned Intelligence Index methodology no longer matches upstream or local artifacts; the message names both versions. */
export class AaMethodologyMismatchError extends Error {
  constructor(message: string) { super(message); this.name = "AaMethodologyMismatchError"; }
}
export const EXTRACTOR_VERSION = "aa-current-model-rsc-v1";
export const DIMENSIONS = ["intelligence", "coding", "agentic", "toolUse", "scientificReasoning", "longContext", "instructionFollowing", "knowledge", "faithfulness"];
export const SUB_BENCHMARK_FIELDS = ["critpt", "gpqa", "hle", "ifbench"];
export const CAPABILITY_INPUTS = ["text", "image"];
export const BENCHMARK_HEALTH_FIELDS = ["agenticIndex", "automationBench", "critpt", "gdpvalNormalized", "gpqa", "hle", "ifbench", "lcr", "omniscienceAccuracy", "omniscienceHallucinationRate", "tau2", "tau3Banking", "terminalBench21", "terminalBench40"];
export const BENCHMARK_HEALTH_STATUSES = ["active", "lagging", "retired", "unknown"];
/**
 * The names AA publishes each watched metric under, per source. Publication consumes the authenticated API
 * first and the public page second, so availability must be judged on both surfaces: a field can disappear from
 * the page payload while the API keeps scoring it (the Agentic Index) or be renamed on the page (tau-banking is
 * published as `tauBanking`). An empty page list means the metric has never been page-published.
 */
export const BENCHMARK_HEALTH_SOURCE_KEYS: Record<(typeof BENCHMARK_HEALTH_FIELDS)[number], { page: string[]; api: string[] }> = {
	agenticIndex: { page: ["agenticIndex"], api: ["artificial_analysis_agentic_index"] },
	automationBench: { page: ["automationBenchPartialScore"], api: [] },
	critpt: { page: ["critpt"], api: ["critpt"] },
	gdpvalNormalized: { page: ["gdpvalNormalized"], api: ["gdpval_aa_normalized"] },
	gpqa: { page: ["gpqa"], api: ["gpqa_diamond"] },
	hle: { page: ["hle"], api: ["hle"] },
	ifbench: { page: ["ifbench"], api: ["ifbench"] },
	lcr: { page: ["lcr"], api: ["aa_lcr"] },
	omniscienceAccuracy: { page: ["omniscienceAccuracy"], api: ["aa_omniscience_accuracy"] },
	omniscienceHallucinationRate: { page: ["omniscienceHallucinationRate"], api: ["aa_omniscience_non_hallucination_rate"] },
	tau2: { page: ["tau2"], api: ["tau2_telecom"] },
	tau3Banking: { page: ["tauBanking", "tau3Banking"], api: ["tau_banking"] },
	terminalBench21: { page: ["terminalBench21"], api: [] },
	terminalBench40: { page: ["terminalBench40"], api: [] },
};
export type BenchmarkHealthField = (typeof BENCHMARK_HEALTH_FIELDS)[number];
export const PROFILE_NAMES = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"];
const LEVELS = new Set<unknown>([null, "off", "low", "medium", "high", "xhigh", "max"]);
const SHA256 = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(codePointCompare);
  const expected = [...keys].sort(codePointCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort(codePointCompare).map((key) => [key, canonicalize(value[key])]));
  return value;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
export function canonicalDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function compareIdentity(a: { provider: string; model: string; thinkingLevel: ThinkingLevel }, b: { provider: string; model: string; thinkingLevel: ThinkingLevel }): number {
  return codePointCompare(a.provider, b.provider) || codePointCompare(a.model, b.model) || codePointCompare(a.thinkingLevel ?? "", b.thinkingLevel ?? "");
}
export function isThinkingLevel(value: unknown): value is ThinkingLevel { return LEVELS.has(value); }
function finite(value: unknown, minimum = -Infinity, maximum = Infinity): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function safeText(value: unknown): value is string { return nonempty(value) && !/[\x00-\x1f\x7f]/.test(value); }
function validMethodology(value: unknown): boolean { return isRecord(value) && exactKeys(value, ["id", "version"]) && value.id === METHODOLOGY.id && value.version === METHODOLOGY.version; }
function validProfileMetrics(value: unknown): boolean { return isRecord(value) && Object.entries(value).every(([key, metric]) => PROFILE_NAMES.includes(key) && (metric === null || finite(metric, 0))); }
function validComponent(value: unknown, id: string, capturedAt: number, publicPage: Record<string, unknown>): boolean {
  if (!isRecord(value) || !exactKeys(value, ["normalizedScore", "sourceKind", "fieldPath", "benchmark", "retrievedAt", "sourceUrl", "sourceRecordDigest"])) return false;
  if (!finite(value.normalizedScore, 0, 100) || (value.sourceKind !== "api" && value.sourceKind !== "public-page") || !nonempty(value.fieldPath) || !finite(value.retrievedAt, 1, capturedAt) || !nonempty(value.sourceUrl) || !SHA256.test(String(value.sourceRecordDigest))) return false;
  if (!isRecord(value.benchmark) || !exactKeys(value.benchmark, ["id", "version", "status"]) || value.benchmark.id !== id || !nonempty(value.benchmark.version) || !nonempty(value.benchmark.status)) return false;
  // Existing immutable snapshots may retain the historical full endpoint; new service writes use free only.
  if (value.sourceKind === "api") return value.sourceUrl === "https://artificialanalysis.ai/api/v2/language/models" || value.sourceUrl === "https://artificialanalysis.ai/api/v2/language/models/free";
  return value.sourceUrl === publicPage.url && value.sourceRecordDigest === publicPage.recordSha256;
}

const SNAPSHOT_KEYS = ["version", "provider", "model", "thinkingLevel", "modelId", "capturedAt", "methodology", "mapping", "source", "publicPage", "scores", "toolUse", "outputTokens", "taskTimeMs", "coverage"];
const OPTIONAL_SNAPSHOT_KEYS = ["subBenchmarks", "capabilities"];

/** Reviewed capability evidence copied verbatim from the exact-identity public page record. */
export function validateSnapshotCapabilities(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (!keys.length || !keys.every((key) => key === "input" || key === "reasoning")) return false;
  if ("input" in value && (!Array.isArray(value.input) || !value.input.length || !value.input.every((modality) => CAPABILITY_INPUTS.includes(String(modality))) || new Set(value.input).size !== value.input.length)) return false;
  if ("reasoning" in value && typeof value.reasoning !== "boolean") return false;
  return true;
}

export function validateSnapshot(value: unknown): boolean {
  const keys = isRecord(value) ? Object.keys(value) : [];
  if (!isRecord(value) || !SNAPSHOT_KEYS.every((key) => keys.includes(key)) || !keys.every((key) => SNAPSHOT_KEYS.includes(key) || OPTIONAL_SNAPSHOT_KEYS.includes(key))) return false;
  // Optional raw sub-benchmark values (0-100 domain) let reviewed fallback sources survive upstream retirement; legacy snapshots remain valid without them.
  if ("subBenchmarks" in value && (!isRecord(value.subBenchmarks) || !exactKeys(value.subBenchmarks, SUB_BENCHMARK_FIELDS) || !Object.values(value.subBenchmarks).every((metric) => metric === null || finite(metric, 0, 100)))) return false;
  if ("capabilities" in value && !validateSnapshotCapabilities(value.capabilities)) return false;
  if (value.version !== 4 || !safeText(value.provider) || !safeText(value.model) || !isThinkingLevel(value.thinkingLevel) || typeof value.modelId !== "string" || !UUID.test(value.modelId) || !finite(value.capturedAt, 1) || !validMethodology(value.methodology) || !finite(value.coverage, 0, 1)) return false;
  const capturedAt = value.capturedAt as number;
  if (!isRecord(value.mapping) || !exactKeys(value.mapping, ["status", "matchBasis", "reviewedAt", "thinkingLevel"]) || value.mapping.status !== "mapped" || value.mapping.matchBasis !== "manual" || !finite(value.mapping.reviewedAt, 1, capturedAt) || value.mapping.thinkingLevel !== value.thinkingLevel) return false;
  if (!isRecord(value.source) || !exactKeys(value.source, ["name", "slug", "openrouterApiId"]) || !safeText(value.source.name) || typeof value.source.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.source.slug) || (value.source.openrouterApiId !== null && (typeof value.source.openrouterApiId !== "string" || /[\x00-\x1f\x7f]/.test(value.source.openrouterApiId)))) return false;
  if (!isRecord(value.publicPage) || !exactKeys(value.publicPage, ["url", "retrievedAt", "contentSha256", "recordSha256", "extractorVersion", "intelligenceIndexMethodologyVersion"])) return false;
  if (value.publicPage.url !== `https://artificialanalysis.ai/models/${value.source.slug}` || !finite(value.publicPage.retrievedAt, 1, capturedAt) || !SHA256.test(String(value.publicPage.contentSha256)) || !SHA256.test(String(value.publicPage.recordSha256)) || value.publicPage.extractorVersion !== EXTRACTOR_VERSION || !PUBLIC_METHODOLOGY_VERSIONS.includes(value.publicPage.intelligenceIndexMethodologyVersion)) return false;
  if (!isRecord(value.scores) || !exactKeys(value.scores, DIMENSIONS)) return false;
  let present = 0;
  for (const dimension of DIMENSIONS) { const score = value.scores[dimension]; if (score !== null && !finite(score, 0, 100)) return false; if (score !== null) present++; }
  if (Math.abs((value.coverage as number) - present / DIMENSIONS.length) > 1e-9 || !validProfileMetrics(value.outputTokens) || !validProfileMetrics(value.taskTimeMs)) return false;
  if (!isRecord(value.toolUse) || !exactKeys(value.toolUse, ["components", "derivation"]) || !isRecord(value.toolUse.components) || !exactKeys(value.toolUse.components, ["tau3Banking", "gdpvalAaNormalized", "tau2Telecom"]) || !isRecord(value.toolUse.derivation) || !exactKeys(value.toolUse.derivation, ["version", "rule", "score"]) || (value.toolUse.derivation.version !== "v1" && value.toolUse.derivation.version !== "v2")) return false;
  const components = value.toolUse.components;
  for (const [key, id] of [["tau3Banking", "tau3-banking"], ["gdpvalAaNormalized", "gdpval-aa"], ["tau2Telecom", "tau2-telecom"]]) if (components[key] !== null && !validComponent(components[key], id, capturedAt, value.publicPage)) return false;
  const tau3 = components.tau3Banking as Record<string, unknown> | null;
  const gdp = components.gdpvalAaNormalized as Record<string, unknown> | null;
  const tau2 = components.tau2Telecom as Record<string, unknown> | null;
  // A v1 artifact published a composite only when both reviewed components existed. The v2 ladder additionally
  // accepts the surviving component sets AA still publishes now that gdpval-aa is retired upstream. Both wire
  // versions stay valid, and each version's ladder is enforced independently, so a v1 artifact cannot claim a
  // rule its own ladder never produced.
  const v2 = value.toolUse.derivation.version === "v2";
  const blend = (left: Record<string, unknown>, right: Record<string, unknown>, rule: string) => ({ rule, score: ((left.normalizedScore as number) + (right.normalizedScore as number)) / 2 });
  const expected = tau3 && gdp
    ? blend(tau3, gdp, "tau3-banking+gdpval-aa")
    : v2 && tau3 && tau2
      ? blend(tau3, tau2, "tau3-banking+tau2-telecom")
      : v2 && tau3
        ? { rule: "tau3-banking-single", score: tau3.normalizedScore }
        : tau2
          ? { rule: "tau2-telecom-fallback", score: tau2.normalizedScore }
          : { rule: "unavailable", score: null };
  return value.toolUse.derivation.rule === expected.rule && value.toolUse.derivation.score === expected.score && value.scores.toolUse === expected.score;
}

function validateManifestEntry(value: unknown): value is ManifestEntry {
  return isRecord(value) && exactKeys(value, ["provider", "model", "thinkingLevel", "modelId", "file", "capturedAt", "contentDigest"]) && safeText(value.provider) && safeText(value.model) && isThinkingLevel(value.thinkingLevel) && typeof value.modelId === "string" && UUID.test(value.modelId) && typeof value.file === "string" && /^[A-Za-z0-9._-]+\.json$/.test(value.file) && !value.file.includes("..") && finite(value.capturedAt, 1) && typeof value.contentDigest === "string" && SHA256.test(value.contentDigest);
}
export function validateManifest(value: unknown): value is ManifestV4 {
  if (!isRecord(value) || !exactKeys(value, ["version", "generatedAt", "digest", "methodology", "models"]) || value.version !== 4 || !finite(value.generatedAt, 1) || typeof value.digest !== "string" || !SHA256.test(value.digest) || !validMethodology(value.methodology) || !Array.isArray(value.models)) return false;
  const identities = new Set<string>(); const files = new Set<string>(); const ids = new Set<string>(); const levels = new Map<string, Set<ThinkingLevel>>();
  for (const entry of value.models) {
    if (!validateManifestEntry(entry)) return false;
    const modelKey = `${entry.provider}\0${entry.model}`; const identity = `${modelKey}\0${entry.thinkingLevel ?? ""}`; const modelId = `${modelKey}\0${entry.modelId}`; const fileKey = `${entry.file}\0${identity}`;
    if (identities.has(identity) || files.has(fileKey) || ids.has(modelId)) return false;
    identities.add(identity); files.add(fileKey); ids.add(modelId);
    const variants = levels.get(modelKey) ?? new Set<ThinkingLevel>(); variants.add(entry.thinkingLevel); levels.set(modelKey, variants); if (variants.size > 1 && variants.has(null)) return false;
  }
  return true;
}
export function manifestEntriesDigest(entries: readonly ManifestEntry[]): string { return canonicalDigest([...entries].sort(compareIdentity)); }

function validBatchEntry(value: unknown): value is BatchMapping { return isRecord(value) && exactKeys(value, ["provider", "model", "thinkingLevel", "aaModelId"]) && safeText(value.provider) && safeText(value.model) && isThinkingLevel(value.thinkingLevel) && typeof value.aaModelId === "string" && UUID.test(value.aaModelId); }
export function validateBatchMappings(value: unknown): value is BatchMapping[] {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>(); const ids = new Set<string>(); const levels = new Map<string, Set<ThinkingLevel>>();
  for (const entry of value) {
    if (!validBatchEntry(entry)) return false;
    const modelKey = `${entry.provider}\0${entry.model}`; const identity = `${modelKey}\0${entry.thinkingLevel ?? ""}`; const modelId = `${modelKey}\0${entry.aaModelId}`;
    if (identities.has(identity) || ids.has(modelId)) return false;
    identities.add(identity); ids.add(modelId);
    const variants = levels.get(modelKey) ?? new Set<ThinkingLevel>(); variants.add(entry.thinkingLevel); levels.set(modelKey, variants); if (variants.size > 1 && variants.has(null)) return false;
  }
  return true;
}
export function validateCanonicalMappings(value: unknown): value is { version: 1; mappings: CanonicalMapping[] } {
  if (!isRecord(value) || !exactKeys(value, ["version", "mappings"]) || value.version !== 1 || !Array.isArray(value.mappings)) return false;
  const aliases = new Map<string, string>(); const runtimeBatches = new Map<string, BatchMapping[]>(); const canonical = new Map<string, BatchMapping>();
  for (const entry of value.mappings) {
    if (!isRecord(entry) || !exactKeys(entry, ["provider", "model", "canonicalId", "thinkingLevel", "aaModelId"]) || !safeText(entry.provider) || !safeText(entry.model) || !safeText(entry.canonicalId) || !isThinkingLevel(entry.thinkingLevel) || typeof entry.aaModelId !== "string" || !UUID.test(entry.aaModelId)) return false;
    const runtime = `${entry.provider}/${entry.model}`; if (aliases.has(runtime) && aliases.get(runtime) !== entry.canonicalId) return false; aliases.set(runtime, entry.canonicalId as string);
    const runtimeBatch = runtimeBatches.get(runtime) ?? []; runtimeBatch.push({ provider: String(entry.provider), model: String(entry.model), thinkingLevel: entry.thinkingLevel as ThinkingLevel, aaModelId: String(entry.aaModelId) }); runtimeBatches.set(runtime, runtimeBatch);
    const parts = String(entry.canonicalId).split("/"); const batch = { provider: parts[0] ?? "", model: parts.slice(1).join("/"), thinkingLevel: entry.thinkingLevel as ThinkingLevel, aaModelId: String(entry.aaModelId) };
    const canonicalLevel = `${entry.canonicalId}\0${entry.thinkingLevel ?? ""}`; const existing = canonical.get(canonicalLevel);
    if (existing && existing.aaModelId !== batch.aaModelId) return false;
    canonical.set(canonicalLevel, existing ?? batch);
  }
  return [...runtimeBatches.values()].every(validateBatchMappings) && validateBatchMappings([...canonical.values()]);
}
export function extractStrictV3Mappings(value: unknown): BatchMapping[] | null {
  if (!isRecord(value) || !exactKeys(value, ["version", "models"]) || value.version !== 3 || !Array.isArray(value.models)) return null;
  const mappings: BatchMapping[] = [];
  for (const entry of value.models) {
    if (!isRecord(entry) || !exactKeys(entry, ["provider", "model", "thinkingLevel", "aaModelId", "file", "capturedAt", "contentDigest"]) || !nonempty(entry.provider) || !nonempty(entry.model) || !isThinkingLevel(entry.thinkingLevel) || typeof entry.aaModelId !== "string" || !UUID.test(entry.aaModelId) || typeof entry.file !== "string" || !finite(entry.capturedAt, 1) || typeof entry.contentDigest !== "string" || !SHA256.test(entry.contentDigest)) return null;
    mappings.push({ provider: entry.provider, model: entry.model, thinkingLevel: entry.thinkingLevel, aaModelId: entry.aaModelId });
  }
  return validateBatchMappings(mappings) ? mappings : null;
}
/** Migration bridge: a digest-verified v4 manifest pinned to a different methodology version yields its mappings so the next publication republishes them under the current pin. Snapshots are never trusted across methodology versions. */
export function extractLegacyV4Mappings(value: unknown): BatchMapping[] | null {
  if (!isRecord(value) || !exactKeys(value, ["version", "generatedAt", "digest", "methodology", "models"]) || value.version !== 4 || !finite(value.generatedAt, 1) || typeof value.digest !== "string" || !isRecord(value.methodology) || value.methodology.id !== METHODOLOGY.id || typeof value.methodology.version !== "string" || value.methodology.version === METHODOLOGY.version || !Array.isArray(value.models)) return null;
  const entries: ManifestEntry[] = [];
  for (const entry of value.models) { if (!validateManifestEntry(entry)) return null; entries.push(entry); }
  const mappings = entries.map((entry) => ({ provider: entry.provider, model: entry.model, thinkingLevel: entry.thinkingLevel, aaModelId: entry.modelId }));
  return manifestEntriesDigest(entries) === value.digest && validateBatchMappings(mappings) ? mappings : null;
}
export function semanticSnapshotDigest(value: unknown): string {
  const copy = structuredClone(value) as Record<string, unknown>; delete copy.capturedAt;
  if (isRecord(copy.publicPage)) delete copy.publicPage.retrievedAt;
  if (isRecord(copy.toolUse) && isRecord(copy.toolUse.components)) for (const component of Object.values(copy.toolUse.components)) if (isRecord(component)) delete component.retrievedAt;
  return canonicalDigest(copy);
}

export interface BenchmarkFieldHealth { checked: number; scored: number; status: "active" | "lagging" | "retired" | "unknown"; newestScoredRelease: string | null; }
export interface BenchmarkHealthV1 {
  version: 1; generatedAt: number; digest: string; methodology: { id: string; version: string };
  fields: Record<(typeof BENCHMARK_HEALTH_FIELDS)[number], BenchmarkFieldHealth>;
}
export function benchmarkHealthDigest(value: { version: 1; methodology: { id: string; version: string }; fields: BenchmarkHealthV1["fields"] }): string {
  return canonicalDigest({ version: value.version, methodology: value.methodology, fields: value.fields });
}
/** Strict contract for the generated benchmark-health artifact. The digest binds version, methodology pin, and field evidence together. */
export function validateBenchmarkHealth(value: unknown): value is BenchmarkHealthV1 {
  if (!isRecord(value) || !exactKeys(value, ["version", "generatedAt", "digest", "methodology", "fields"]) || value.version !== 1 || !finite(value.generatedAt, 1)) return false;
  if (!isRecord(value.methodology) || !exactKeys(value.methodology, ["id", "version"]) || value.methodology.id !== METHODOLOGY.id || value.methodology.version !== METHODOLOGY.version) return false;
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) return false;
  if (!isRecord(value.fields) || !exactKeys(value.fields, BENCHMARK_HEALTH_FIELDS)) return false;
  for (const key of BENCHMARK_HEALTH_FIELDS) {
    const entry = value.fields[key];
    if (!isRecord(entry) || !exactKeys(entry, ["checked", "scored", "status", "newestScoredRelease"])) return false;
    if (!finite(entry.checked, 0, 100) || !Number.isInteger(entry.checked) || !finite(entry.scored, 0, 100) || !Number.isInteger(entry.scored) || entry.scored > (entry.checked as number)) return false;
    if (!BENCHMARK_HEALTH_STATUSES.includes(String(entry.status))) return false;
    if (entry.newestScoredRelease !== null && (typeof entry.newestScoredRelease !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.newestScoredRelease))) return false;
  }
  return benchmarkHealthDigest(value as unknown as BenchmarkHealthV1) === value.digest;
}
