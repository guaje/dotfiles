import policy from "./assets/policy.json" with { type: "json" };
export const MODEL_HEALTH_POLICY = policy;
export const MODEL_HEALTH_CACHE_TTL_MS = policy.cacheTtlMs.default;
export const MODEL_PROBE_CONCURRENCY_LIMIT = policy.probeConcurrency.default;
