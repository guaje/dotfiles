import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** One JSON file per canonical model under `assets/models/`. Endpoints of the same model share it. */
export interface CompositeModelFile {
  version: 2;
  model: string;
  aa?: { variants: unknown[] } | null;
  benchlm?: unknown | null;
}

const FILE_CHARS = /^[A-Za-z0-9._-]+$/;
const MAX_BYTES = 8 * 1024 * 1024;

/** Endpoint or canonical id -> the one model key used under `assets/models/`. The provider is not part of
 * model identity: two endpoints serving the same model name share a file. Dots are preserved so
 * `gpt-5.6-sol` can never collide with `gpt-5-6-sol`. */
export function compositeModelKey(modelId: string): string {
  const firstSlash = modelId.indexOf("/");
  const model = firstSlash > 0 ? modelId.slice(firstSlash + 1) : modelId;
  const compressed = model.replace(/[^A-Za-z0-9._-]/g, "_").toLowerCase();
  if (!compressed || !FILE_CHARS.test(compressed)) throw new Error("unsafe composite model identity");
  return compressed;
}

export function compositeFileName(modelId: string): string {
  return `${compositeModelKey(modelId)}.json`;
}

/** Two distinct canonical models must never collapse into one file; fail closed instead of overwriting. */
export function assertNameCollisionSafe(pairs: readonly { modelId: string; target: string }[]): void {
  const seen = new Map<string, string>();
  for (const pair of pairs) {
    const prior = seen.get(pair.target);
    if (prior !== undefined && prior !== pair.modelId) throw new Error(`composite model name collision: ${pair.modelId} vs ${prior}`);
    seen.set(pair.target, pair.modelId);
  }
}

export async function readComposite(target: string): Promise<CompositeModelFile | null> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES || (info.mode & 0o777) !== 0o600) return null;
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as CompositeModelFile;
  } catch { return null; }
}

/** AA variants the AA manifest entry should read. Legacy layouts store one raw snapshot per file; that
 * shape is still accepted at read time so existing reviewed fixtures do not need a migration. */
export function extractAaVariants(parsed: unknown): unknown[] {
  if (parsed && typeof parsed === "object" && "aa" in (parsed as object)) {
    const variants = (parsed as CompositeModelFile).aa?.variants;
    return Array.isArray(variants) ? variants : [];
  }
  return parsed ? [parsed] : [];
}

/** BenchLM snapshot the BenchLM manifest entry should read, honoring the same dual-mode read rule. */
export function extractBenchLmBlock(parsed: unknown): unknown | null {
  if (parsed && typeof parsed === "object" && "benchlm" in (parsed as object)) return (parsed as CompositeModelFile).benchlm ?? null;
  return parsed ?? null;
}

/** Atomically replace exactly one block, preserving the other publisher's block byte-for-byte. */
export async function writeCompositeBlock(target: string, modelId: string, block: "aa" | "benchlm", value: unknown): Promise<void> {
  let existing = { version: 2, model: modelId, aa: null, benchlm: null } as CompositeModelFile;
  try {
    await lstat(target);
    const prior = await readComposite(target);
    if (prior === null || prior.version !== 2 || prior.model !== modelId) throw new Error(`snapshot filename collision: ${path.basename(target)}`);
    existing = prior;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next: CompositeModelFile = {
    version: 2,
    model: modelId,
    aa: block === "aa" ? (value as CompositeModelFile["aa"]) : existing.aa ?? null,
    benchlm: block === "benchlm" ? value : existing.benchlm ?? null,
  };
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, target);
}