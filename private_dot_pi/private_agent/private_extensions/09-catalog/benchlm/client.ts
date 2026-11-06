import { BENCHLM_ORIGIN } from "./schema.ts";
export interface BenchLmClientOptions { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number; attempts?: number; backoffMs?: number; }
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("operation aborted")); }, { once: true }); });
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); throw new Error("BenchLM response exceeds byte limit"); }
  if (!response.body) throw new Error("BenchLM response is empty"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error("BenchLM response exceeds byte limit"); } chunks.push(value); }
  const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("BenchLM returned invalid JSON"); }
}
function safeUrl(pathname: string, parameters: Record<string, string>): URL { const url = new URL(pathname, BENCHLM_ORIGIN); for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value); if (url.protocol !== "https:" || url.origin !== BENCHLM_ORIGIN) throw new Error("unsafe BenchLM URL"); return url; }
export class BenchLmClient {
  constructor(private readonly options: BenchLmClientOptions = {}) {}
  private async request(url: URL, signal?: AbortSignal): Promise<unknown> {
    const fetcher = this.options.fetch ?? fetch, attempts = this.options.attempts ?? 3, timeoutMs = this.options.timeoutMs ?? 10_000, maxBytes = this.options.maxBytes ?? 8 * 1024 * 1024;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), timeoutMs), combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      try {
        const response = await fetcher(url, { redirect: "error", signal: combined, headers: { accept: "application/json" } });
        if (!response.ok) { await response.body?.cancel(); if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) { await sleep((this.options.backoffMs ?? 250) * 2 ** attempt, signal); continue; } throw new Error(`BenchLM HTTP status ${response.status}`); }
        return await boundedJson(response, maxBytes);
      } catch (error) { if (signal?.aborted) throw new Error("operation aborted"); if (attempt + 1 >= attempts || (error instanceof Error && /byte limit|invalid JSON|HTTP status 4(?!29)/.test(error.message))) throw error instanceof Error ? error : new Error("BenchLM request failed"); await sleep((this.options.backoffMs ?? 250) * 2 ** attempt, signal); }
      finally { clearTimeout(timer); }
    }
    throw new Error("BenchLM request failed");
  }
  leaderboard(signal?: AbortSignal): Promise<unknown> { return this.request(safeUrl("/api/data/leaderboard", { format: "json", limit: "500" }), signal); }
  async details(model: string, signal?: AbortSignal): Promise<unknown> { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(model)) throw new Error("unsafe BenchLM model identity"); return this.request(safeUrl("/api/data/benchmarks", { model, format: "json" }), signal); }
}
