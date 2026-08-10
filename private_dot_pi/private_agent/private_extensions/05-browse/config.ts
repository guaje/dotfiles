import { execFile } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readSettings, type SettingsPaths, resolveSettingsPaths } from "../08-settings/readers.ts";
import { RetrievalError } from "./errors.ts";
import type { RetrievalLimits, WebRetrievalConfig } from "./types.ts";

const execFileAsync = promisify(execFile);
const extensionDir = dirname(fileURLToPath(import.meta.url));

export const defaultCredentialsPath = resolve(extensionDir, "../../browsers.json");

const defaults: RetrievalLimits = {
  maxResults: 8,
  maxResponseBytes: 1_000_000,
  maxFetchChars: 30_000,
  maxCalls: 8,
  timeoutMs: 30_000,
  retries: 1,
  pollIntervalMs: 1_000,
  pollTimeoutMs: 120_000,
};

export interface BrowseConfigDependencies {
  settingsPaths?: Partial<SettingsPaths>;
  credentialsPath?: string;
  env?: Record<string, string | undefined>;
  readSettings?: (paths: SettingsPaths) => Promise<Record<string, unknown>>;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  secretCommand?: (command: string, args: string[]) => Promise<string>;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

async function readCredentialsFile(
  dependencies: BrowseConfigDependencies,
): Promise<Record<string, unknown>> {
  const path = dependencies.credentialsPath ?? defaultCredentialsPath;
  try {
    const text = await (dependencies.readFile ?? nodeReadFile)(path, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid credentials");
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function resolveSecret(
  value: unknown,
  dependencies: BrowseConfigDependencies = {},
): Promise<string> {
  if (typeof value !== "string" || !value) return "";
  if (value.startsWith("$")) return (dependencies.env ?? process.env)[value.slice(1)] || "";
  if (value.startsWith("!")) {
    const [command, ...args] = value.slice(1).trim().split(/\s+/);
    if (!command) return "";
    return dependencies.secretCommand
      ? (await dependencies.secretCommand(command, args)).trim()
      : (await execFileAsync(command, args, { timeout: 5_000 })).stdout.trim();
  }
  return value;
}

function getBrowseSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const browse = settings.browse;
  if (browse !== null && typeof browse === "object" && !Array.isArray(browse)) {
    return browse as Record<string, unknown>;
  }
  // Legacy flat fallback
  return {
    fallbackProviders: settings.fallbackProviders,
    limits: settings.limits,
    ...settings,
  };
}

/** Runtime precedence: env -> credentials file -> settings defaults.
 *  Non-secret config (baseUrl, limits, fallbackProviders) comes from settings. */
export async function loadConfig(dependencies: BrowseConfigDependencies = {}): Promise<WebRetrievalConfig> {
  const rawBrowse = getBrowseSettings(
    await (dependencies.readSettings ?? readSettings)(
      resolveSettingsPaths(dependencies.settingsPaths),
    ),
  );

  const env = dependencies.env ?? process.env;
  const rawProviders = rawBrowse.providers;
  const settingsLinkup =
    rawProviders !== null && typeof rawProviders === "object" && !Array.isArray(rawProviders)
      ? ((rawProviders as Record<string, unknown>).linkup as Record<string, unknown> | undefined) || {}
      : {};
  const settingsTavily =
    rawProviders !== null && typeof rawProviders === "object" && !Array.isArray(rawProviders)
      ? ((rawProviders as Record<string, unknown>).tavily as Record<string, unknown> | undefined) || {}
      : {};

  const linkupBaseUrl = String(settingsLinkup.baseUrl || "https://api.linkup.so").replace(/\/$/, "");
  const tavilyBaseUrl = String(settingsTavily.baseUrl || "https://api.tavily.com").replace(/\/$/, "");

  const credentials = await readCredentialsFile(dependencies);
  const credProviders = credentials.providers;
  const credLinkup =
    credProviders !== null && typeof credProviders === "object" && !Array.isArray(credProviders)
      ? ((credProviders as Record<string, unknown>).linkup as Record<string, unknown> | undefined) || {}
      : {};
  const credTavily =
    credProviders !== null && typeof credProviders === "object" && !Array.isArray(credProviders)
      ? ((credProviders as Record<string, unknown>).tavily as Record<string, unknown> | undefined) || {}
      : {};

  const envLinkupKey = env.LINKUP_API_KEY;
  const envTavilyKey = env.TAVILY_API_KEY;

  const linkupApiKey = envLinkupKey ?? (await resolveSecret(credLinkup.apiKey, dependencies)) ?? "";
  const tavilyApiKey = envTavilyKey ?? (await resolveSecret(credTavily.apiKey, dependencies)) ?? "";

  const rawLimits = rawBrowse.limits;
  const limits =
    rawLimits !== null && typeof rawLimits === "object" && !Array.isArray(rawLimits)
      ? (rawLimits as Record<string, unknown>)
      : {};

  const rawFallback = rawBrowse.fallbackProviders;
  const fallbackProviders = Array.isArray(rawFallback)
    ? rawFallback.filter((value: unknown): value is "linkup" | "tavily" => value === "linkup" || value === "tavily")
    : [];

  return {
    providers: {
      linkup: { apiKey: linkupApiKey, baseUrl: linkupBaseUrl },
      tavily: { apiKey: tavilyApiKey, baseUrl: tavilyBaseUrl },
    },
    fallbackProviders,
    limits: {
      maxResults: boundedNumber(limits.maxResults, defaults.maxResults, 1, 20),
      maxResponseBytes: boundedNumber(limits.maxResponseBytes, defaults.maxResponseBytes, 1_024, 5_000_000),
      maxFetchChars: boundedNumber(limits.maxFetchChars, defaults.maxFetchChars, 1_000, 100_000),
      maxCalls: boundedNumber(limits.maxCalls, defaults.maxCalls, 1, 20),
      timeoutMs: boundedNumber(limits.timeoutMs, defaults.timeoutMs, 1_000, 120_000),
      retries: boundedNumber(limits.retries, defaults.retries, 0, 3),
      pollIntervalMs: boundedNumber(limits.pollIntervalMs, defaults.pollIntervalMs, 100, 10_000),
      pollTimeoutMs: boundedNumber(limits.pollTimeoutMs, defaults.pollTimeoutMs, 1_000, 300_000),
    },
  };
}

export function requireProviderKey(config: WebRetrievalConfig, provider: "linkup" | "tavily"): string {
  const key = config.providers[provider]?.apiKey;
  if (!key) {
    throw new RetrievalError(
      `Missing ${provider === "linkup" ? "Linkup" : "Tavily"} API key.`,
      "config",
      undefined,
      provider,
    );
  }
  return key;
}
