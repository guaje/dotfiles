import { requireProviderKey } from "../config.ts";
import { classifyHttpError, redact, RetrievalError } from "../errors.ts";
import { evidenceFromSources, sourcesFromResponse, truncateResult } from "../normalize.ts";
import type { NormalizedResult, ProviderAdapter, WebRetrievalConfig, WebRetrievalInput } from "../types.ts";

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(error: unknown, provider: string): RetrievalError {
	if (error instanceof RetrievalError) return error;
	if (error instanceof DOMException && error.name === "AbortError") return new RetrievalError("Retrieval cancelled.", "cancelled", undefined, provider);
	if (error instanceof DOMException && error.name === "TimeoutError") return new RetrievalError("Retrieval timed out.", "timeout", undefined, provider);
	return new RetrievalError(`Network error: ${error instanceof Error ? error.message : String(error)}`, "network", undefined, provider);
}

async function request(config: WebRetrievalConfig, path: string, init: RequestInit, signal: AbortSignal | undefined, calls: { count: number }): Promise<any> {
	const provider = "linkup";
	const key = requireProviderKey(config, provider);
	const baseUrl = config.providers.linkup?.baseUrl || "https://api.linkup.so";
	let lastError: unknown;
	for (let attempt = 0; attempt <= config.limits.retries; attempt += 1) {
		if (++calls.count > config.limits.maxCalls) throw new RetrievalError("Retrieval call limit exceeded.", "validation", undefined, provider);
		try {
			const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, signal: combinedSignal(signal, config.limits.timeoutMs) });
			const contentLength = Number(response.headers.get("content-length") || 0);
			if (contentLength > config.limits.maxResponseBytes) throw new RetrievalError("Provider response exceeds the byte limit.", "validation", undefined, provider);
			const raw = await response.text();
			if (new TextEncoder().encode(raw).byteLength > config.limits.maxResponseBytes) throw new RetrievalError("Provider response exceeds the byte limit.", "validation", undefined, provider);
			let body: any;
			try { body = JSON.parse(raw); } catch { throw new RetrievalError(`Provider returned non-JSON response (${response.status}).`, "transient", response.status, provider); }
			if (!response.ok) throw classifyHttpError(response.status, redact(String(body?.error?.message || body?.error || raw), [key]), provider);
			return body;
		} catch (error) {
			lastError = abortError(error, provider);
			if (!(lastError instanceof RetrievalError) || !["network", "timeout", "transient"].includes(lastError.kind) || attempt === config.limits.retries) throw lastError;
		}
	}
	throw lastError;
}

function result(operation: WebRetrievalInput["operation"], mode: string, payload: any, config: WebRetrievalConfig): NormalizedResult {
	const sources = sourcesFromResponse(payload, config.limits.maxResults, config.limits.maxFetchChars);
	const answer = typeof payload?.answer === "string" ? payload.answer : typeof payload?.content === "string" ? payload.content : typeof payload?.markdown === "string" ? payload.markdown : undefined;
	return truncateResult({ provider: "linkup", operation, mode, fallback: false, degraded: false, untrustedWebContent: true, retrievedAt: new Date().toISOString(), answer, evidence: evidenceFromSources(sources), sources, warnings: [] }, config.limits.maxFetchChars, config.limits.maxResults);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
	});
}

async function research(input: Extract<WebRetrievalInput, { operation: "research" }>, config: WebRetrievalConfig, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<NormalizedResult> {
	const calls = { count: 0 };
	const created = await request(config, "/v1/research", { method: "POST", body: JSON.stringify({ q: input.query, outputType: input.outputType || "sourcedAnswer", ...(input.mode ? { mode: input.mode } : {}), ...(input.reasoningDepth ? { reasoningDepth: input.reasoningDepth } : {}), ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}), ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}), ...(input.fromDate ? { fromDate: input.fromDate } : {}), ...(input.toDate ? { toDate: input.toDate } : {}), ...(input.structuredOutputSchema ? { structuredOutputSchema: input.structuredOutputSchema } : {}) }) }, signal, calls);
	const id = created?.id;
	if (!id || typeof id !== "string") return result("research", input.mode || "auto", created, config);
	const deadline = Date.now() + config.limits.pollTimeoutMs;
	let current = created;
	onProgress?.("Linkup research created; polling for completion…");
	while (Date.now() < deadline) {
		const status = String(current?.status || "").toLowerCase();
		if (["completed", "complete", "succeeded", "success"].includes(status)) return result("research", input.mode || "auto", current, config);
		if (["failed", "cancelled", "canceled", "error"].includes(status)) throw new RetrievalError(`Linkup research ${status}.`, "transient", undefined, "linkup");
		await wait(config.limits.pollIntervalMs, signal);
		current = await request(config, `/v1/research/${encodeURIComponent(id)}`, { method: "GET" }, signal, calls);
		onProgress?.("Linkup research is still running…");
	}
	throw new RetrievalError("Linkup research polling timed out.", "timeout", undefined, "linkup");
}

export const linkupProvider: ProviderAdapter = {
	name: "linkup",
	async execute(input, config, signal, onProgress) {
		if (input.operation === "research") return research(input, config, signal, onProgress);
		const calls = { count: 0 };
		if (input.operation === "search") {
			onProgress?.("Searching with Linkup…");
			const payload = await request(config, "/v1/search", { method: "POST", body: JSON.stringify({ q: input.query, depth: input.mode || "standard", outputType: input.outputType || "searchResults", ...(input.maxResults ? { maxResults: input.maxResults } : {}), ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}), ...(input.excludeDomains ? { excludeDomains: input.excludeDomains } : {}), ...(input.fromDate ? { fromDate: input.fromDate } : {}), ...(input.toDate ? { toDate: input.toDate } : {}), ...(input.includeImages !== undefined ? { includeImages: input.includeImages } : {}), ...(input.structuredOutputSchema ? { structuredOutputSchema: input.structuredOutputSchema } : {}) }) }, signal, calls);
			return result("search", input.mode || "standard", payload, config);
		}
		onProgress?.("Fetching through Linkup…");
		const payload = await request(config, "/v1/fetch", { method: "POST", body: JSON.stringify({ url: input.url, renderJs: input.renderJs ?? true, includeRawHtml: false, extractImages: input.extractImages ?? false }) }, signal, calls);
		return result("fetch", "fetch", payload, config);
	},
};
