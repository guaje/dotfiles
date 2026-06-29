/**
 * Model selection logic for the subagent extension.
 *
 * Extracted from the former auto-model-selection.ts extension, stripped of all
 * interactive-session concerns (footer rendering, settings menu patching,
 * /auto-model command, session toggles, pi.setModel() calls). What remains is
 * pure, side-effect-free selection logic used by the subagent tool to pick a
 * model + thinking level for the spawned child `pi` process.
 *
 * Two strategies:
 *   - Heuristic (default, free): keyword classification of the task.
 *   - LLM selector (opt-in): a short LLM call to a powerful thinking model that
 *     picks the execution model + reasoning effort semantically.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple, type Model } from "@earendil-works/pi-ai";
import { getFreshCachedResults, MODEL_HEALTH_CACHE_TTL_MS } from "../model-health-check.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// This file lives at <agent>/extensions/subagent/model-selection.ts, so models
// and settings are two levels up.
const MODELS_PATH = path.resolve(__dirname, "../../models.json");
const SETTINGS_CONFIG_PATH = path.resolve(__dirname, "../../settings.config.json");
const SETTINGS_PATH = path.resolve(__dirname, "../../settings.json");

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelMetadata {
	id: string;
	name: string;
	reasoning?: boolean;
	contextWindow?: number;
}

interface Provider {
	models: ModelMetadata[];
}

interface ModelsFile {
	providers: Record<string, Provider>;
}

interface SettingsFile {
	enabledModels?: string[];
}

/**
 * Minimal structural view of ModelRegistry. We avoid importing the concrete
 * type so this module stays decoupled from the runner internals; the subagent
 * tool passes its execution context's modelRegistry, which satisfies this.
 */
export interface ModelSelectionRegistry {
	find(provider: string, modelId: string): unknown;
	getApiKeyAndHeaders?(model: unknown): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

export interface ModelSelectionResult {
	/** Full "provider/model" id, or undefined if selection failed (child uses its default). */
	modelId?: string;
	/** Thinking level for reasoning-capable models, or undefined for non-reasoning. */
	thinkingLevel?: ThinkingLevel;
	/** Rationale from the LLM selector, if any. */
	reason?: string;
	/** Which strategy produced this result. */
	selector?: "heuristic" | "llm";
}

async function readSettingsFile(filePath: string): Promise<SettingsFile | null> {
	try {
		const data = await readFile(filePath, "utf8");
		return JSON.parse(data) as SettingsFile;
	} catch {
		return null;
	}
}

async function getSettings(): Promise<SettingsFile> {
	return (await readSettingsFile(SETTINGS_CONFIG_PATH)) ?? (await readSettingsFile(SETTINGS_PATH)) ?? {};
}

async function getEnabledModelsMetadata(): Promise<ModelMetadata[]> {
	try {
		const [modelsData, settingsFile] = await Promise.all([readFile(MODELS_PATH, "utf8"), getSettings()]);

		const modelsFile = JSON.parse(modelsData) as ModelsFile;

		const enabledModelIds = settingsFile.enabledModels || [];

		// Build full provider/model ids for enabled models.
		const withFullIds: ModelMetadata[] = [];
		for (const [providerId, provider] of Object.entries(modelsFile.providers)) {
			for (const model of provider.models) {
				const fullId = `${providerId}/${model.id}`;
				if (enabledModelIds.includes(fullId)) {
					withFullIds.push({ ...model, id: fullId });
				}
			}
		}

		// Add enabled models that are not listed in models.json (e.g. built-ins).
		for (const enabledId of enabledModelIds) {
			if (!withFullIds.find((m) => m.id === enabledId)) {
				withFullIds.push({ id: enabledId, name: enabledId.split("/")[1] || enabledId });
			}
		}

		return withFullIds;
	} catch (error) {
		console.error("Error reading models or settings:", error);
		return [];
	}
}

function splitModelId(fullId: string): { provider: string; modelId: string } | null {
	const [provider, ...rest] = fullId.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) return null;
	return { provider, modelId };
}

function modelSearchText(model: ModelMetadata): string {
	return `${model.id} ${model.name || ""}`.toLowerCase();
}

function estimateParameterScale(text: string): number {
	const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([bm])\b/gi)];
	return matches.reduce((max, match) => {
		const value = Number.parseFloat(match[1] || "0");
		const unit = (match[2] || "").toLowerCase();
		const scaled = unit === "b" ? value : value / 1_000;
		return Math.max(max, Number.isFinite(scaled) ? scaled : 0);
	}, 0);
}

