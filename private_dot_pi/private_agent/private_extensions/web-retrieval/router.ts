import { isFallbackEligible, redact, RetrievalError } from "./errors.ts";
import { assertBoundedString, assertDomainList, assertSafeRemoteUrl, assertStructuredSchema } from "./security.ts";
import { linkupProvider } from "./providers/linkup.ts";
import { tavilyProvider } from "./providers/tavily.ts";
import type { NormalizedResult, ProviderAdapter, ProviderName, WebRetrievalConfig, WebRetrievalInput } from "./types.ts";

const adapters: Record<ProviderName, ProviderAdapter> = { linkup: linkupProvider, tavily: tavilyProvider };

export function validateInput(input: WebRetrievalInput, limits: WebRetrievalConfig["limits"]): void {
	if (!input || !["search", "fetch", "research"].includes((input as any).operation)) throw new RetrievalError("operation must be search, fetch, or research.", "validation");
	if (input.operation === "fetch") {
		assertSafeRemoteUrl(input.url);
		// Reject legacy/direct callers as well as the tool schema: raw HTML is never exposed.
		if ((input as { includeRawHtml?: unknown }).includeRawHtml) throw new RetrievalError("Raw HTML retrieval is not supported.", "validation");
		return;
	}
	assertBoundedString(input.query, "query", 4_000);
	assertDomainList(input.includeDomains, "includeDomains");
	assertDomainList(input.excludeDomains, "excludeDomains");
	assertStructuredSchema(input.structuredOutputSchema);
	if (input.operation === "search") {
		if (input.outputType && !["searchResults", "sourcedAnswer", "structured"].includes(input.outputType)) throw new RetrievalError("Invalid search output type.", "validation");
		if (input.mode && !["fast", "standard", "deep"].includes(input.mode)) throw new RetrievalError("search mode must be fast, standard, or deep.", "validation");
		if (input.maxResults !== undefined && (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > limits.maxResults)) throw new RetrievalError(`maxResults must be between 1 and ${limits.maxResults}.`, "validation");
	}
	if (input.operation === "research") {
		if (input.outputType && !["sourcedAnswer", "structured"].includes(input.outputType)) throw new RetrievalError("Invalid research output type.", "validation");
		if (input.mode && !["answer", "auto", "investigate", "research"].includes(input.mode)) throw new RetrievalError("Invalid research mode.", "validation");
		if (input.reasoningDepth && !["S", "M", "L", "XL"].includes(input.reasoningDepth)) throw new RetrievalError("Invalid reasoning depth.", "validation");
	}
}

function errorMessage(error: unknown, secrets: string[]): string {
	const text = error instanceof Error ? error.message : String(error);
	return redact(text, secrets);
}

export async function retrieve(input: WebRetrievalInput, config: WebRetrievalConfig, signal?: AbortSignal, onProgress?: (message: string) => void, customAdapters = adapters): Promise<NormalizedResult> {
	validateInput(input, config.limits);
	const primary: ProviderName = input.provider || "linkup";
	const candidates = input.provider ? [primary] : [primary, ...config.fallbackProviders.filter((provider) => provider !== primary)];
	const errors: string[] = [];
	const secrets = Object.values(config.providers).map((provider) => provider?.apiKey || "");
	for (const [index, provider] of candidates.entries()) {
		try {
			const result = await customAdapters[provider].execute(input, config, signal, onProgress);
			return { ...result, fallback: index > 0 };
		} catch (error) {
			if (error instanceof RetrievalError && error.kind === "cancelled") throw error;
			errors.push(`${provider}: ${errorMessage(error, secrets)}`);
			if (index === candidates.length - 1 || !isFallbackEligible(error)) break;
			onProgress?.(`Retrying with ${candidates[index + 1]} after ${provider} failure…`);
		}
	}
	throw new RetrievalError(`Web retrieval failed. ${errors.join(" | ")}`, "unknown");
}
