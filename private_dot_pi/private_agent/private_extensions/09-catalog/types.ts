export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
export type ThinkingLevelMapProvenance = "provider" | "provider-inferred" | "reviewed";

export interface CatalogModel {
  id: string;
  name: string;
  /** Stable upstream identity when the provider exposes one; exact runtime ID otherwise. */
  canonicalId: string;
  reasoning?: boolean;
  /** Model-specific provider values for Pi reasoning levels. */
  thinkingLevelMap?: ThinkingLevelMap;
  /** Explicit provider metadata wins; incomplete per-effort flags are lower-priority inference. */
  thinkingLevelMapProvenance?: ThinkingLevelMapProvenance;
  input: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: CostRates;
  costProvenance?: string;
  /** Present in the provider's current inventory (or synthesized for an enabled ID). */
  available?: boolean;
  /** Included in the exact enabledModels scope. */
  active: boolean;
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  api: string;
  compat?: Record<string, unknown>;
  models: CatalogModel[];
}

export interface NativeModelObservation {
  id: string;
  canonicalId: string;
  name: string;
  reasoning?: boolean;
  /** Model-specific provider values reported by the native provider. */
  thinkingLevelMap?: ThinkingLevelMap;
  thinkingLevelMapProvenance?: ThinkingLevelMapProvenance;
  /** Verified runtime compatibility; false means reasoning effort is fixed. */
  supportsReasoningEffort?: boolean;
  input: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: CostRates;
  costProvenance?: string;
  observedAt: number;
  /** When queried, the unauthenticated Ollama Cloud inventory result. */
  available?: boolean;
  active: boolean;
}

export interface CatalogState {
  version: 2;
  updatedAt: number;
  providers: CatalogProvider[];
  /** Credential-free observations for enabled native /login models. */
  nativeModels: NativeModelObservation[];
}

export interface CatalogSettings {
  refreshTtlMs: number;
  requestTimeoutMs: number;
}

export interface ProviderSettings {
  id: string;
  baseUrl: string;
  api: string;
  /** Trusted models.json value; resolved only for discovery and never serialized to state. */
  apiKey?: string;
  compat?: Record<string, unknown>;
}
