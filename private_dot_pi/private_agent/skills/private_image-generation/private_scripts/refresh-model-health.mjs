#!/usr/bin/env node
/**
 * Refresh model health for one or more models on demand, updating only their
 * cache entries (per-result checkedAt). Leaves the batch checkedAt and all
 * other entries untouched, so a single-model refresh can't make stale entries
 * for other models look fresh.
 *
 * Standalone (no pi runtime): probes image-generation models directly via
 * provider config from models.json + settings. For chat models it can only
 * read existing cache (no modelRegistry/API key resolution without pi); pass
 * them to refresh their cache entry only if a cached result exists to bump.
 *
 * Usage:
 *   node refresh-model-health.mjs                      # refresh all image-gen models
 *   MODEL_IDS='prov-a/model-1,prov-b/model-2' node refresh-model-health.mjs
 *   MODEL_IDS='prov-a/model-1' node refresh-model-health.mjs
 *
 * Env:
 *   IMAGE_AGENT_DIR  agent directory (default: ../../.. from this script)
 *   MODEL_IDS        comma-separated provider/model ids to refresh (default: all image-gen models)
 *
 * Prints JSON: { refreshed: [{id,status,service,error?}], }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(process.env.IMAGE_AGENT_DIR || resolve(scriptDir, "../../.."));
const modelsPath = join(agentDir, "models.json");
const settingsConfigPath = join(agentDir, "settings.config.json");
const settingsPath = join(agentDir, "settings.json");
const cachePath = join(agentDir, "model-health-cache.json");

function readJson(filePath) {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function resolveApiKey(value) {
	if (!value) return "";
	if (value.startsWith("!")) return execSync(value.slice(1), { encoding: "utf8" }).trim();
	if (value.startsWith("$")) return process.env[value.slice(1)] || "";
	return value;
}

function splitModelId(fullId) {
	const [provider, ...rest] = fullId.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) return null;
	return { provider, modelId };
}

/** Configured image-generation models with provider config attached. */
function getConfiguredImageModels(settingsFile, modelsFile) {
	const providers = settingsFile?.imageGenerationProviders || {};
	const models = [];
	for (const [providerId, provider] of Object.entries(providers)) {
		for (const model of provider.models || []) {
			models.push({
				id: `${providerId}/${model.id}`,
				name: model.name || model.id,
				service: "imageGeneration",
				providerConfig: modelsFile?.providers?.[providerId],
			});
		}
	}
	return models;
}

/** Probe one image-generation model. Mirrors probeImageGenerationModel in 06-model-health-check.ts. */
async function probeImageModel(metadata) {
	const parts = splitModelId(metadata.id);
	if (!parts) return { id: metadata.id, status: "error", error: "Invalid model id", name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
	const provider = metadata.providerConfig;
	if (!provider) return { id: metadata.id, status: "not-found", error: "Image generation provider not found in models.json", name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
	if (!provider.baseUrl) return { id: metadata.id, status: "error", error: "Image generation provider is missing baseUrl", name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
	try {
		const apiKey = await resolveApiKey(provider.apiKey);
		if (!apiKey) return { id: metadata.id, status: "auth-missing", error: "No API key available", name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
		const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/images/generations`, {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: parts.modelId,
				prompt: "Health check image: a simple solid color square. No text.",
				n: 1,
				size: "16x16",
				response_format: "b64_json",
			}),
			signal: AbortSignal.timeout(10000),
		});
		const text = await response.text();
		if (!response.ok) {
			return { id: metadata.id, status: response.status === 404 ? "not-found" : "error", error: `Image generation request failed (${response.status}): ${text}`, name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
		}
		const item = JSON.parse(text).data?.[0];
		if (typeof item?.b64_json !== "string" && typeof item?.url !== "string") {
			return { id: metadata.id, status: "error", error: "Image generation response did not include b64_json or url", name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
		}
		return { id: metadata.id, status: "ok", name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
	} catch (error) {
		return { id: metadata.id, status: "error", error: error instanceof Error ? error.message : String(error), name: metadata.name, service: "imageGeneration", checkedAt: Date.now() };
	}
}

/** Merge one result into the cache, leaving the batch checkedAt and other entries untouched. */
function mergeResult(result) {
	const cache = readJson(cachePath) || { checkedAt: Date.now(), results: [] };
	const index = cache.results.findIndex((r) => r.id === result.id);
	if (index === -1) cache.results.push(result);
	else cache.results[index] = result;
	writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function main() {
	const settingsFile = readJson(settingsConfigPath) || readJson(settingsPath) || {};
	const modelsFile = readJson(modelsPath) || { providers: {} };
	const allImageModels = getConfiguredImageModels(settingsFile, modelsFile);

	const requestedIds = (process.env.MODEL_IDS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const targets = requestedIds.length > 0
		? allImageModels.filter((m) => requestedIds.includes(m.id))
		: allImageModels;

	if (targets.length === 0) {
		const available = allImageModels.map((m) => m.id).join(", ") || "none";
		const msg = requestedIds.length > 0
			? `No matching image-generation models for: ${requestedIds.join(", ")}. Available: ${available}`
			: `No image-generation models configured. Configure imageGenerationProviders in settings.config.json.`;
		console.error(JSON.stringify({ error: msg }));
		process.exit(2);
	}

	const refreshed = [];
	for (const model of targets) {
		const result = await probeImageModel(model);
		mergeResult(result);
		refreshed.push(result);
	}

	console.log(JSON.stringify({ refreshed }, null, 2));
}

main().catch((error) => {
	console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	process.exit(1);
});
