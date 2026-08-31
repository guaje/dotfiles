import { createHash } from "node:crypto";
import { canonicalDigest, isRecord, METHODOLOGY, PUBLIC_METHODOLOGY_VERSION, UUID } from "./schema.ts";
import type { BaseConfig } from "./config.ts";

export interface CatalogRecord extends Record<string, unknown> { id: string; name: string; slug: string; evaluations?: Record<string, unknown>; }
export interface CatalogResult { records: CatalogRecord[]; sourceUrl: string; }
export interface PublicResult { record: Record<string, unknown>; provenance: { url: string; retrievedAt: number; contentSha256: string; recordSha256: string; extractorVersion: "aa-current-model-rsc-v1"; intelligenceIndexMethodologyVersion: "4.1.1"; }; }

function aborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error && signal.reason.message === "request timed out") throw new Error("request timed out");
  throw new Error("operation aborted");
}
function combinedSignal(caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(new Error("request timed out")), timeoutMs);
  if (!caller) return { signal: timeout.signal, dispose: () => clearTimeout(timer) };
  const controller = new AbortController();
  const abortCaller = () => controller.abort(new Error("operation aborted"));
  const abortTimeout = () => controller.abort(timeout.signal.reason);
  caller.addEventListener("abort", abortCaller, { once: true }); timeout.signal.addEventListener("abort", abortTimeout, { once: true });
  if (caller.aborted) abortCaller();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); caller.removeEventListener("abort", abortCaller); timeout.signal.removeEventListener("abort", abortTimeout); } };
}
function safeNetworkError(error: unknown, label: string): Error {
  if (error instanceof Error && (error.message === "operation aborted" || error.message === "request timed out" || /byte limit|Content-Length|redirect|HTTP status|invalid JSON|methodology|model array|pagination|identity|malformed|currentModel|exactly one/.test(error.message))) return error;
  if (error instanceof Error && error.name === "AbortError") return new Error("operation aborted");
  return new Error(`${label} request failed`);
}

export async function readBoundedBody(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) { const parsed = Number(declared); if (!Number.isFinite(parsed) || parsed < 0 || parsed > limit) { await response.body?.cancel().catch(() => {}); throw new Error("response Content-Length exceeds byte limit"); } }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      aborted(signal);
      const { done, value } = await reader.read(); aborted(signal); if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); throw new Error("response exceeded byte limit"); }
      chunks.push(value);
    }
  } finally { signal?.removeEventListener("abort", onAbort); }
  const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}
async function textBody(response: Response, limit: number, signal?: AbortSignal): Promise<string> { return new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(response, limit, signal)); }
async function jsonBody(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> { const text = await textBody(response, limit, signal); try { return JSON.parse(text); } catch { throw new Error("Artificial Analysis returned invalid JSON"); } }

function catalogPage(value: unknown): { data: CatalogRecord[]; hasMore: boolean; version: string } {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("Artificial Analysis response has no model array");
  const version = String(value.intelligence_index_version); if (version !== METHODOLOGY.version) throw new Error("unsupported Artificial Analysis methodology");
  const data: CatalogRecord[] = [];
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== "string" || !UUID.test(item.id)) throw new Error("Artificial Analysis model array is invalid");
    if (item.name !== undefined && (typeof item.name !== "string" || /[\x00-\x1f\x7f]/.test(item.name))) throw new Error("Artificial Analysis model identity is invalid");
    if (item.slug !== undefined && (typeof item.slug !== "string" || /[\x00-\x1f\x7f]/.test(item.slug))) throw new Error("Artificial Analysis model identity is invalid");
    if (item.openrouter_api_id !== undefined && item.openrouter_api_id !== null && (typeof item.openrouter_api_id !== "string" || /[\x00-\x1f\x7f]/.test(item.openrouter_api_id))) throw new Error("Artificial Analysis model identity is invalid");
    if (item.evaluations !== undefined && !isRecord(item.evaluations)) throw new Error("Artificial Analysis evaluations are invalid");
    data.push(item as CatalogRecord);
  }
  if (!isRecord(value.pagination) || typeof value.pagination.has_more !== "boolean") throw new Error("Artificial Analysis pagination is invalid");
  const hasMore = value.pagination.has_more;
  return { data, hasMore, version };
}
export async function fetchCatalog(config: BaseConfig & { apiKey: string }, signal?: AbortSignal): Promise<CatalogResult> {
  const records: CatalogRecord[] = []; let expectedVersion: string | undefined;
  for (let page = 1; page <= 20; page++) {
    aborted(signal); const url = new URL(config.apiUrl.href); url.searchParams.set("page", String(page)); url.searchParams.set("page_size", "200");
    const headers = new Headers(); headers.set("x-api-key", config.apiKey);
    const active = combinedSignal(signal, config.limits.timeoutMs);
    try {
      const response = await fetch(url, { headers, redirect: "error", signal: active.signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`Artificial Analysis API HTTP status ${response.status}`); }
      const parsed = catalogPage(await jsonBody(response, config.limits.apiBytes, active.signal));
      if (expectedVersion !== undefined && parsed.version !== expectedVersion) throw new Error("Artificial Analysis methodology changed during pagination"); expectedVersion = parsed.version;
      records.push(...parsed.data); if (!parsed.hasMore) return { records, sourceUrl: config.apiUrl.href };
    } catch (error) { if (signal?.aborted) throw new Error("operation aborted"); throw safeNetworkError(error, "Artificial Analysis API"); } finally { active.dispose(); }
  }
  throw new Error("Artificial Analysis pagination exceeded limit");
}

