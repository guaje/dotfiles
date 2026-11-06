import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNameCollisionSafe, compositeFileName, compositeModelKey, readComposite, writeCompositeBlock } from "../../04-subagents/asset-composite.ts";
import { BenchLmClient } from "./client.ts";
import { BENCHLM_CATEGORIES, canonicalDigest, parseDetailIdentity, parseDetails, parseLeaderboard, record, type BenchLmCategory, type BenchLmMapping, type BenchLmProvenance, type BenchLmSnapshot } from "./schema.ts";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BENCHLM_ROOT = path.resolve(HERE, "../../04-subagents/assets");
const MAPPINGS_PATH = path.join(DEFAULT_BENCHLM_ROOT, "benchlm-mappings.json");
const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("operation aborted")); }, { once: true }); });
async function loadBenchLmReview(file = MAPPINGS_PATH): Promise<{ methodologyVersion: string; mappings: BenchLmMapping[] }> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!record(value) || value.version !== 1 || typeof value.methodologyVersion !== "string" || !value.methodologyVersion || !Array.isArray(value.mappings)) throw new Error("BenchLM mappings are invalid");
  const seen = new Set<string>();
  const mappings = value.mappings.map((entry) => { if (!record(entry) || ![entry.runtimeId, entry.canonicalId, entry.model, entry.creator, entry.slug].every((field) => typeof field === "string" && field.length > 0 && !/[\x00-\x1f\x7f]/.test(field)) || seen.has(entry.runtimeId as string)) throw new Error("BenchLM mappings are invalid"); seen.add(entry.runtimeId as string); return entry as unknown as BenchLmMapping; });
  return { methodologyVersion: value.methodologyVersion, mappings };
}
export async function loadBenchLmMappings(file = MAPPINGS_PATH): Promise<BenchLmMapping[]> { return (await loadBenchLmReview(file)).mappings; }
export interface BenchLmSyncResult { manifest: BenchLmManifest | null; published: boolean; unmapped: string[]; warnings: string[] }
export interface BenchLmManifest { version: 1; generatedAt: number; methodologyVersion: string; sourceSnapshotId: string; digest: string; models: Array<{ runtimeId: string; canonicalId: string; file: string; contentDigest: string }>; }
const HARDWARE_DEPLOYMENT_SUFFIX = /-(?:h\d{2,4}|(?:a|b|l)\d{2,4}(?:-\d+gb)?|mi\d{3,4}x?|tpu-v\d[a-z]?)(?:-\d+gb)?$/i;
const QUANTIZED_MODEL_SUFFIX = /-(?:fp[48]|nf4|int[48]|q[4568](?:_[a-z0-9]+)*|awq|gptq|gguf|mlx|[48]bit)$/i;

/**
 * Candidate BenchLM slugs for an endpoint model name. Case and a separator directly between a letter and
 * a digit are presentation, so both spellings are attempted in deterministic order. Hardware deployment
 * suffixes describe where a model runs and are removed; quantization suffixes describe distinct model
 * artifacts and are deliberately refused rather than borrowed from another artifact's evidence.
 */
export function automaticBenchLmSlugCandidates(runtimeId: string): string[] {
  const slash = runtimeId.indexOf("/");
  if (slash < 1) return [];
  const model = runtimeId.slice(slash + 1).toLowerCase();
  const base = model.replace(HARDWARE_DEPLOYMENT_SUFFIX, "");
  if (QUANTIZED_MODEL_SUFFIX.test(model) || QUANTIZED_MODEL_SUFFIX.test(base)) return [];
  const asSlug = (value: string) => value.replace(/\./g, "-");
  return [...new Set([asSlug(base), asSlug(base.replace(/([a-z])[-_](?=[0-9])/g, "$1"))])].filter((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug));
}