export function estimateReasoningEffort(task: string): ThinkingLevel {
	const taskLower = task.toLowerCase();

	if (/architecture|architectural|design doc|migration plan|deep analysis|root cause|formal proof|multi-step|system design|tradeoff/i.test(taskLower)) {
		return "xhigh";
	}

	if (/complex|reasoning|difficult|deep|think|analyze|debug|investigate|compare|evaluate/i.test(taskLower)) {
		return "high";
	}

	if (/implement|plan|review|refactor|test strategy|explain why|walk through/i.test(taskLower)) {
		return "medium";
	}

	if (/quick|simple|brief|summarize|short/i.test(taskLower)) {
		return "low";
	}

	return "medium";
}

export function selectMostPowerfulThinkingModel(models: ModelMetadata[]): string {
	const scoreModel = (model: ModelMetadata): number => {
		const text = modelSearchText(model);
		let score = model.reasoning ? 10_000 : 0;
		score += estimateParameterScale(text);
		score += Math.min(model.contextWindow ?? 0, 1_000_000) / 1_000;
		if (/\b(pro|ultra|max|large|high)\b/.test(text)) score += 1_000;
		if (/\b(coder|code)\b/.test(text)) score += 150;
		if (/\b(flash|mini|small|lite|fast)\b/.test(text)) score -= 250;
		return score;
	};

	return [...models].sort((a, b) => scoreModel(b) - scoreModel(a))[0]?.id || "unknown";
}

export function selectModel(task: string, models: ModelMetadata[]): string {
	const taskLower = task.toLowerCase();

	const isComplex = /reasoning|complex|architecture|design|debug|difficult|deep|think|analyze/i.test(taskLower);
	const isCoding = /code|refactor|implement|fix|test|script|function|class|method/i.test(taskLower);
	const isLightweight = /summarize|list|read|check|status|short|quick|simple|hello|ping/i.test(taskLower);

	// 1. If complex/reasoning, prefer models explicitly marked as reasoning-capable.
	if (isComplex) {
		const reasoningModel = models.find((m) => m.reasoning);
		if (reasoningModel) return reasoningModel.id;
	}

	// 2. If coding, look for generic code-oriented model names.
	if (isCoding) {
		const coderModel = models.find((m) => /\b(coder|code)\b/.test(modelSearchText(m)));
		if (coderModel) return coderModel.id;
	}

	// 3. If lightweight, look for generic fast or small model names.
	if (isLightweight) {
		const flashModel = models.find((m) => /\b(flash|mini|small|lite|fast)\b/.test(modelSearchText(m)));
		if (flashModel) return flashModel.id;
	}

	// 4. Default/Balanced: prefer generic high-tier names or larger context windows.
	const balancedModel =
		models.find((m) => /\b(pro|large|high)\b/.test(modelSearchText(m))) ||
		[...models].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0] ||
		models[0];

	return balancedModel?.id || models[0]?.id || "unknown";
}

interface ModelSelectionDecision {
	modelId: string;
	reasoningEffort?: ThinkingLevel;
	reason?: string;
}

function extractTextContent(response: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		response.content
			?.filter((content): content is { type: "text"; text: string } => content.type === "text" && typeof content.text === "string")
			.map((content) => content.text)
			.join("\n")
			.trim() || ""
	);
}

function parseSelectionDecision(text: string): Partial<ModelSelectionDecision> | undefined {
	const jsonText =
		text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || text.match(/\{[\s\S]*\}/)?.[0]?.trim();
	if (!jsonText) return undefined;

	try {
		return JSON.parse(jsonText) as Partial<ModelSelectionDecision>;
	} catch {
		return undefined;
	}
}

function sanitizeSelectionDecision(
	decision: Partial<ModelSelectionDecision> | undefined,
	task: string,
	models: ModelMetadata[],
): ModelSelectionDecision {
	const fallbackModelId = selectModel(task, models);
	const candidateId = typeof decision?.modelId === "string" ? decision.modelId : fallbackModelId;
	const modelId = models.some((model) => model.id === candidateId) ? candidateId : fallbackModelId;
	const selectedModel = models.find((model) => model.id === modelId);
	const candidateEffort = decision?.reasoningEffort;
	const validEffort =
		candidateEffort === "off" ||
		candidateEffort === "minimal" ||
		candidateEffort === "low" ||
		candidateEffort === "medium" ||
		candidateEffort === "high" ||
		candidateEffort === "xhigh";

	return {
		modelId,
		reasoningEffort: selectedModel?.reasoning
			? validEffort
				? candidateEffort
				: estimateReasoningEffort(task)
			: undefined,
		reason: typeof decision?.reason === "string" ? decision.reason : undefined,
	};
}