function canonicalPublicUrl(slug: string): URL { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("unsafe catalog slug"); return new URL(`https://artificialanalysis.ai/models/${slug}`); }
function validatePublicHop(url: URL, canonical: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "artificialanalysis.ai" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== canonical.pathname) throw new Error("unsafe Artificial Analysis public page redirect");
}
function extractObject(payload: string, start: number): { value: Record<string, unknown>; end: number } {
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < payload.length; index++) {
    const char = payload[index]!;
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true; else if (char === "{") depth++; else if (char === "}") { depth--; if (depth === 0) { let value: unknown; try { value = JSON.parse(payload.slice(start, index + 1)); } catch { throw new Error("malformed Artificial Analysis public page RSC"); } if (!isRecord(value)) throw new Error("malformed Artificial Analysis public page RSC"); return { value, end: index + 1 }; } }
  }
  throw new Error("malformed Artificial Analysis public page RSC");
}
function publicRecordFrame(html: string): { record: Record<string, unknown>; methodologyVersion: string } {
  const payloads: string[] = []; const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    const body = match[1]!.trim(); if (!body.startsWith("self.__next_f.push")) continue;
    const statement = /^self\.__next_f\.push\((\[[\s\S]*\])\);?$/.exec(body); if (!statement) throw new Error("malformed Artificial Analysis public page RSC");
    let frame: unknown; try { frame = JSON.parse(statement[1]!); } catch { throw new Error("malformed Artificial Analysis public page RSC"); }
    if (!Array.isArray(frame) || typeof frame[1] !== "string") throw new Error("malformed Artificial Analysis public page RSC"); payloads.push(frame[1]);
  }
  const found: Array<{ record: Record<string, unknown>; payload: string }> = [];
  for (const payload of payloads) {
    for (const match of payload.matchAll(/"currentModel"\s*:/g)) {
      let cursor = match.index + match[0].length;
      while (/\s/.test(payload[cursor] ?? "")) cursor++;
      if (payload[cursor] !== "{") throw new Error("malformed Artificial Analysis public page RSC");
      const object = extractObject(payload, cursor); found.push({ record: object.value, payload });
    }
  }
  if (found.length !== 1) throw new Error("public page must contain exactly one currentModel record");
  const versions = new Set<string>(); const payload = found[0]!.payload;
  for (const match of payload.matchAll(/"(?:methodology|intelligenceIndexMethodology)"\s*:\s*"Intelligence Index v(\d+\.\d+\.\d+)"/g)) versions.add(match[1]!);
  for (const match of payload.matchAll(/"intelligenceIndexMethodologyVersion"\s*:\s*"(\d+\.\d+\.\d+)"/g)) versions.add(match[1]!);
  // Current Next.js pages stream currentModel separately from the branded,
  // server-rendered methodology label. Use that exact label only when the
  // authenticated currentModel payload carries no methodology itself.
  if (!versions.size) for (const match of html.matchAll(/Artificial Analysis Intelligence Index v(\d+\.\d+\.\d+) incorporates/g)) versions.add(match[1]!);
  if (versions.size !== 1) throw new Error("unsupported public Intelligence Index methodology");
  return { record: found[0]!.record, methodologyVersion: [...versions][0]! };
}
export function extractCurrentModel(html: string): Record<string, unknown> { return publicRecordFrame(html).record; }
export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!milliseconds) { aborted(signal); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => { clearTimeout(timer); try { aborted(signal); } catch (error) { reject(error); } };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort();
  });
}
export async function fetchPublicModel(config: BaseConfig, slug: string, signal?: AbortSignal): Promise<PublicResult> {
  const canonical = canonicalPublicUrl(slug); let current = new URL(canonical.href); let response: Response | undefined; const active = combinedSignal(signal, config.limits.timeoutMs);
  try {
    for (let hop = 0; hop <= config.limits.publicRedirects; hop++) {
      validatePublicHop(current, canonical); response = await fetch(current, { redirect: "manual", signal: active.signal, headers: new Headers() });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location"); await response.body?.cancel().catch(() => {}); if (!location || hop === config.limits.publicRedirects) throw new Error("unsafe Artificial Analysis public page redirect"); current = new URL(location, current); continue;
      }
      break;
    }
    if (!response || !response.ok) { await response?.body?.cancel().catch(() => {}); throw new Error(`Artificial Analysis public page HTTP status ${response?.status ?? 0}`); }
    if (current.href !== canonical.href) throw new Error("unsafe Artificial Analysis public page redirect");
    const bytes = await readBoundedBody(response, config.limits.publicBytes, active.signal); const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const extracted = publicRecordFrame(html); if (extracted.methodologyVersion !== PUBLIC_METHODOLOGY_VERSION) throw new Error("unsupported public Intelligence Index methodology");
    const record = extracted.record; const retrievedAt = Date.now();
    await abortableDelay(config.limits.pageDelayMs, active.signal);
    return { record, provenance: { url: canonical.href, retrievedAt, contentSha256: createHash("sha256").update(bytes).digest("hex"), recordSha256: canonicalDigest(record), extractorVersion: "aa-current-model-rsc-v1", intelligenceIndexMethodologyVersion: PUBLIC_METHODOLOGY_VERSION } };
  } catch (error) { if (signal?.aborted) throw new Error("operation aborted"); throw safeNetworkError(error, "Artificial Analysis public page"); } finally { active.dispose(); }
}
