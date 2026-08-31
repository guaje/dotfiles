import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { assertSecureDirectory, assertSecureFile, baseConfig, canonicalIdentity, ensureSecureDirectory, loadDiscoverConfig, loadMappings, loadRuntimeConfig, loadWriterConfig, readOptionalSecureJson, readSecureJson, type BaseConfig, type WriterConfig } from "./config.ts";
import { fetchCatalog, fetchPublicModel, type CatalogRecord, type CatalogResult, type PublicResult } from "./client.ts";
import { DIMENSIONS, METHODOLOGY, UUID, canonicalDigest, canonicalize, codePointCompare, compareIdentity, extractStrictV3Mappings, isRecord, isThinkingLevel, manifestEntriesDigest, semanticSnapshotDigest, validateBatchMappings, validateCanonicalMappings, validateManifest, validateSnapshot, type BatchMapping, type CanonicalMapping, type ManifestEntry, type ManifestV4, type ThinkingLevel } from "./schema.ts";

export interface AaCandidate { aaModelId: string; slug: string; name: string; }
export interface ReviewedVariant extends AaCandidate { thinkingLevel: ThinkingLevel; }
export interface PublicationOptions { prune?: boolean; }
export interface PublicationResult { changed: boolean; warnings: string[]; }
export interface CleanupResult { deleted: string[]; warnings: string[]; }
export interface ArtifactFingerprint { path: string; fingerprint: string; }
export interface ArtifactState {
  manifest: ArtifactFingerprint | null;
  canonicalMappings: ArtifactFingerprint | null;
  manifestSnapshotFiles: string[];
  generatedSnapshotFiles: string[];
}
export interface FileSystemHooks { beforeInstall?(file: string): void | Promise<void>; beforeManifestRename?(): void | Promise<void>; beforePrune?(file: string): void | Promise<void>; beforeSnapshotRead?(file: string): void | Promise<void>; }
export interface ServiceDependencies { fetchCatalog: typeof fetchCatalog; fetchPublicModel: typeof fetchPublicModel; now(): number; fsHooks: FileSystemHooks; }

