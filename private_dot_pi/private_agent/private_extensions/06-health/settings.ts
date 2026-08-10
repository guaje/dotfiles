import { boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import { getNested } from "../08-settings/nested.ts";
import policy from "./assets/policy.json" with { type: "json" };

export interface ModelHealthSettings { cacheTtlMs: number; concurrency: number }

function nestedOrFlatInteger(settings: Record<string, unknown>, path: string, flatKey: string, minimum: number, maximum: number): unknown {
  const nested = getNested(settings, path);
  if (Number.isSafeInteger(nested) && (nested as number) >= minimum && (nested as number) <= maximum) return nested;
  return settings[flatKey];
}

export function resolveModelHealthSettings(settings: Record<string, unknown>): ModelHealthSettings {
  return {
    cacheTtlMs: boundedSafeInteger(
      nestedOrFlatInteger(settings, "health.cacheTtlMs", "modelHealthCacheTtlMs", policy.cacheTtlMs.minimum, policy.cacheTtlMs.maximum),
      policy.cacheTtlMs.default,
      policy.cacheTtlMs.minimum,
      policy.cacheTtlMs.maximum,
    ),
    concurrency: boundedSafeInteger(
      nestedOrFlatInteger(settings, "health.probeConcurrency", "modelHealthProbeConcurrency", policy.probeConcurrency.minimum, policy.probeConcurrency.maximum),
      policy.probeConcurrency.default,
      policy.probeConcurrency.minimum,
      policy.probeConcurrency.maximum,
    ),
  };
}

export async function getModelHealthSettings(): Promise<ModelHealthSettings> {
  return resolveModelHealthSettings(await createSettingsStore().read());
}
