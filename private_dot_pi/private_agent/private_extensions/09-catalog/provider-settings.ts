import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogSettings, ProviderSettings } from "./types.ts";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_PATH = path.resolve(__dirname, "../../models.json");
export const SETTINGS_PATH = path.resolve(__dirname, "../../settings.config.json");
export const DEFAULT_CATALOG_SETTINGS: CatalogSettings = { refreshTtlMs: 14_400_000, requestTimeoutMs: 10_000 };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Read only stable provider transport settings. Runtime catalog data never goes in models.json. */
export async function loadProviderSettings(modelsPath = MODELS_PATH): Promise<ProviderSettings[]> {
  const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as { providers?: unknown };
  if (!record(parsed.providers)) return [];
  const providers: ProviderSettings[] = [];
  for (const [id, raw] of Object.entries(parsed.providers)) {
    if (!record(raw) || typeof raw.baseUrl !== "string" || typeof raw.api !== "string") continue;
    providers.push({
      id,
      baseUrl: raw.baseUrl,
      api: raw.api,
      ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
      ...(record(raw.compat) ? { compat: raw.compat } : {}),
    });
  }
  return providers.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadCatalogSettings(settingsPath = SETTINGS_PATH): Promise<CatalogSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { catalog?: unknown };
    const catalog = record(parsed.catalog) ? parsed.catalog : {};
    const bounded = (value: unknown, fallback: number) => typeof value === "number" && Number.isInteger(value) && value >= 1_000 && value <= 604_800_000 ? value : fallback;
    return {
      refreshTtlMs: bounded(catalog.refreshTtlMs, DEFAULT_CATALOG_SETTINGS.refreshTtlMs),
      requestTimeoutMs: bounded(catalog.requestTimeoutMs, DEFAULT_CATALOG_SETTINGS.requestTimeoutMs),
    };
  } catch {
    return DEFAULT_CATALOG_SETTINGS;
  }
}

export async function loadEnabledModels(settingsPath = SETTINGS_PATH): Promise<Set<string>> {
  const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { enabledModels?: unknown };
  return new Set(Array.isArray(parsed.enabledModels) ? parsed.enabledModels.filter((id): id is string => typeof id === "string") : []);
}

/** Resolve the trusted models.json credential syntax for discovery only. */
export async function resolveProviderApiKey(reference: string | undefined): Promise<string | undefined> {
  if (!reference) return undefined;
  if (reference.startsWith("!")) {
    const { stdout } = await execFileAsync("sh", ["-c", reference.slice(1)], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    return stdout.trim() || undefined;
  }
  if (reference.startsWith("${") && reference.endsWith("}")) return process.env[reference.slice(2, -1)] || undefined;
  if (reference.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) return process.env[reference.slice(1)] || undefined;
  return reference;
}
