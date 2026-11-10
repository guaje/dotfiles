import { booleanSetting, boundedSafeInteger, createSettingsStore } from "../08-settings/index.ts";
import { getNested } from "../08-settings/nested.ts";
import policy from "./assets/policy.json" with { type: "json" };

export interface ModelHealthSettings { cacheTtlMs: number; concurrency: number; probeTimeoutMs: number; probeEscalation: boolean }

function nestedOrFlatBoolean(settings: Record<string, unknown>, path: string, flatKey: string): unknown {
  const nested = getNested(settings, path);
  return typeof nested === "boolean" ? nested : settings[flatKey];
}

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
    probeTimeoutMs: boundedSafeInteger(
      nestedOrFlatInteger(settings, "health.probeTimeoutMs", "modelHealthProbeTimeoutMs", policy.probeTimeoutMs.minimum, policy.probeTimeoutMs.maximum),
      policy.probeTimeoutMs.default,
      policy.probeTimeoutMs.minimum,
      policy.probeTimeoutMs.maximum,
    ),
    probeEscalation: booleanSetting(
      nestedOrFlatBoolean(settings, "health.probeEscalation", "modelHealthProbeEscalation"),
      policy.probeEscalation.default,
    ),
  };
}

export async function getModelHealthSettings(): Promise<ModelHealthSettings> {
  return resolveModelHealthSettings(await createSettingsStore().read());
}