const PRUNE_GRACE_MS = 300_000;
const GENERATED_SNAPSHOT = /^[a-f0-9]{16}-[a-f0-9]{16}\.json$/;
const digestText = (value: string) => createHash("sha256").update(value).digest("hex");
const ordered = (values: Iterable<string>) => [...new Set(values)].sort(codePointCompare);
function warning(warnings: string[], value: string): void { if (!warnings.includes(value)) warnings.push(value); }
function isMissingSnapshot(error: unknown): boolean { return error instanceof Error && error.message.startsWith("missing required file:"); }

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("operation aborted"); }
function idOf(value: { provider: string; model: string }): string { return `${value.provider}/${value.model}`; }
function splitId(id: string): [string, string] { const slash = id.indexOf("/"); if (slash <= 0 || slash === id.length - 1) throw new Error("invalid provider/model ID"); return [id.slice(0, slash), id.slice(slash + 1)]; }
function jsonPretty(value: unknown): string { return `${JSON.stringify(canonicalize(value), null, 2)}\n`; }
async function readJsonFile(file: string): Promise<unknown> {
  let text: string; try { text = await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`missing required file: ${path.basename(file)}`);
    throw new Error(`invalid JSON in ${path.basename(file)}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`invalid JSON in ${path.basename(file)}`); }
}
async function secureSnapshot(file: string, beforeSnapshotRead?: (file: string) => void | Promise<void>): Promise<unknown> { await assertSecureFile(file); await beforeSnapshotRead?.(path.basename(file)); return readJsonFile(file); }
function assertEntrySnapshot(entry: ManifestEntry, snapshot: unknown, generatedAt: number): void {
  if (!validateSnapshot(snapshot) || canonicalDigest(snapshot) !== entry.contentDigest || !isRecord(snapshot) || snapshot.provider !== entry.provider || snapshot.model !== entry.model || snapshot.thinkingLevel !== entry.thinkingLevel || snapshot.modelId !== entry.modelId || snapshot.capturedAt !== entry.capturedAt || generatedAt < entry.capturedAt) throw new Error(`invalid snapshot: ${entry.file}`);
}

interface LoadedManifest { manifest: ManifestV4; fingerprint: string; }
async function readValidatedManifest(config: BaseConfig): Promise<LoadedManifest> {
  await assertSecureFile(config.paths.manifest);
  const text = await readFile(config.paths.manifest, "utf8");
  let raw: unknown; try { raw = JSON.parse(text); } catch { throw new Error("invalid JSON in manifest.json"); }
  if (!validateManifest(raw)) throw new Error("invalid or unsupported manifest");
  if (manifestEntriesDigest(raw.models) !== raw.digest) throw new Error("manifest digest mismatch");
  return { manifest: raw, fingerprint: digestText(text) };
}
async function validateArtifactsForManifest(config: BaseConfig, loaded: LoadedManifest, requireFresh: boolean, now: number, beforeSnapshotRead?: FileSystemHooks["beforeSnapshotRead"]): Promise<{ manifest: ManifestV4; snapshots: Map<string, unknown> }> {
  const { manifest } = loaded;
  if (manifest.generatedAt > now + 60_000 || (requireFresh && now - manifest.generatedAt > config.limits.maxAgeMs)) throw new Error("benchmark manifest is not current");
  const snapshots = new Map<string, unknown>();
  for (const entry of manifest.models) {
    const file = path.join(config.paths.modelsDir, entry.file); const snapshot = await secureSnapshot(file, beforeSnapshotRead); assertEntrySnapshot(entry, snapshot, manifest.generatedAt);
    if (requireFresh && (now - entry.capturedAt > config.limits.maxAgeMs || entry.capturedAt > now + 60_000)) throw new Error(`stale snapshot: ${entry.file}`);
    snapshots.set(entry.file, snapshot);
  }
  const mappings = await readOptionalSecureJson(config.paths.mappings);
  if (mappings !== null) {
    if (!validateCanonicalMappings(mappings)) throw new Error("invalid canonical mappings");
    for (const mapping of mappings.mappings) if (!manifest.models.some((entry) => entry.modelId === mapping.aaModelId && entry.thinkingLevel === mapping.thinkingLevel && (idOf(entry) === idOf(mapping) || idOf(entry) === mapping.canonicalId))) throw new Error(`canonical mapping references a mismatched AA snapshot: ${mapping.aaModelId}`);
  }
  return { manifest, snapshots };
}
async function validateArtifacts(config: BaseConfig, requireFresh: boolean, now: number, beforeSnapshotRead?: FileSystemHooks["beforeSnapshotRead"]): Promise<{ manifest: ManifestV4; snapshots: Map<string, unknown> }> {
  await assertSecureDirectory(config.paths.snapshotRoot); await assertSecureDirectory(config.paths.modelsDir);
  const first = await readValidatedManifest(config);
  try { return await validateArtifactsForManifest(config, first, requireFresh, now, beforeSnapshotRead); }
  catch (error) {
    if (!isMissingSnapshot(error)) throw error;
    const next = await readValidatedManifest(config);
    if (next.fingerprint === first.fingerprint) throw error;
    return validateArtifactsForManifest(config, next, requireFresh, now, beforeSnapshotRead);
  }
}

function reviewedId(mappings: Awaited<ReturnType<typeof loadMappings>>, canonical: string, level: ThinkingLevel): string | undefined {
  const variants = mappings.filter((entry) => entry.canonicalId === canonical); const specific = variants.some((entry) => entry.thinkingLevel !== null); return variants.find((entry) => entry.thinkingLevel === (specific ? level : null))?.aaModelId;
}

function validateExternalIdentity(record: CatalogRecord): asserts record is CatalogRecord & { name: string; slug: string } {
  if (typeof record.name !== "string" || !record.name || /[\x00-\x1f\x7f]/.test(record.name) || typeof record.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.slug) || (record.openrouter_api_id !== undefined && record.openrouter_api_id !== null && (typeof record.openrouter_api_id !== "string" || /[\x00-\x1f\x7f]/.test(record.openrouter_api_id)))) throw new Error("reviewed AA model has invalid identity fields");
}

const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const suffix = (value: string) => value.split("/").at(-1) ?? value;
const REASONING_VARIANT_SUFFIXES = ["nonreasoning", "reasoning", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
function advisoryIdentityMatches(query: string, identity: string): boolean {
  const values = [normalized(suffix(identity)), normalized(identity)];
  return values.some((value) => value === query || REASONING_VARIANT_SUFFIXES.some((variant) => value === `${query}${variant}`));
}
/** Candidate matching is advisory only. It never reads or writes reviewed mappings. */
export function suggestAaCandidates(canonicalId: string, catalog: CatalogResult): AaCandidate[] {
  const query = normalized(suffix(canonicalId));
  if (!query) return [];
  const candidates: AaCandidate[] = [];
  for (const record of catalog.records) {
    const identities = [record.openrouter_api_id, record.slug, record.name].filter((value): value is string => typeof value === "string");
    if (!identities.some((identity) => advisoryIdentityMatches(query, identity))) continue;
    validateExternalIdentity(record);
    candidates.push({ aaModelId: record.id, slug: record.slug, name: record.name });
  }
  return [...new Map(candidates.map((candidate) => [candidate.aaModelId, candidate])).values()];
}
function numberOrNull(value: unknown): number | null { if (value === null || value === undefined) return null; if (typeof value === "number" && Number.isFinite(value)) return value; throw new Error("Artificial Analysis evaluation field is invalid"); }
function percent(value: unknown): number | null { const numeric = numberOrNull(value); return numeric === null ? null : numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric; }
function publicPath(record: Record<string, unknown>, pathParts: string[]): unknown { let current: unknown = record; for (const part of pathParts) { if (!isRecord(current)) return undefined; current = current[part]; } return current; }
function resolveMetric(apiValue: unknown, pageValue: unknown, field: string, tolerance: number): { api: number | null; page: number | null; score: number | null } {
  const api = percent(apiValue); const page = percent(pageValue);
  if (api !== null && page !== null && Math.abs(api - page) > tolerance) throw new Error(`API/public metric conflict: ${field}`);
  return { api, page, score: api ?? page };
}
function checkedScore(score: number | null): number | null { if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error("AA evaluation value is outside the routing scale"); return score; }
function buildSnapshot(mapping: BatchMapping, api: CatalogRecord, page: PublicResult, sourceUrl: string, capturedAt: number, reviewedAt: number): Record<string, unknown> {
  validateExternalIdentity(api);
  if (page.record.id !== api.id || page.record.slug !== api.slug || page.record.name !== api.name) throw new Error("public currentModel identity does not exactly match catalog");
  const evaluations = isRecord(api.evaluations) ? api.evaluations : {};
  const intelligence = resolveMetric(evaluations.artificial_analysis_intelligence_index, page.record.intelligenceIndex, "intelligenceIndex", 0.51);
  const agentic = resolveMetric(evaluations.artificial_analysis_agentic_index, page.record.agenticIndex, "agenticIndex", 0.51);
  const gdp = resolveMetric(evaluations.gdpval_aa_normalized, page.record.gdpvalNormalized, "gdpvalNormalized", 0.001);
  const tau2 = resolveMetric(evaluations.tau2_telecom, page.record.tau2, "tau2", 0.001);
  const tau3 = resolveMetric(evaluations.tau_banking, page.record.tauBanking, "tauBanking", 0.001);
  const longContext = resolveMetric(evaluations.aa_lcr, page.record.lcr, "lcr", 0.001);
  const instructions = resolveMetric(evaluations.ifbench, page.record.ifbench, "ifbench", 0.001);
  const hle = resolveMetric(evaluations.hle, page.record.hle, "hle", 0.001);
  const gpqa = resolveMetric(evaluations.gpqa_diamond, page.record.gpqa, "gpqa", 0.001);
  const crit = resolveMetric(evaluations.critpt, page.record.critpt, "critpt", 0.001);
  const knowledge = resolveMetric(evaluations.aa_omniscience_accuracy, publicPath(page.record, ["omniscienceBreakdown", "accuracy"]), "omniscienceBreakdown.accuracy", 0.001);
  const pageHallucination = percent(publicPath(page.record, ["omniscienceBreakdown", "hallucinationRate"]));
  const faithPage = pageHallucination === null ? null : 100 - pageHallucination;
  const faithfulness = resolveMetric(evaluations.aa_omniscience_non_hallucination_rate, faithPage, "hallucinationRate", 0.001);
  const apiDigest = canonicalDigest(api);
  const component = (metric: { api: number | null; page: number | null }, apiPath: string, pagePath: string, benchmark: string): Record<string, unknown> | null => {
    const score = metric.api ?? metric.page; if (score === null) return null; const fromApi = metric.api !== null;
    return { normalizedScore: score, sourceKind: fromApi ? "api" : "public-page", fieldPath: fromApi ? apiPath : pagePath, benchmark: { id: benchmark, version: `AA Intelligence Index v${fromApi ? "4.1" : "4.1.1"}`, status: "current" }, retrievedAt: fromApi ? capturedAt : page.provenance.retrievedAt, sourceUrl: fromApi ? sourceUrl : page.provenance.url, sourceRecordDigest: fromApi ? apiDigest : page.provenance.recordSha256 };
  };
  const tau3Component = component(tau3, "evaluations.tau_banking", "tauBanking", "tau3-banking"); const gdpComponent = component(gdp, "evaluations.gdpval_aa_normalized", "gdpvalNormalized", "gdpval-aa"); const tau2Component = component(tau2, "evaluations.tau2_telecom", "tau2", "tau2-telecom");
  const derivation = tau3Component && gdpComponent ? { version: "v1", rule: "tau3-banking+gdpval-aa", score: ((tau3Component.normalizedScore as number) + (gdpComponent.normalizedScore as number)) / 2 } : tau2Component ? { version: "v1", rule: "tau2-telecom-fallback", score: tau2Component.normalizedScore } : { version: "v1", rule: "unavailable", score: null };
  const scientific = hle.score !== null && gpqa.score !== null && crit.score !== null ? (hle.score + gpqa.score + crit.score) / 3 : null;
  const scores: Record<string, number | null> = { intelligence: checkedScore(intelligence.score), coding: checkedScore(percent(evaluations.artificial_analysis_coding_index)), agentic: checkedScore(agentic.score), toolUse: checkedScore(derivation.score as number | null), scientificReasoning: checkedScore(scientific), longContext: checkedScore(longContext.score), instructionFollowing: checkedScore(instructions.score), knowledge: checkedScore(knowledge.score), faithfulness: checkedScore(faithfulness.score) };
  const present = DIMENSIONS.filter((dimension) => scores[dimension] !== null).length;
  return { version: 4, provider: mapping.provider, model: mapping.model, thinkingLevel: mapping.thinkingLevel, modelId: mapping.aaModelId, capturedAt, methodology: { ...METHODOLOGY }, mapping: { status: "mapped", matchBasis: "manual", reviewedAt, thinkingLevel: mapping.thinkingLevel }, source: { name: api.name, slug: api.slug, openrouterApiId: typeof api.openrouter_api_id === "string" ? api.openrouter_api_id : null }, publicPage: page.provenance, scores, toolUse: { components: { tau3Banking: tau3Component, gdpvalAaNormalized: gdpComponent, tau2Telecom: tau2Component }, derivation }, outputTokens: {}, taskTimeMs: {}, coverage: present / DIMENSIONS.length };
}

function mappingsFromManifest(manifest: ManifestV4): BatchMapping[] { return manifest.models.map((entry) => ({ provider: entry.provider, model: entry.model, thinkingLevel: entry.thinkingLevel, aaModelId: entry.modelId })); }
function mappingFingerprint(mapping: BatchMapping): string { return JSON.stringify([mapping.provider, mapping.model, mapping.thinkingLevel, mapping.aaModelId]); }
function validateConfiguredBatch(config: WriterConfig, mappings: BatchMapping[], baselineMappings: BatchMapping[]): void {
  if (!validateBatchMappings(mappings)) throw new Error("invalid, duplicate, or mixed generic/variant batch mapping");
  const baselineFingerprints = new Set(baselineMappings.map(mappingFingerprint));
  for (const mapping of mappings) {
    const identity = idOf(mapping); const runtime = config.enabledModels.find((enabled) => enabled === identity || canonicalIdentity(config, enabled) === identity);
    if (!runtime) {
      if (baselineFingerprints.has(mappingFingerprint(mapping))) continue;
      throw new Error(`canonical model is not enabled: ${identity}`);
    }
    const [provider] = splitId(runtime); const selectable = config.stateSupportsReasoningEffort.get(runtime) ?? config.providerSupportsReasoningEffort.get(provider);
    if (selectable !== true && mapping.thinkingLevel !== null) throw new Error(`provider does not support selectable reasoning effort: ${identity}`);
  }
}
function identities(runtimeId: string, canonicalId: string): Set<string> { return new Set([runtimeId, canonicalId]); }
function assertFreeCatalog(catalog: CatalogResult): void {
  const url = new URL(catalog.sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "artificialanalysis.ai" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/api/v2/language/models/free") throw new Error("reviewed catalog is not the Artificial Analysis free endpoint");
}

async function acquireLock(config: BaseConfig): Promise<string> {
  await assertSecureDirectory(config.paths.snapshotRoot); await assertSecureDirectory(config.paths.modelsDir);
  const lock = path.join(config.paths.snapshotRoot, ".refresh.lock");
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Artificial Analysis refresh lock is held"); throw error; }
  try {
    await assertSecureDirectory(lock); const owner = path.join(lock, "owner.json"); await writeFile(owner, jsonPretty({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600, flag: "wx" }); await chmod(owner, 0o600); await assertSecureFile(owner);
    return lock;
  } catch (error) { await rm(lock, { recursive: true, force: true }).catch(() => {}); throw error; }
}
async function acquire(config: WriterConfig): Promise<{ lock: string; staging: string }> {
  await ensureSecureDirectory(config.paths.snapshotRoot); await ensureSecureDirectory(config.paths.modelsDir);
  const lock = await acquireLock(config);
  try {
    const staging = await mkdtemp(path.join(config.paths.snapshotRoot, ".staging-")); await chmod(staging, 0o700); await assertSecureDirectory(staging); return { lock, staging };
  } catch (error) { await rm(lock, { recursive: true, force: true }).catch(() => {}); throw error; }
}
async function baseline(config: WriterConfig, allowV3: boolean, now: number): Promise<{ manifest: ManifestV4 | null; snapshots: Map<string, unknown>; v3: BatchMapping[] | null; canonicalMappings: CanonicalMapping[] }> {
  const canonicalMappings = await loadMappings(config); const value = await readOptionalSecureJson(config.paths.manifest); if (value === null) return { manifest: null, snapshots: new Map(), v3: null, canonicalMappings };
  if (allowV3) { const v3 = extractStrictV3Mappings(value); if (v3) return { manifest: null, snapshots: new Map(), v3, canonicalMappings }; }
  if (!validateManifest(value) || manifestEntriesDigest(value.models) !== value.digest || value.generatedAt > now + 60_000) throw new Error("invalid or unsupported manifest");
  const snapshots = new Map<string, unknown>();
  for (const entry of value.models) { const snapshot = await secureSnapshot(path.join(config.paths.modelsDir, entry.file)); assertEntrySnapshot(entry, snapshot, value.generatedAt); snapshots.set(entry.file, snapshot); }
  for (const mapping of canonicalMappings) if (!value.models.some((entry) => entry.modelId === mapping.aaModelId && entry.thinkingLevel === mapping.thinkingLevel && (idOf(entry) === idOf(mapping) || idOf(entry) === mapping.canonicalId))) throw new Error(`canonical mapping references a mismatched AA snapshot: ${mapping.aaModelId}`);
  return { manifest: value, snapshots, v3: null, canonicalMappings };
}

export interface AaReviewCatalog { catalog: CatalogResult; candidates: Map<string, AaCandidate[]>; }

class AaService {
  deps: ServiceDependencies;
  constructor(deps: ServiceDependencies) { this.deps = deps; }
  async check(env: NodeJS.ProcessEnv = process.env): Promise<void> { const config = baseConfig(env); await validateArtifacts(config, true, this.deps.now(), this.deps.fsHooks.beforeSnapshotRead); }
  async captureArtifactState(env: NodeJS.ProcessEnv = process.env): Promise<ArtifactState> {
    const config = baseConfig(env); await assertSecureDirectory(config.paths.snapshotRoot); await assertSecureDirectory(config.paths.modelsDir);
    let manifest: ArtifactFingerprint | null = null; let manifestSnapshotFiles: string[] = [];
    try {
      const loaded = await readValidatedManifest(config);
      manifest = { path: "manifest.json", fingerprint: loaded.fingerprint };
      manifestSnapshotFiles = ordered(loaded.manifest.models.map((entry) => entry.file));
    } catch (error) { if (!isMissingSnapshot(error)) throw error; }
    let canonicalMappings: ArtifactFingerprint | null = null;
    try {
      await assertSecureFile(config.paths.mappings); const text = await readFile(config.paths.mappings, "utf8"); let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error("invalid JSON in canonical-mappings.json"); }
      if (!validateCanonicalMappings(value)) throw new Error("invalid canonical mappings");
      canonicalMappings = { path: "canonical-mappings.json", fingerprint: digestText(text) };
    } catch (error) { if (!isMissingSnapshot(error)) throw error; }
    const generatedSnapshotFiles: string[] = [];
    for (const file of await readdir(config.paths.modelsDir)) if (GENERATED_SNAPSHOT.test(file)) {
      await assertSecureFile(path.join(config.paths.modelsDir, file)); generatedSnapshotFiles.push(file);
    }
    return { manifest, canonicalMappings, manifestSnapshotFiles, generatedSnapshotFiles: ordered(generatedSnapshotFiles) };
  }
  async cleanupObsoleteSnapshots(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<CleanupResult> {
    const config = baseConfig(env); const lock = await acquireLock(config); const deleted: string[] = []; const warnings: string[] = [];
    try {
      const loaded = await readValidatedManifest(config); const keep = new Set(loaded.manifest.models.map((entry) => entry.file));
      for (const file of await readdir(config.paths.modelsDir)) {
        if (signal?.aborted) { warning(warnings, "snapshot cleanup was interrupted"); break; }
        if (!file.endsWith(".json")) continue;
        if (!GENERATED_SNAPSHOT.test(file)) { warning(warnings, "snapshot cleanup skipped an unexpected file"); continue; }
        if (keep.has(file)) continue;
        const target = path.join(config.paths.modelsDir, file);
        try { await assertSecureFile(target); await this.deps.fsHooks.beforePrune?.(file); await rm(target); deleted.push(`models/${file}`); }
        catch { warning(warnings, "snapshot cleanup was incomplete after successful publication"); }
      }
      return { deleted: ordered(deleted), warnings: ordered(warnings) };
    } finally { await rm(lock, { recursive: true, force: true }).catch(() => {}); }
  }
  async missing(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const config = await loadRuntimeConfig(env); const mappings = await loadMappings(config); let manifest: ManifestV4 | null = null;
    try { manifest = (await validateArtifacts(config, true, this.deps.now(), this.deps.fsHooks.beforeSnapshotRead)).manifest; } catch { /* Invalid, stale, or incomplete artifacts are unavailable offline. */ }
    const presentIds = new Set(manifest?.models.map((entry) => entry.modelId) ?? []); const presentIdentity = new Set(manifest?.models.map(idOf) ?? []); const result: string[] = [];
    for (const runtime of config.enabledModels) { const canonical = canonicalIdentity(config, runtime); const aa = reviewedId(mappings, canonical, null); if (!(aa && presentIds.has(aa)) && !presentIdentity.has(runtime) && !presentIdentity.has(canonical)) result.push(runtime); }
    return result;
  }
  async discover(modelId: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<AaCandidate[]> {
    const results = await this.discoverMany([modelId], signal, env);
    return results.get(modelId) ?? [];
  }
  /** Fetch the authenticated AA free catalog once, then produce non-binding normalized suggestions. */
  async discoverCatalog(modelIds: readonly string[], signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<AaReviewCatalog> {
    const config = await loadDiscoverConfig(env);
    for (const modelId of modelIds) if (!config.enabledModels.includes(modelId)) throw new Error(`model is not enabled: ${modelId}`);
    abort(signal); const catalog = await this.deps.fetchCatalog({ ...config, apiUrl: new URL("https://artificialanalysis.ai/api/v2/language/models/free") }, signal);
    return { catalog, candidates: new Map(modelIds.map((modelId) => [modelId, suggestAaCandidates(canonicalIdentity(config, modelId), catalog)])) };
  }
  async discoverMany(modelIds: readonly string[], signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<Map<string, AaCandidate[]>> {
    return (await this.discoverCatalog(modelIds, signal, env)).candidates;
  }
  async add(runtimeId: string, aaModelId: string, thinkingLevel: ThinkingLevel, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<PublicationResult> {
    return this.write(signal, env, false, (base, config) => { if (!config.enabledModels.includes(runtimeId)) throw new Error(`model is not enabled: ${runtimeId}`); const canonical = canonicalIdentity(config, runtimeId); const [provider, model] = splitId(canonical); const aliases = identities(runtimeId, canonical); const current = base.manifest ? mappingsFromManifest(base.manifest).filter((entry) => !aliases.has(idOf(entry))) : []; current.push({ provider, model, thinkingLevel, aaModelId }); return current; });
  }
  async replaceBatch(mappings: BatchMapping[], signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<PublicationResult> { return this.write(signal, env, false, () => mappings); }
  async refresh(modelId: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<PublicationResult> {
    return this.write(signal, env, false, (base, config) => { if (!base.manifest) throw new Error(`no existing mapping for ${modelId}`); const canonical = canonicalIdentity(config, modelId); const aliases = identities(modelId, canonical); const all = mappingsFromManifest(base.manifest); if (!all.some((entry) => aliases.has(idOf(entry)))) throw new Error(`no existing mapping for ${modelId}`); return all; });
  }
  async refreshAll(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<PublicationResult> { return this.write(signal, env, true, (base) => base.v3 ?? (base.manifest ? mappingsFromManifest(base.manifest) : (() => { throw new Error("no benchmark manifest"); })())); }
  async replaceReviewedVariants(runtimeId: string, canonicalId: string, variants: ReviewedVariant[], signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env, reviewedCatalog?: CatalogResult, options: PublicationOptions = {}): Promise<PublicationResult> {
    validateReviewedVariants(variants);
    return this.write(signal, env, false, (base, config) => { if (!config.enabledModels.includes(runtimeId)) throw new Error(`model is not enabled: ${runtimeId}`); const resolved = canonicalIdentity(config, runtimeId); if (resolved !== canonicalId) throw new Error("canonical model identity changed before publication"); const aliases = identities(runtimeId, canonicalId); const [provider, model] = splitId(canonicalId); const next = base.manifest ? mappingsFromManifest(base.manifest).filter((entry) => !aliases.has(idOf(entry))) : []; for (const variant of variants) next.push({ provider, model, thinkingLevel: variant.thinkingLevel, aaModelId: variant.aaModelId }); return next; }, reviewedCatalog, options);
  }
  async write(
    signal: AbortSignal | undefined,
    env: NodeJS.ProcessEnv,
    allowV3: boolean,
    derive: (base: Awaited<ReturnType<typeof baseline>>, config: WriterConfig) => BatchMapping[],
    reviewedCatalog?: CatalogResult,
    options: PublicationOptions = {},
  ): Promise<PublicationResult> {
    const config = await loadWriterConfig(env); const transaction = await acquire(config); const installed: string[] = []; let committed = false; const warnings: string[] = [];
    try {
      abort(signal); const base = await baseline(config, allowV3, this.deps.now()); const mappings = derive(base, config); const baselineMappings = base.manifest ? mappingsFromManifest(base.manifest) : base.v3 ?? []; validateConfiguredBatch(config, mappings, baselineMappings); const canonicalMappings = base.canonicalMappings;
      const catalog = reviewedCatalog ?? await this.deps.fetchCatalog({ ...config, apiUrl: new URL("https://artificialanalysis.ai/api/v2/language/models/free") }, signal);
      assertFreeCatalog(catalog);
      const records = new Map<string, CatalogRecord[]>(); for (const record of catalog.records) { const list = records.get(record.id) ?? []; list.push(record); records.set(record.id, list); }
      const entries: ManifestEntry[] = []; const stagedFiles = new Map<string, string>();
      for (const mapping of [...mappings].sort(compareIdentity)) {
        abort(signal); const matches = records.get(mapping.aaModelId) ?? []; if (matches.length !== 1) throw new Error(`reviewed AA model id is absent or ambiguous: ${mapping.aaModelId}`); const api = matches[0]!; validateExternalIdentity(api);
        const publicConfig: BaseConfig = { paths: config.paths, limits: config.limits, apiUrl: config.apiUrl };
        const publicResult = await this.deps.fetchPublicModel(publicConfig, api.slug, signal); const capturedAt = this.deps.now();
        const old = base.manifest?.models.find((entry) => entry.provider === mapping.provider && entry.model === mapping.model && entry.thinkingLevel === mapping.thinkingLevel && entry.modelId === mapping.aaModelId); const oldSnapshot = old ? base.snapshots.get(old.file) : undefined; const reviewedAt = oldSnapshot && isRecord(oldSnapshot) && isRecord(oldSnapshot.mapping) && typeof oldSnapshot.mapping.reviewedAt === "number" ? oldSnapshot.mapping.reviewedAt : capturedAt;
        const snapshot = buildSnapshot(mapping, api, publicResult, catalog.sourceUrl, capturedAt, reviewedAt); if (!validateSnapshot(snapshot)) throw new Error("constructed snapshot failed schema validation"); abort(signal);
        if (old && oldSnapshot && capturedAt - old.capturedAt <= config.limits.maxAgeMs && semanticSnapshotDigest(snapshot) === semanticSnapshotDigest(oldSnapshot)) { entries.push(old); continue; }
        const identityHash = canonicalDigest(`${mapping.provider}/${mapping.model}/${mapping.thinkingLevel ?? "null"}`).slice(0, 16); const stable = structuredClone(snapshot); delete (stable as Record<string, unknown>).capturedAt; const file = `${identityHash}-${canonicalDigest(stable).slice(0, 16)}.json`; const stage = path.join(transaction.staging, file); await writeFile(stage, jsonPretty(snapshot), { mode: 0o600, flag: "wx" }); await chmod(stage, 0o600); await assertSecureFile(stage); const contentDigest = canonicalDigest(snapshot); entries.push({ provider: mapping.provider, model: mapping.model, thinkingLevel: mapping.thinkingLevel, modelId: mapping.aaModelId, file, capturedAt, contentDigest }); stagedFiles.set(file, stage);
      }
      entries.sort(compareIdentity); const digest = manifestEntriesDigest(entries); const now = this.deps.now(); const manifestChanged = !base.manifest || base.manifest.digest !== digest || now - base.manifest.generatedAt > config.limits.maxAgeMs;
      if (!manifestChanged) return { changed: false, warnings };
      const next: ManifestV4 = { version: 4, generatedAt: now, digest, methodology: { ...METHODOLOGY }, models: entries }; if (!validateManifest(next)) throw new Error("constructed manifest failed schema validation");
      for (const mapping of canonicalMappings) if (!entries.some((entry) => entry.modelId === mapping.aaModelId && entry.thinkingLevel === mapping.thinkingLevel && (idOf(entry) === idOf(mapping) || idOf(entry) === mapping.canonicalId))) throw new Error(`canonical mapping references a mismatched AA snapshot: ${mapping.aaModelId}`);
      for (const [file, stage] of stagedFiles) {
        abort(signal); await this.deps.fsHooks.beforeInstall?.(file); const destination = path.join(config.paths.modelsDir, file);
        try { await copyFile(stage, destination, fsConstants.COPYFILE_EXCL); installed.push(destination); await chmod(destination, 0o600); await assertSecureFile(destination); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await assertSecureFile(destination); const collision = await readJsonFile(destination); const expected = entries.find((entry) => entry.file === file)!; if (!validateSnapshot(collision) || canonicalDigest(collision) !== expected.contentDigest) throw new Error(`snapshot filename collision: ${file}`); }
      }
      const stagedManifest = path.join(transaction.staging, "manifest.json");
      await writeFile(stagedManifest, jsonPretty(next), { mode: 0o600, flag: "wx" }); await chmod(stagedManifest, 0o600); await assertSecureFile(stagedManifest);
      abort(signal); await this.deps.fsHooks.beforeManifestRename?.(); abort(signal); await rename(stagedManifest, config.paths.manifest); committed = true;
      if (options.prune !== false) {
        const keep = new Set(entries.map((entry) => entry.file)); const priorGeneration = new Set(base.manifest?.models.map((entry) => entry.file) ?? []); const pruneBefore = this.deps.now() - PRUNE_GRACE_MS;
        try {
          for (const file of await readdir(config.paths.modelsDir)) if (file.endsWith(".json") && !keep.has(file) && !priorGeneration.has(file)) {
            const target = path.join(config.paths.modelsDir, file); const info = await lstat(target); await assertSecureFile(target); if (info.mtimeMs > pruneBefore) continue;
            await this.deps.fsHooks.beforePrune?.(file); await rm(target);
          }
        } catch { warnings.push("snapshot cleanup was incomplete after successful publication"); }
      }
      return { changed: true, warnings: ordered(warnings) };
    } catch (error) {
      if (!committed) for (const file of installed) await rm(file, { force: true }).catch(() => {}); throw error;
    } finally { await rm(transaction.staging, { recursive: true, force: true }).catch(() => {}); await rm(transaction.lock, { recursive: true, force: true }).catch(() => {}); }
  }
}

export function validateReviewedVariants(variants: ReviewedVariant[]): void {
  if (!variants.length) throw new Error("at least one reviewed AA variant is required");
  if (variants.some((entry) => !isRecord(entry) || Object.keys(entry).sort().join("|") !== ["aaModelId", "name", "slug", "thinkingLevel"].sort().join("|") || typeof entry.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug) || typeof entry.name !== "string" || !entry.name || /[\x00-\x1f\x7f]/.test(entry.name) || !isThinkingLevel(entry.thinkingLevel))) throw new Error("invalid reviewed AA variant");
  const levels = variants.map((entry) => entry.thinkingLevel);
  if (levels.includes(null) && levels.some((level) => level !== null)) throw new Error("generic and thinking-specific AA mappings cannot coexist");
  if (new Set(levels.map((level) => level ?? "generic")).size !== levels.length) throw new Error("duplicate AA thinking level");
  if (new Set(variants.map((entry) => entry.aaModelId)).size !== variants.length) throw new Error("duplicate AA model UUID");
  if (variants.some((entry) => !UUID.test(entry.aaModelId))) throw new Error("invalid AA model UUID");
}
export function createAaService(dependencies: Partial<ServiceDependencies> = {}): AaService { return new AaService({ fetchCatalog: dependencies.fetchCatalog ?? fetchCatalog, fetchPublicModel: dependencies.fetchPublicModel ?? fetchPublicModel, now: dependencies.now ?? (() => Date.now()), fsHooks: { ...(dependencies.fsHooks ?? {}) } }); }
export const aaService = createAaService();
