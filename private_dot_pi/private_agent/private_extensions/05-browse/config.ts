import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RetrievalError } from "./errors.ts";
import type { RetrievalLimits, WebRetrievalConfig } from "./types.ts";

const execFileAsync = promisify(execFile);
const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(extensionDir, "assets/web-retrieval.json");
const defaults: RetrievalLimits = { maxResults: 8, maxResponseBytes: 1_000_000, maxFetchChars: 30_000, maxCalls: 8, timeoutMs: 30_000, retries: 1, pollIntervalMs: 1_000, pollTimeoutMs: 120_000 };

async function readExtensionConfig(): Promise<Record<string, any>> {
	try {
		const parsed = JSON.parse(await readFile(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid configuration");
		return parsed;
	} catch {
		throw new RetrievalError("Missing or invalid web-retrieval extension configuration.", "config");
	}
}

export async function resolveSecret(value: unknown): Promise<string> {
	if (typeof value !== "string" || !value) return "";
	if (value.startsWith("$")) return process.env[value.slice(1)] || "";
	if (value.startsWith("!")) {
		const [command, ...args] = value.slice(1).trim().split(/\s+/);
		if (!command) return "";
		const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
		return stdout.trim();
	}
	return value;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

export async function loadConfig(): Promise<WebRetrievalConfig> {
	const raw = await readExtensionConfig();
	const linkup = raw.providers?.linkup || {};
	const tavily = raw.providers?.tavily || {};
	const limits = raw.limits || {};
	return {
		providers: {
			linkup: { apiKey: await resolveSecret(process.env.LINKUP_API_KEY || linkup.apiKey), baseUrl: String(linkup.baseUrl || "https://api.linkup.so").replace(/\/$/, "") },
			tavily: { apiKey: await resolveSecret(process.env.TAVILY_API_KEY || tavily.apiKey), baseUrl: String(tavily.baseUrl || "https://api.tavily.com").replace(/\/$/, "") },
		},
		fallbackProviders: Array.isArray(raw.fallbackProviders) ? raw.fallbackProviders.filter((value: unknown): value is "linkup" | "tavily" => value === "linkup" || value === "tavily") : [],
		limits: {
			maxResults: boundedNumber(limits.maxResults, defaults.maxResults, 1, 20), maxResponseBytes: boundedNumber(limits.maxResponseBytes, defaults.maxResponseBytes, 1_024, 5_000_000), maxFetchChars: boundedNumber(limits.maxFetchChars, defaults.maxFetchChars, 1_000, 100_000), maxCalls: boundedNumber(limits.maxCalls, defaults.maxCalls, 1, 20), timeoutMs: boundedNumber(limits.timeoutMs, defaults.timeoutMs, 1_000, 120_000), retries: boundedNumber(limits.retries, defaults.retries, 0, 3), pollIntervalMs: boundedNumber(limits.pollIntervalMs, defaults.pollIntervalMs, 100, 10_000), pollTimeoutMs: boundedNumber(limits.pollTimeoutMs, defaults.pollTimeoutMs, 1_000, 300_000),
		},
	};
}

export function requireProviderKey(config: WebRetrievalConfig, provider: "linkup" | "tavily"): string {
	const key = config.providers[provider]?.apiKey;
	if (!key) throw new RetrievalError(`Missing ${provider === "linkup" ? "Linkup" : "Tavily"} API key.`, "config", undefined, provider);
	return key;
}
