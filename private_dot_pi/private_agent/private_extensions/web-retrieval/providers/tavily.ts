import { requireProviderKey } from "../config.ts";
import { classifyHttpError, redact, RetrievalError } from "../errors.ts";
import { evidenceFromSources, sourcesFromResponse, truncateResult } from "../normalize.ts";
import type { NormalizedResult, ProviderAdapter, WebRetrievalConfig, WebRetrievalInput } from "../types.ts";

async function request(config: WebRetrievalConfig, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
	const key = requireProviderKey(config, "tavily");
	const baseUrl = config.providers.tavily?.baseUrl || "https://api.tavily.com";
	let last: unknown;
	for (let attempt = 0; attempt <= config.limits.retries; attempt += 1) {
		try {
			const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: key, ...body }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.limits.timeoutMs)]) : AbortSignal.timeout(config.limits.timeoutMs) });
			const raw = await response.text();
			if (new TextEncoder().encode(raw).byteLength > config.limits.maxResponseBytes) throw new RetrievalError("Provider response exceeds the byte limit.", "validation", undefined, "tavily");
			let parsed: any;
			try { parsed = JSON.parse(raw); } catch { throw new RetrievalError(`Provider returned non-JSON response (${response.status}).`, "transient", response.status, "tavily"); }
			if (!response.ok) throw classifyHttpError(response.status, redact(String(parsed?.detail || parsed?.error || raw), [key]), "tavily");
			return parsed;
		} catch (error) {
			if (error instanceof RetrievalError) { last = error; if (!["network", "timeout", "transient"].includes(error.kind) || attempt === config.limits.retries) throw error; continue; }
			if (error instanceof DOMException && error.name === "AbortError") throw new RetrievalError("Retrieval cancelled.", "cancelled", undefined, "tavily");
			last = new RetrievalError(error instanceof DOMException && error.name === "TimeoutError" ? "Retrieval timed out." : "Network error.", error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network", undefined, "tavily");
			if (attempt === config.limits.retries) throw last;
		}
	}
	throw last;
}

function normalize(input: WebRetrievalInput, payload: any, config: WebRetrievalConfig, degraded: boolean): NormalizedResult {
	const sources = sourcesFromResponse(payload, config.limits.maxResults, config.limits.maxFetchChars);
	const answer = typeof payload?.answer === "string" ? payload.answer : typeof payload?.results?.[0]?.raw_content === "string" ? payload.results[0].raw_content : undefined;
	return truncateResult({ provider: "tavily", operation: input.operation, mode: input.operation === "research" ? "advanced-search" : input.operation === "search" ? input.mode || "advanced" : "extract", fallback: false, degraded, untrustedWebContent: true, retrievedAt: new Date().toISOString(), answer, evidence: evidenceFromSources(sources), sources, warnings: degraded ? ["Tavily research is a degraded advanced sourced search, not asynchronous Linkup research."] : [] }, config.limits.maxFetchChars, config.limits.maxResults);
}

export const tavilyProvider: ProviderAdapter = {
	name: "tavily",
	async execute(input, config, signal, onProgress) {
		if (input.operation === "fetch") {
			onProgress?.("Extracting with Tavily…");
			return normalize(input, await request(config, "/extract", { urls: [input.url], include_raw_content: "markdown" }, signal), config, false);
		}
		onProgress?.(input.operation === "research" ? "Running degraded Tavily research search…" : "Searching with Tavily…");
		const maxResults = input.operation === "search" ? input.maxResults : undefined;
		return normalize(input, await request(config, "/search", { query: input.query, search_depth: input.operation === "research" ? "advanced" : input.mode === "fast" ? "basic" : "advanced", max_results: maxResults || config.limits.maxResults, include_answer: true, include_raw_content: false, ...(input.includeDomains ? { include_domains: input.includeDomains } : {}), ...(input.excludeDomains ? { exclude_domains: input.excludeDomains } : {}) }, signal), config, input.operation === "research");
	},
};
