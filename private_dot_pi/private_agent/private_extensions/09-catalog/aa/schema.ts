import { createHash } from "node:crypto";

export type ThinkingLevel = null | "off" | "low" | "medium" | "high" | "xhigh" | "max";
export interface BatchMapping { provider: string; model: string; thinkingLevel: ThinkingLevel; aaModelId: string; }
export interface CanonicalMapping extends BatchMapping { canonicalId: string; }
export interface ManifestEntry { provider: string; model: string; thinkingLevel: ThinkingLevel; modelId: string; file: string; capturedAt: number; contentDigest: string; }
export interface ManifestV4 { version: 4; generatedAt: number; digest: string; methodology: { id: string; version: string }; models: ManifestEntry[]; }

export const METHODOLOGY = { id: "artificial-analysis-intelligence-index", version: "4.1" };
export const PUBLIC_METHODOLOGY_VERSION = "4.1.1";
export const EXTRACTOR_VERSION = "aa-current-model-rsc-v1";
export const DIMENSIONS = ["intelligence", "coding", "agentic", "toolUse", "scientificReasoning", "longContext", "instructionFollowing", "knowledge", "faithfulness"];
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

export function validateSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["version", "provider", "model", "thinkingLevel", "modelId", "capturedAt", "methodology", "mapping", "source", "publicPage", "scores", "toolUse", "outputTokens", "taskTimeMs", "coverage"])) return false;
  if (value.version !== 4 || !safeText(value.provider) || !safeText(value.model) || !isThinkingLevel(value.thinkingLevel) || typeof value.modelId !== "string" || !UUID.test(value.modelId) || !finite(value.capturedAt, 1) || !validMethodology(value.methodology) || !finite(value.coverage, 0, 1)) return false;
  const capturedAt = value.capturedAt as number;
  if (!isRecord(value.mapping) || !exactKeys(value.mapping, ["status", "matchBasis", "reviewedAt", "thinkingLevel"]) || value.mapping.status !== "mapped" || value.mapping.matchBasis !== "manual" || !finite(value.mapping.reviewedAt, 1, capturedAt) || value.mapping.thinkingLevel !== value.thinkingLevel) return false;
  if (!isRecord(value.source) || !exactKeys(value.source, ["name", "slug", "openrouterApiId"]) || !safeText(value.source.name) || typeof value.source.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.source.slug) || (value.source.openrouterApiId !== null && (typeof value.source.openrouterApiId !== "string" || /[\x00-\x1f\x7f]/.test(value.source.openrouterApiId)))) return false;
  if (!isRecord(value.publicPage) || !exactKeys(value.publicPage, ["url", "retrievedAt", "contentSha256", "recordSha256", "extractorVersion", "intelligenceIndexMethodologyVersion"])) return false;
  if (value.publicPage.url !== `https://artificialanalysis.ai/models/${value.source.slug}` || !finite(value.publicPage.retrievedAt, 1, capturedAt) || !SHA256.test(String(value.publicPage.contentSha256)) || !SHA256.test(String(value.publicPage.recordSha256)) || value.publicPage.extractorVersion !== EXTRACTOR_VERSION || value.publicPage.intelligenceIndexMethodologyVersion !== PUBLIC_METHODOLOGY_VERSION) return false;
  if (!isRecord(value.scores) || !exactKeys(value.scores, DIMENSIONS)) return false;
  let present = 0;
  for (const dimension of DIMENSIONS) { const score = value.scores[dimension]; if (score !== null && !finite(score, 0, 100)) return false; if (score !== null) present++; }
  if (Math.abs((value.coverage as number) - present / DIMENSIONS.length) > 1e-9 || !validProfileMetrics(value.outputTokens) || !validProfileMetrics(value.taskTimeMs)) return false;
  if (!isRecord(value.toolUse) || !exactKeys(value.toolUse, ["components", "derivation"]) || !isRecord(value.toolUse.components) || !exactKeys(value.toolUse.components, ["tau3Banking", "gdpvalAaNormalized", "tau2Telecom"]) || !isRecord(value.toolUse.derivation) || !exactKeys(value.toolUse.derivation, ["version", "rule", "score"]) || value.toolUse.derivation.version !== "v1") return false;
  const components = value.toolUse.components;
  for (const [key, id] of [["tau3Banking", "tau3-banking"], ["gdpvalAaNormalized", "gdpval-aa"], ["tau2Telecom", "tau2-telecom"]]) if (components[key] !== null && !validComponent(components[key], id, capturedAt, value.publicPage)) return false;
  const tau3 = components.tau3Banking as Record<string, unknown> | null;
  const gdp = components.gdpvalAaNormalized as Record<string, unknown> | null;
  const tau2 = components.tau2Telecom as Record<string, unknown> | null;
  const expected = tau3 && gdp ? { rule: "tau3-banking+gdpval-aa", score: ((tau3.normalizedScore as number) + (gdp.normalizedScore as number)) / 2 } : tau2 ? { rule: "tau2-telecom-fallback", score: tau2.normalizedScore } : { rule: "unavailable", score: null };
  return value.toolUse.derivation.rule === expected.rule && value.toolUse.derivation.score === expected.score && value.scores.toolUse === expected.score;
}

function validateManifestEntry(value: unknown): value is ManifestEntry {
  return isRecord(value) && exactKeys(value, ["provider", "model", "thinkingLevel", "modelId", "file", "capturedAt", "contentDigest"]) && safeText(value.provider) && safeText(value.model) && isThinkingLevel(value.thinkingLevel) && typeof value.modelId === "string" && UUID.test(value.modelId) && typeof value.file === "string" && /^[A-Za-z0-9_-]+\.json$/.test(value.file) && finite(value.capturedAt, 1) && typeof value.contentDigest === "string" && SHA256.test(value.contentDigest);
}
export function validateManifest(value: unknown): value is ManifestV4 {
  if (!isRecord(value) || !exactKeys(value, ["version", "generatedAt", "digest", "methodology", "models"]) || value.version !== 4 || !finite(value.generatedAt, 1) || typeof value.digest !== "string" || !SHA256.test(value.digest) || !validMethodology(value.methodology) || !Array.isArray(value.models)) return false;
  const identities = new Set<string>(); const files = new Set<string>(); const ids = new Set<string>(); const levels = new Map<string, Set<ThinkingLevel>>();
  for (const entry of value.models) {
    if (!validateManifestEntry(entry)) return false;
    const modelKey = `${entry.provider}\0${entry.model}`; const identity = `${modelKey}\0${entry.thinkingLevel ?? ""}`; const modelId = `${modelKey}\0${entry.modelId}`;
    if (identities.has(identity) || files.has(entry.file) || ids.has(modelId)) return false;
    identities.add(identity); files.add(entry.file); ids.add(modelId);
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
export function semanticSnapshotDigest(value: unknown): string {
  const copy = structuredClone(value) as Record<string, unknown>; delete copy.capturedAt;
  if (isRecord(copy.publicPage)) delete copy.publicPage.retrievedAt;
  if (isRecord(copy.toolUse) && isRecord(copy.toolUse.components)) for (const component of Object.values(copy.toolUse.components)) if (isRecord(component)) delete component.retrievedAt;
  return canonicalDigest(copy);
}