export async function syncBenchLm(options: { client?: BenchLmClient; mappingsFile?: string; root?: string; enabledModels: readonly string[]; signal?: AbortSignal; now?: number; requestDelayMs?: number }): Promise<BenchLmSyncResult> {
  const client = options.client ?? new BenchLmClient(), review = await loadBenchLmReview(options.mappingsFile), root = options.root ?? DEFAULT_BENCHLM_ROOT;
  const requestDelayMs = options.requestDelayMs ?? 0;
  const pace = async () => { if (requestDelayMs > 0) await sleep(requestDelayMs, options.signal); };
  const warnings: string[] = [];
  const leaderboard = parseLeaderboard(await client.leaderboard(options.signal)); await pace();
  if (leaderboard.envelope.methodologyVersion !== review.methodologyVersion) throw new Error(`BenchLM methodology changed: reviewed ${review.methodologyVersion}, upstream ${leaderboard.envelope.methodologyVersion}`);
  const reviewed = new Map(review.mappings.map((entry) => [entry.runtimeId, entry]));
  // Endpoint names are candidate BenchLM product slugs with dots folded to dashes. A page is accepted
  // only when its own payload says its `slug` is exactly that value: no fuzzy names, no closest match,
  // and a collision or mismatch stays unmapped.
  const automatic = new Map<string, BenchLmMapping>();
  const automaticDetails = new Map<string, unknown>();
  for (const runtimeId of options.enabledModels.filter((id) => !reviewed.has(id))) {
    const slugs = automaticBenchLmSlugCandidates(runtimeId);
    if (!slugs.length) continue;
    const collision = review.mappings.find((entry) => slugs.includes(entry.slug) && entry.runtimeId !== runtimeId);
    if (collision) { warnings.push(`BenchLM automatic matching left ${runtimeId} unmapped: slug ${collision.slug} is already bound to ${collision.runtimeId}.`); continue; }
    let lastError: unknown = new Error(`no authoritative page for ${slugs.join(" or ")}`);
    for (const slug of slugs) {
      try {
        await pace();
        const detailPayload = await client.details(slug, options.signal);
        const identity = parseDetailIdentity(detailPayload, { methodologyVersion: leaderboard.envelope.methodologyVersion, slug });
        automatic.set(runtimeId, { runtimeId, canonicalId: `benchlm:${slug}`, model: identity.model, creator: identity.creator, slug: identity.slug, matchBasis: "automatic-exact-slug" });
        automaticDetails.set(runtimeId, detailPayload);
        lastError = undefined;
        break;
      } catch (error) {
        if (options.signal?.aborted) throw new Error("operation aborted");
        lastError = error;
      }
    }
    if (lastError) warnings.push(`BenchLM automatic matching left ${runtimeId} unmapped: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  const mappings = [...review.mappings, ...automatic.values()];
  const byRuntime = new Map(mappings.map((entry) => [entry.runtimeId, entry]));
  const unmapped = options.enabledModels.filter((id) => !byRuntime.has(id));
  if (unmapped.length) warnings.push(`BenchLM has no reviewed row for ${unmapped.join(", ")} — automatic exact-slug matching found no authoritative page; those endpoints route on Artificial Analysis.`);
  const mappedModels = options.enabledModels.filter((id) => byRuntime.has(id));
  if (!mappedModels.length) return { manifest: null, published: false, unmapped, warnings: [...warnings, "BenchLM publication skipped: none of the enabled models have reviewed rows."] };
  const identities = new Map(leaderboard.rows.map((row) => [`${row.creator}\0${row.model}`, row]));
  // The published leaderboard lists only the top slice of the fleet (200 rows on 2026-10-29), so a model
  // we just enabled may not be on it. That must not make it unroutable: its own detail page is fetched and
  // parseDetails() refuses any payload describing a different model, which is the identity guarantee. A
  // leaderboard row, when present, only contributes published figures.
  const selected = mappedModels.map((id) => { const mapping = byRuntime.get(id)!; return { mapping, row: identities.get(`${mapping.creator}\0${mapping.model}`) }; });
  // Endpoints of one model share a composite and a single BenchLM snapshot. A model name is one source
  // identity: mixed pages for the same file would make its evidence non-auditable, so disagreement fails
  // closed rather than selecting a preferred endpoint.
  const selectedByModel = new Map<string, typeof selected>();
  for (const item of selected) {
    const modelKey = compositeModelKey(item.mapping.runtimeId);
    const entries = selectedByModel.get(modelKey) ?? [];
    const first = entries[0]?.mapping;
    if (first && (first.slug !== item.mapping.slug || first.creator !== item.mapping.creator || first.model.toLowerCase() !== item.mapping.model.toLowerCase())) throw new Error(`BenchLM mappings disagree about the source page for ${modelKey}`);
    entries.push(item); selectedByModel.set(modelKey, entries);
  }
  let existing: BenchLmManifest | null = null; try { existing = JSON.parse(await readFile(path.join(root, "benchlm-manifest.json"), "utf8")); } catch {}
  if (existing && existing.methodologyVersion !== leaderboard.envelope.methodologyVersion) throw new Error(`BenchLM methodology changed: reviewed ${existing.methodologyVersion}, upstream ${leaderboard.envelope.methodologyVersion}`);
  if (existing) { const prior = existing.models.map((entry) => entry.runtimeId).sort(), next = selected.map((entry) => entry.mapping.runtimeId).sort(); const added = next.filter((id) => !prior.includes(id)), removed = prior.filter((id) => !next.includes(id)); if (added.length || removed.length) warnings.push(`BenchLM generation membership changed${added.length ? `, added: ${added.join(", ")}` : ""}${removed.length ? `, removed: ${removed.join(", ")}` : ""}`); }
  const capturedAt = options.now ?? Date.now(), snapshots: Array<{ modelKey: string; snapshot: BenchLmSnapshot; file: string; contentDigest: string }> = [];
  for (const [modelKey, entries] of [...selectedByModel.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    entries.sort((left, right) => left.mapping.runtimeId.localeCompare(right.mapping.runtimeId));
    const [{ mapping, row }] = entries;
    await pace();
    const detailPayload = automaticDetails.get(mapping.runtimeId) ?? await client.details(mapping.slug, options.signal);
    const details = parseDetails(detailPayload, { methodologyVersion: leaderboard.envelope.methodologyVersion, model: mapping.model, creator: mapping.creator, slug: mapping.slug });
    // Only BenchLM's own published figures become category scores: the leaderboard figure when the model is
    // listed there, otherwise the figure on its own page. Their individual benchmark rows are archived for
    // display and audit but never averaged into a score, because each benchmark has its own scale, so a mean
    // of rows is a number BenchLM never published and cannot be compared across models. Captured damage from
    // doing it anyway: one vendor self-reported row put GPT-6 Astra's instruction following at 8.5 while
    // BenchLM publishes no figure for that column at all.
    const published = new Map(details.categories.map((entry) => [entry.key, entry.score]));
    const categoryScores: Partial<Record<BenchLmCategory, number>> = {};
    const categoryProvenance: Partial<Record<BenchLmCategory, BenchLmProvenance>> = {};
    const categoryEvidence: Partial<Record<BenchLmCategory, { rows: number; independentlyVerified: number }>> = {};
    for (const category of BENCHLM_CATEGORIES) {
      const rows = details.rows.filter((entry) => entry.category === category);
      const independentlyVerified = rows.filter((entry) => entry.verificationStatus !== "provider_exact");
      if (rows.length) categoryEvidence[category] = { rows: rows.length, independentlyVerified: independentlyVerified.length };
      const value = row?.categoryScores[category] ?? published.get(category);
      if (typeof value !== "number") continue;
      categoryScores[category] = value;
      categoryProvenance[category] = typeof row?.categoryScores[category] === "number" ? "leaderboard" : "published-category";
    }
    const modelAliases = entries.map((entry) => entry.mapping.runtimeId).sort();
    const snapshot: BenchLmSnapshot = { version: 1, runtimeId: mapping.runtimeId, canonicalId: mapping.canonicalId, modelAliases, model: mapping.model, creator: mapping.creator, capturedAt, lastUpdated: leaderboard.envelope.lastUpdated, methodologyVersion: leaderboard.envelope.methodologyVersion, sourceSnapshotId: leaderboard.envelope.sourceSnapshotId, attribution: details.envelope.attribution ?? "BenchLM", license: "CC BY-NC 4.0", categoryScores, categoryProvenance, categoryEvidence, categories: details.categories, details: details.rows };
    const contentDigest = canonicalDigest(snapshot); snapshots.push({ modelKey, snapshot, file: compositeFileName(modelKey), contentDigest });
  }
  const models = snapshots.map(({ snapshot, file, contentDigest }) => ({ runtimeId: snapshot.runtimeId, canonicalId: snapshot.canonicalId, file, contentDigest })).sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  const manifest: BenchLmManifest = { version: 1, generatedAt: capturedAt, methodologyVersion: leaderboard.envelope.methodologyVersion, sourceSnapshotId: leaderboard.envelope.sourceSnapshotId, digest: canonicalDigest(models), models };
  const manifestPath = path.join(root, "benchlm-manifest.json"); const modelsDir = path.join(root, "models"); await mkdir(modelsDir, { recursive: true, mode: 0o700 });
  assertNameCollisionSafe(snapshots.map((item) => ({ modelId: item.modelKey, target: item.file })));
  for (const item of snapshots) {
    const prior = await readComposite(path.join(modelsDir, item.file)); const preservedAa = prior?.aa ?? null;
    await writeCompositeBlock(path.join(modelsDir, item.file), item.modelKey, "benchlm", item.snapshot);
    if (preservedAa) await writeCompositeBlock(path.join(modelsDir, item.file), item.modelKey, "aa", preservedAa);
  }
  await writeFile(options.mappingsFile ?? path.join(root, "benchlm-mappings.json"), `${JSON.stringify({ version: 1, methodologyVersion: review.methodologyVersion, mappings }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, published: true, unmapped, warnings };
}