async function selectModelWithThinkingSelector(
	task: string,
	models: ModelMetadata[],
	selectorModel: unknown,
	auth?: { apiKey?: string; headers?: Record<string, string> },
): Promise<ModelSelectionDecision> {
	const modelList = models
		.map((model) => `- ${model.id}${model.reasoning ? " (thinking/reasoning capable)" : ""}`)
		.join("\n");
	const prompt = `User task:\n${task}\n\nAvailable models:\n${modelList}\n\nChoose the model that should perform the task. You may choose yourself if the task needs the strongest thinking model, and may set reasoningEffort to minimal, low, medium, high, or xhigh for reasoning-capable models. Respond with strict JSON only: {"modelId":"provider/model","reasoningEffort":"medium","reason":"short rationale"}`;

	try {
		const response = await completeSimple(
			selectorModel as Model<any>,
			{
				systemPrompt:
					"You are Pi's auto model selection router. Pick the most appropriate execution model and reasoning effort. Prefer cheaper/faster models for simple tasks, coder models for implementation, and the strongest thinking model for complex reasoning.",
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{
				apiKey: auth?.apiKey,
				headers: auth?.headers,
				reasoning: "medium",
				maxTokens: 800,
			},
		);

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `selector stopped: ${response.stopReason}`);
		}

		return sanitizeSelectionDecision(parseSelectionDecision(extractTextContent(response)), task, models);
	} catch (error) {
		console.error("Auto model selector failed; falling back to heuristic selection:", error);
		return sanitizeSelectionDecision(undefined, task, models);
	}
}

/**
 * Pick a model (and thinking level) for a subagent task.
 *
 * - Heuristic mode (default): zero LLM calls, instant.
 * - LLM mode (useLlmSelector: true): one short LLM call to the most powerful
 *   thinking model; falls back to the heuristic on any error.
 *
 * Returns an empty result when no models are configured/healthy, in which case
 * the caller should spawn the child without --model/--thinking (child default).
 */
export async function selectModelForSubagent(
	task: string,
	registry: ModelSelectionRegistry,
	options: { useLlmSelector?: boolean; models?: ModelMetadata[] } = {},
): Promise<ModelSelectionResult> {
	const useLlm = options.useLlmSelector ?? false;
	try {
		const allModels = options.models ?? (await getEnabledModelsMetadata());
		if (allModels.length === 0) return {};

		// Fail closed: only auto-select from models proven healthy in a FRESH cache.
		// Mirrors the image-generation SKILL.md availability check. A missing, stale,
		// or all-unhealthy cache means we do NOT assume availability — return empty
		// so the child spawns without --model and falls back to its default model
		// (which is reachable) instead of picking an unreachable one (e.g. a
		// VPN-only model) and hanging.
		const cached = await getFreshCachedResults(MODEL_HEALTH_CACHE_TTL_MS);
		if (!cached) return {};
		const healthyIds = new Set(
			cached.filter((r) => r.status === "ok").map((r) => r.id),
		);
		const models = allModels.filter((m) => healthyIds.has(m.id));
		if (models.length === 0) return {};

		if (useLlm) {
			const selectorId = selectMostPowerfulThinkingModel(models);
			const selectorParts = splitModelId(selectorId);
			const selectorRuntimeModel = selectorParts ? registry.find(selectorParts.provider, selectorParts.modelId) : undefined;
			const selectorAuth =
				selectorRuntimeModel && registry.getApiKeyAndHeaders
					? await registry.getApiKeyAndHeaders(selectorRuntimeModel)
					: undefined;
			const decision = selectorRuntimeModel
				? await selectModelWithThinkingSelector(
						task,
						models,
						selectorRuntimeModel,
						selectorAuth && selectorAuth.ok ? { apiKey: selectorAuth.apiKey, headers: selectorAuth.headers } : undefined,
					)
				: sanitizeSelectionDecision(undefined, task, models);
			const selectedModel = models.find((m) => m.id === decision.modelId);
			return {
				modelId: decision.modelId !== "unknown" ? decision.modelId : undefined,
				thinkingLevel: selectedModel?.reasoning ? decision.reasoningEffort : undefined,
				reason: decision.reason,
				selector: "llm",
			};
		}

		// Heuristic
		const modelId = selectModel(task, models);
		if (modelId === "unknown") return {};
		const modelInfo = models.find((m) => m.id === modelId);
		return {
			modelId,
			thinkingLevel: modelInfo?.reasoning ? estimateReasoningEffort(task) : undefined,
			selector: "heuristic",
		};
	} catch (error) {
		console.error("Subagent model selection failed:", error);
		return {};
	}
}
