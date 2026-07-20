export type ProviderName = "linkup" | "tavily";
export type Operation = "search" | "fetch" | "research";
export type SearchMode = "fast" | "standard" | "deep";

export interface Source {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

export interface Evidence {
	claim?: string;
	url?: string;
	title?: string;
	snippet?: string;
}

export interface NormalizedResult {
	provider: ProviderName;
	operation: Operation;
	mode: string;
	fallback: boolean;
	degraded: boolean;
	untrustedWebContent: true;
	retrievedAt: string;
	answer?: string;
	evidence: Evidence[];
	sources: Source[];
	warnings: string[];
}

export interface SearchInput {
	operation: "search";
	query: string;
	mode?: SearchMode;
	maxResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	fromDate?: string;
	toDate?: string;
	includeImages?: boolean;
	outputType?: "searchResults" | "sourcedAnswer" | "structured";
	structuredOutputSchema?: Record<string, unknown>;
	provider?: ProviderName;
}

export interface FetchInput {
	operation: "fetch";
	url: string;
	renderJs?: boolean;
	extractImages?: boolean;
	provider?: ProviderName;
}

export interface ResearchInput {
	operation: "research";
	query: string;
	mode?: "answer" | "auto" | "investigate" | "research";
	reasoningDepth?: "S" | "M" | "L" | "XL";
	includeDomains?: string[];
	excludeDomains?: string[];
	fromDate?: string;
	toDate?: string;
	outputType?: "sourcedAnswer" | "structured";
	structuredOutputSchema?: Record<string, unknown>;
	provider?: ProviderName;
}

export type WebRetrievalInput = SearchInput | FetchInput | ResearchInput;

export interface ProviderConfig {
	apiKey?: string;
	baseUrl?: string;
}

export interface RetrievalLimits {
	maxResults: number;
	maxResponseBytes: number;
	maxFetchChars: number;
	maxCalls: number;
	timeoutMs: number;
	retries: number;
	pollIntervalMs: number;
	pollTimeoutMs: number;
}

export interface WebRetrievalConfig {
	providers: Partial<Record<ProviderName, ProviderConfig>>;
	fallbackProviders: ProviderName[];
	limits: RetrievalLimits;
}

export interface ProviderAdapter {
	name: ProviderName;
	execute(input: WebRetrievalInput, config: WebRetrievalConfig, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<NormalizedResult>;
}
