import { readFileSync } from "node:fs";
import { join } from "node:path";

function readObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

function getNested(settings, path) {
  const parts = path.split(".");
  let current = settings;
  for (const part of parts) {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function readModelHealthPolicy(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "extensions", "06-health", "assets", "policy.json"), "utf8"));
}

function nestedOrFlatInteger(settings, path, flatKey, minimum, maximum) {
  const nested = getNested(settings, path);
  if (Number.isSafeInteger(nested) && nested >= minimum && nested <= maximum) return nested;
  return settings[flatKey];
}

function nestedOrFlatBoolean(settings, path, flatKey) {
  const nested = getNested(settings, path);
  return typeof nested === 'boolean' ? nested : settings[flatKey];
}

export function readModelHealthSettings(agentDir) {
  const policy = readModelHealthPolicy(agentDir);
  const settings = readObject(join(agentDir, "settings.config.json")) ?? readObject(join(agentDir, "settings.json")) ?? {};
  const ttl = nestedOrFlatInteger(settings, "health.cacheTtlMs", "modelHealthCacheTtlMs", policy.cacheTtlMs.minimum, policy.cacheTtlMs.maximum);
  const concurrency = nestedOrFlatInteger(settings, "health.probeConcurrency", "modelHealthProbeConcurrency", policy.probeConcurrency.minimum, policy.probeConcurrency.maximum);
  const probeTimeout = nestedOrFlatInteger(settings, "health.probeTimeoutMs", "modelHealthProbeTimeoutMs", policy.probeTimeoutMs.minimum, policy.probeTimeoutMs.maximum);
  const probeEscalation = nestedOrFlatBoolean(settings, "health.probeEscalation", "modelHealthProbeEscalation");
  return {
    cacheTtlMs: Number.isSafeInteger(ttl) && ttl >= policy.cacheTtlMs.minimum && ttl <= policy.cacheTtlMs.maximum ? ttl : policy.cacheTtlMs.default,
    concurrency: Number.isSafeInteger(concurrency) && concurrency >= policy.probeConcurrency.minimum && concurrency <= policy.probeConcurrency.maximum ? concurrency : policy.probeConcurrency.default,
    probeTimeoutMs: Number.isSafeInteger(probeTimeout) && probeTimeout >= policy.probeTimeoutMs.minimum && probeTimeout <= policy.probeTimeoutMs.maximum ? probeTimeout : policy.probeTimeoutMs.default,
    probeEscalation: typeof probeEscalation === 'boolean' ? probeEscalation : policy.probeEscalation.default,
  };
}

export function getModelHealthCacheTtlMs(agentDir) { return readModelHealthSettings(agentDir).cacheTtlMs; }
