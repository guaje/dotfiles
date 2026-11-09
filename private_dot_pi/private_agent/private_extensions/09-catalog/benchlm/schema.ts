import { createHash } from "node:crypto";

/* Wire shapes below are copied from live responses on benchlm.ai (2026-10-29):
 *   GET /api/data/leaderboard?format=json&limit=500  -> { ..., models: [ ... ] }
 *   GET /api/data/benchmarks?model=<slug>&format=json -> { ..., model, categories: [ ... ], benchmarks: [ ... ] }
 * The leaderboard carries `sourceSnapshotId`; the per-model detail payload does NOT. */

export const BENCHLM_ORIGIN = "https://benchlm.ai";
export const BENCHLM_LEADERBOARD_ROWS_KEY = "models";
export const BENCHLM_DETAIL_ROWS_KEY = "benchmarks";
export const BENCHLM_LICENSE = "CC BY-NC 4.0" as const;
export const BENCHLM_CATEGORIES = ["coding", "agentic", "instructionFollowing", "knowledge", "reasoning", "math", "multilingual", "multimodalGrounded"] as const;
export type BenchLmCategory = typeof BENCHLM_CATEGORIES[number];
export type VerificationStatus = "provider_exact" | "benchmark_exact" | "aggregator_verified";
export const VERIFICATION_STATUSES: readonly VerificationStatus[] = ["provider_exact", "benchmark_exact", "aggregator_verified"];

export interface BenchLmDetailRow { category: string; key: string; name: string; value: number; formatted: string; verificationStatus: VerificationStatus; verificationLabel: string; source: { label: string; url?: string | null; retrievedAt?: string | null }; }
export interface BenchLmCategoryScore { key: string; label?: string; score: number | null; rank: number | null; total: number | null; }
export interface BenchLmLeaderboardRow { model: string; creator: string; overallScore: number; categoryScores: Partial<Record<BenchLmCategory, number>>; methodologyVersion: string; evidenceStatus?: string; categoryEvidence?: Partial<Record<string, string>>; }
export interface BenchLmLeaderboard { lastUpdated: string; methodologyVersion: string; sourceSnapshotId: string; license: typeof BENCHLM_LICENSE; attribution?: string; models: unknown[]; }
export interface BenchLmDetails { lastUpdated: string; methodologyVersion: string; license: typeof BENCHLM_LICENSE; attribution?: string; page?: string; model: { model: string; slug: string; creator: string }; categories: BenchLmCategoryScore[]; benchmarks: unknown[]; }
export interface BenchLmMapping { runtimeId: string; canonicalId: string; model: string; creator: string; slug: string; matchBasis?: "manual" | "automatic-exact-slug"; }
/** How each published category value reached the snapshot; decision 12 requires the source to be recorded. */
export type BenchLmProvenance = "published-category" | "leaderboard";
export interface BenchLmSnapshot { version: 1; runtimeId: string; canonicalId: string; modelAliases?: string[]; model: string; creator: string; capturedAt: number; lastUpdated: string; methodologyVersion: string; sourceSnapshotId: string; attribution: string; license: typeof BENCHLM_LICENSE; categoryScores: Partial<Record<BenchLmCategory, number>>; categoryProvenance: Partial<Record<BenchLmCategory, BenchLmProvenance>>; categoryEvidence: Partial<Record<BenchLmCategory, { rows: number; independentlyVerified: number }>>; categories: BenchLmCategoryScore[]; details: BenchLmDetailRow[]; }

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const score = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
/** A published detail figure, which need not be a 0-100 score: BenchLM publishes Clocktower Bench as a raw
 * value (1591, 1859, ...). Rows are archived provenance and are never averaged into a category score, so the
 * only requirement is that the number is real; `formatted` is what a human reads. */
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableScore = (value: unknown): value is number | null => value === null || score(value);
const isCategory = (value: unknown): value is BenchLmCategory => BENCHLM_CATEGORIES.includes(value as BenchLmCategory);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const canonicalDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function envelopeShell(value: unknown): { lastUpdated: string; methodologyVersion: string; license: typeof BENCHLM_LICENSE; attribution?: string } | null {
  if (!record(value) || !text(value.lastUpdated) || !text(value.methodologyVersion) || value.license !== BENCHLM_LICENSE) return null;
  return value as unknown as { lastUpdated: string; methodologyVersion: string; license: typeof BENCHLM_LICENSE; attribution?: string };
}

