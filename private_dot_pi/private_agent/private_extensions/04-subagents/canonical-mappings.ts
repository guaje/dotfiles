import mappingsJson from "./assets/aa/canonical-mappings.json" with { type: "json" };
import { validateCanonicalMappings, type CanonicalMapping } from "../09-catalog/aa/schema.ts";
import type { BenchmarkThinkingLevel } from "./benchmark-types.ts";

if (!validateCanonicalMappings(mappingsJson)) throw new Error("invalid canonical mappings");
const entries: CanonicalMapping[] = mappingsJson.mappings;
const key = (id: string, level: BenchmarkThinkingLevel) => `${id}\u0000${level ?? ""}`;
const runtimeAliases = new Map(entries.map((entry) => [`${entry.provider}/${entry.model}`, entry.canonicalId]));
const benchmarkIds = new Map(entries.map((entry) => [key(entry.canonicalId, entry.thinkingLevel), entry.aaModelId]));
const levelsByCanonical = new Map<string, Set<BenchmarkThinkingLevel>>();
for (const entry of entries) { const mapped = levelsByCanonical.get(entry.canonicalId) ?? new Set<BenchmarkThinkingLevel>(); mapped.add(entry.thinkingLevel); levelsByCanonical.set(entry.canonicalId, mapped); }

/** Prefer a reviewed alias, then provider-discovered stable identity, then exact runtime identity. */
export function canonicalIdForRuntime(runtimeId: string, discoveredCanonicalId?: string): string { return runtimeAliases.get(runtimeId) ?? discoveredCanonicalId ?? runtimeId; }
/** Resolve only reviewed exact canonical mappings; generic and specific variants never mix. */
export function aaModelIdForCanonical(canonicalId: string, thinkingLevel: BenchmarkThinkingLevel): string | undefined { const variants = levelsByCanonical.get(canonicalId); if (!variants) return undefined; const hasSpecific = [...variants].some((level) => level !== null); return benchmarkIds.get(key(canonicalId, hasSpecific ? thinkingLevel : null)); }
