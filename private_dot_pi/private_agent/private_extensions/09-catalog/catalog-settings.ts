import { readFileSync } from "node:fs";
import path from "node:path";

export interface CatalogRequestDelays { artificialAnalysis: number; benchlm: number }
const DEFAULTS: CatalogRequestDelays = { artificialAnalysis: 1_000, benchlm: 250 };
const SETTINGS_PATH = path.resolve(import.meta.dirname, "../../settings.config.json");

function millis(raw: unknown, label: string): number {
  const value = typeof raw === "string" && raw.includes(".") ? Math.round(Number(raw) * 1000) : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 60_000) throw new Error(`${label} is outside the allowed range`);
  return value;
}

/**
 * Feed-fetch pacing under `"catalog"` in `settings.config.json`:
 * `catalog.artificialAnalysis.requestDelayMs` and `catalog.benchlm.requestDelayMs`, both milliseconds.
 * Process env still wins for one-off pacing tuning (`PI_AA_PUBLIC_PAGE_DELAY`, `PI_BENCHLM_PAGE_DELAY`);
 * decimal values remain the legacy seconds convention.
 */
export function loadCatalogRequestDelays(env: NodeJS.ProcessEnv = process.env, settingsFile = SETTINGS_PATH): CatalogRequestDelays {
  let configured: { artificialAnalysis?: { requestDelayMs?: unknown }; benchlm?: { requestDelayMs?: unknown } } = {};
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { catalog?: { artificialAnalysis?: { requestDelayMs?: unknown }; benchlm?: { requestDelayMs?: unknown } } };
    configured = parsed.catalog ?? {};
  } catch { /* Missing or unreadable settings: only process env and the defaults above apply. */ }
  const aa = env.PI_AA_PUBLIC_PAGE_DELAY ?? configured.artificialAnalysis?.requestDelayMs ?? DEFAULTS.artificialAnalysis;
  const benchlm = env.PI_BENCHLM_PAGE_DELAY ?? configured.benchlm?.requestDelayMs ?? DEFAULTS.benchlm;
  return {
    artificialAnalysis: millis(aa, "catalog.artificialAnalysis.requestDelayMs"),
    benchlm: millis(benchlm, "catalog.benchlm.requestDelayMs"),
  };
}