export function parseLeaderboard(value: unknown): { envelope: BenchLmLeaderboard; rows: BenchLmLeaderboardRow[] } {
  const shell = envelopeShell(value);
  if (!shell || !record(value) || !text(value.sourceSnapshotId) || !Array.isArray(value[BENCHLM_LEADERBOARD_ROWS_KEY])) throw new Error("BenchLM leaderboard envelope is invalid");
  const envelope = value as unknown as BenchLmLeaderboard;
  const rows = envelope.models.map((item) => {
    if (!record(item) || !text(item.model) || !text(item.creator) || !score(item.overallScore) || !record(item.categoryScores) || item.methodologyVersion !== envelope.methodologyVersion) throw new Error("BenchLM leaderboard is partial or malformed");
    const categoryScores: Partial<Record<BenchLmCategory, number>> = {};
    for (const [key, raw] of Object.entries(item.categoryScores)) if (isCategory(key) && score(raw)) categoryScores[key] = raw;
    const categoryEvidence: Partial<Record<string, string>> = {};
    if (record(item.categoryEvidence)) for (const [key, raw] of Object.entries(item.categoryEvidence)) if (text(raw)) categoryEvidence[key] = raw;
    return { model: item.model, creator: item.creator, overallScore: item.overallScore, categoryScores, methodologyVersion: envelope.methodologyVersion, ...(text(item.evidenceStatus) ? { evidenceStatus: item.evidenceStatus } : {}), ...(Object.keys(categoryEvidence).length ? { categoryEvidence } : {}) };
  });
  if (!rows.length) throw new Error("BenchLM leaderboard is empty");
  return { envelope, rows };
}

/** Detail payloads carry no snapshot id, so identity is bound to the requested model instead. */
export function parseDetailIdentity(value: unknown, expected: { methodologyVersion: string; slug: string }): Pick<BenchLmMapping, "model" | "creator" | "slug"> {
  const shell = envelopeShell(value);
  if (!shell || !record(value) || shell.methodologyVersion !== expected.methodologyVersion || !record(value.model) || !Array.isArray(value[BENCHLM_DETAIL_ROWS_KEY]) || !Array.isArray(value.categories)) throw new Error("BenchLM detail envelope is invalid");
  const identity = value.model;
  if (typeof identity.model !== "string" || typeof identity.creator !== "string" || typeof identity.slug !== "string" || identity.slug !== expected.slug || !identity.model.length || !identity.creator.length || /[\x00-\x1f\x7f]/.test(identity.model) || /[\x00-\x1f\x7f]/.test(identity.creator)) throw new Error("BenchLM detail payload describes a different model than requested");
  return { model: identity.model, creator: identity.creator, slug: identity.slug };
}

export function parseDetails(value: unknown, expected: { methodologyVersion: string; model: string; creator: string; slug: string }): { envelope: BenchLmDetails; rows: BenchLmDetailRow[]; categories: BenchLmCategoryScore[] } {
  const identity = parseDetailIdentity(value, expected);
  if (identity.model !== expected.model || identity.creator !== expected.creator) throw new Error("BenchLM detail payload describes a different model than requested");
  const categories = (value.categories as unknown[]).flatMap((item) => {
    if (!record(item) || !text(item.key) || !nullableScore(item.score ?? null)) return [];
    return [{ key: item.key, ...(text(item.label) ? { label: item.label } : {}), score: item.score ?? null, rank: typeof item.rank === "number" ? item.rank : null, total: typeof item.total === "number" ? item.total : null }];
  });
  const rows = (value[BENCHLM_DETAIL_ROWS_KEY] as unknown[]).map((item, index) => {
    // The reason is part of the contract: this validator stops the entire BenchLM generation, so an upstream
    // shape change has to name the benchmark and field that triggered a review instead of failing at large.
    const reason = (value: unknown): string | null => {
      if (!record(value)) return "is not an object";
      for (const field of ["category", "key", "name", "formatted", "verificationLabel"] as const) if (!text((value as Record<string, unknown>)[field])) return `${field} is missing or malformed`;
      if (!finite(value.value)) return "value is not a finite number";
      if (!VERIFICATION_STATUSES.includes(String(value.verificationStatus) as VerificationStatus)) return `verificationStatus ${JSON.stringify(value.verificationStatus)} is not a reviewed status`;
      if (!record(value.source) || !text(value.source.label)) return "source.label is missing";
      return null;
    };
    const failure = reason(item);
    if (failure) throw new Error(`BenchLM detail payload is partial or malformed: benchmark #${index + 1}${record(item) && text(item.name) ? ` (${item.name})` : ""} ${failure}`);
    return item as unknown as BenchLmDetailRow;
  });
  if (!rows.length) throw new Error("BenchLM detail payload is empty");
  return { envelope: value as unknown as BenchLmDetails, rows, categories };
}
