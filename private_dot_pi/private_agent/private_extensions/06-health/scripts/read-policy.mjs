import { readFileSync } from "node:fs";
import { join } from "node:path";

function readObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

export function readModelHealthPolicy(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "extensions", "06-health", "assets", "policy.json"), "utf8"));
}

export function readModelHealthSettings(agentDir) {
  const policy = readModelHealthPolicy(agentDir);
  const settings = readObject(join(agentDir, "settings.config.json")) ?? readObject(join(agentDir, "settings.json")) ?? {};
  const ttl = settings.modelHealthCacheTtlMs;
  const concurrency = settings.modelHealthProbeConcurrency;
  return {
    cacheTtlMs: Number.isSafeInteger(ttl) && ttl >= policy.cacheTtlMs.minimum && ttl <= policy.cacheTtlMs.maximum ? ttl : policy.cacheTtlMs.default,
    concurrency: Number.isSafeInteger(concurrency) && concurrency >= policy.probeConcurrency.minimum && concurrency <= policy.probeConcurrency.maximum ? concurrency : policy.probeConcurrency.default,
  };
}

export function getModelHealthCacheTtlMs(agentDir) { return readModelHealthSettings(agentDir).cacheTtlMs; }
