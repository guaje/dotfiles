import { boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import policy from "./assets/policy.json" with { type: "json" };

export interface ModelHealthSettings { cacheTtlMs: number; concurrency: number }

export function resolveModelHealthSettings(settings: Record<string, unknown>): ModelHealthSettings {
  return {
    cacheTtlMs: boundedSafeInteger(settings.modelHealthCacheTtlMs, policy.cacheTtlMs.default, policy.cacheTtlMs.minimum, policy.cacheTtlMs.maximum),
    concurrency: boundedSafeInteger(settings.modelHealthProbeConcurrency, policy.probeConcurrency.default, policy.probeConcurrency.minimum, policy.probeConcurrency.maximum),
  };
}

export async function getModelHealthSettings(): Promise<ModelHealthSettings> {
  return resolveModelHealthSettings(await createSettingsStore().read());
}
