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
 *
 * Layered selection (availability → capability → performance):
 *   1. Availability: a fresh health cache with status "ok" (hard gate, fail
 *      closed — never auto-select an unreachable model). See selectModelForSubagent.
 *   2. Capability: reasoning flag + manual params/activeParams/quant metadata.
 *      Hard-excludes weak models for xhigh/high tasks; ranks the rest.
 *   3. Performance: latency/throughput from the health probe, used as a
 *      tiebreak weighted by task length (latency for short tasks, throughput
 *      for long tasks). Missing metrics are neutral, never penalizing.
 *
 * Models without manual metadata (params/activeParams/quant) fall back to the
 * legacy keyword heuristic so unannotated fixtures/agents keep their proven
 * behavior; the hard capability gate (reasoning flag) still applies.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeSimple, type Model } from "@earendil-works/pi-ai";
import { getFreshCachedResults, MODEL_HEALTH_CACHE_TTL_MS } from "../model-health-check.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// This file lives at <agent>/extensions/subagents/model-selection.ts, so models
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
	/** Total parameter count in billions (e.g. 120 for a 120B model). */
	params?: number;
	/** MoE active parameter count in billions. Predicts capability/throughput
	 * better than total for Mixture-of-Experts models. */
	activeParams?: number;
	/** Serving quantization (e.g. "bf16", "fp8", "mxfp4", "int4"). The serving
	 * quant of self-hosted endpoints; manual annotation is the source of truth. */
	quant?: string;
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

/** A model's probed performance metrics from the health cache. */
export interface ModelPerfMetrics {
	latencyMs?: number;
	tokensPerSecond?: number;
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

/**
 * Task length classification drives perf-tiebreak weights: latency dominates
 * short tasks (summarize, ping), throughput dominates long tasks (implement,
 * refactor, write). Mirrors estimateReasoningEffort's keyword style.
 */
export function estimateTaskLength(task: string): "short" | "long" | "balanced" {
	const taskLower = task.toLowerCase();
	if (/summarize|list|ping|status|quick|brief|short/i.test(taskLower)) return "short";
	if (/implement|refactor|write|build|generate|scaffold|migration/i.test(taskLower)) return "long";
	return "balanced";
}

/**
 * Quantization tier (higher = higher fidelity). Used as a capability signal and
 * a hard floor for high-reasoning tasks. Returns undefined for unannotated
 * models so they are treated as neutral (not penalized) — the serving quant of
 * self-hosted endpoints cannot be auto-detected, so absence is "unknown", not
 * "low". Tier ordering: bf16/fp16 > fp8 > int4/fp4/mxfp4.
 */
export function quantTier(quant: string | undefined): number | undefined {
	if (!quant) return undefined;
	const q = quant.toLowerCase();
	if (/\b(bf16|fp16|f16)\b/.test(q)) return 4;
	if (/\bfp8\b/.test(q)) return 3;
	if (/\b(int4|fp4|nf4|mxfp4|awq|gptq)\b/.test(q)) return 1;
	return undefined;
}

/**
 * Effective parameter count in billions. Prefers MoE activeParams (which
 * predict capability/throughput far better than total for MoE), then total
 * params, then a name-scraped estimate for unannotated models.
 */
export function effectiveParams(model: ModelMetadata): number {
	if (model.activeParams !== undefined) return model.activeParams;
	if (model.params !== undefined) return model.params;
	return estimateParameterScale(modelSearchText(model));
}

/** True when any model carries manual capability metadata (params/activeParams/
 * quant). When false, selectModel falls back to the legacy keyword heuristic so
 * unannotated fixtures/agents keep their proven behavior. */
export function hasCapabilityMetadata(models: ModelMetadata[]): boolean {
	return models.some((m) => m.params !== undefined || m.activeParams !== undefined || m.quant !== undefined);
}

/**
 * Capability score (higher = more capable). Reasoning is the dominant signal;
 * quant tier and parameter count refine it. Unannotated quant is neutral (2).
 */
export function capabilityScore(model: ModelMetadata): number {
	const text = modelSearchText(model);
	let score = model.reasoning ? 10_000 : 0;
	score += (quantTier(model.quant) ?? 2) * 1_000;
	score += effectiveParams(model);
	if (/\b(pro|ultra|max|large|high)\b/.test(text)) score += 1_000;
	if (/\b(coder|code)\b/.test(text)) score += 150;
	if (/\b(flash|mini|small|lite|fast)\b/.test(text)) score -= 250;
	return score;
}

/**
 * Hard capability gate for high-reasoning tasks (decision: hard-exclude for
 * xhigh/high). A model is excluded if it is not reasoning-capable, or if it is
 * annotated with a quant below the fp8 floor. Unannotated reasoning models pass
 * (cannot prove they are below floor). medium/low tasks have no gate.
 */
export function passesCapabilityGate(model: ModelMetadata, reasoningEffort: ThinkingLevel): boolean {
	if (reasoningEffort !== "high" && reasoningEffort !== "xhigh") return true;
	if (!model.reasoning) return false;
	const tier = quantTier(model.quant);
	if (tier !== undefined && tier < 3) return false; // below fp8 floor
	return true;
}

/** Min-max normalize to [0,1]; all-equal (or single) → 0.5 (no signal). */
function normalizeMinMax(values: number[]): number[] {
	if (values.length === 0) return [];
	const min = Math.min(...values);
	const max = Math.max(...values);
	if (max === min) return values.map(() => 0.5);
	const span = max - min;
	return values.map((v) => (v - min) / span);
}

/**
 * Performance score in [0,1] (higher = better). Latency is lower-is-better
 * (normalized against a 10s probe timeout); throughput is higher-is-better
 * (normalized against 100 tok/s). Missing metrics are neutral (0.5), NEVER
 * zero — a reasoning model that spent the 8-token probe thinking has no
 * throughput and must not be penalized. Weights by task length.
 */
export function perfScore(
	model: ModelMetadata,
	metricsById: Map<string, ModelPerfMetrics>,
	length: "short" | "long" | "balanced",
): number {
	const m = metricsById.get(model.id);
	const latencyScore = m?.latencyMs !== undefined ? Math.max(0, 1 - m.latencyMs / 10_000) : 0.5;
	const throughputScore = m?.tokensPerSecond !== undefined ? Math.min(m.tokensPerSecond / 100, 1) : 0.5;
	const weights = length === "short" ? [0.8, 0.2] : length === "long" ? [0.2, 0.8] : [0.5, 0.5];
	return weights[0]! * latencyScore + weights[1]! * throughputScore;
}

export function selectMostPowerfulThinkingModel(
	models: ModelMetadata[],
	metricsById: Map<string, ModelPerfMetrics> = new Map(),
): string {
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
	// Latency tiebreak (decision: keep most-powerful-thinking selector, tiebreak
	// equal-power candidates by lower latency). A tiny epsilon so latency only
	// breaks ties, never overrides capability.
	const latencyOf = (model: ModelMetadata): number => metricsById.get(model.id)?.latencyMs ?? Infinity;

	return [...models]
		.sort((a, b) => scoreModel(b) - scoreModel(a) || latencyOf(a) - latencyOf(b))[0]?.id || "unknown";
}

/** Legacy keyword-based selection. Preserved as the fallback for unannotated
 * models (no params/activeParams/quant) so fixtures and agents without manual
 * metadata keep their proven behavior. Operates on the already-gated set. */
function selectModelByKeyword(task: string, models: ModelMetadata[]): string {
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

/**
 * Select an execution model for a task.
 *
 * Layered (availability is handled by the caller; this does capability → perf):
 *   1. Hard capability gate (passesCapabilityGate) — for xhigh/high tasks,
 *      excludes non-reasoning models and annotated-below-fp8 models. If no
 *      candidate passes, returns undefined (caller defers to the child default
 *      rather than sending a hard task to a weak model).
 *   2. If no model carries manual metadata, fall back to selectModelByKeyword
 *      on the gated set (legacy behavior).
 *   3. Otherwise rank by capabilityScore (min-max normalized) + perfScore,
 *      weighted by task length: capability dominates hard tasks, performance
 *      dominates easy tasks (negative capability weight so easy tasks prefer
 *      smaller/cheaper models).
 *
 * Returns undefined when no capable candidate exists (xhigh/high with no
 * reasoning model); the caller then defers to the child's default model.
 */
export function selectModel(
	task: string,
	models: ModelMetadata[],
	metricsById: Map<string, ModelPerfMetrics> = new Map(),
): string | undefined {
	const effort = estimateReasoningEffort(task);
	const passing = models.filter((m) => passesCapabilityGate(m, effort));
	if ((effort === "high" || effort === "xhigh") && passing.length === 0) return undefined;
	const candidates = passing.length > 0 ? passing : models;

	if (!hasCapabilityMetadata(models)) {
		const id = selectModelByKeyword(task, candidates);
		return id === "unknown" ? undefined : id;
	}

	const length = estimateTaskLength(task);
	const normCap = normalizeMinMax(candidates.map(capabilityScore));
	const perf = candidates.map((m) => perfScore(m, metricsById, length));
	// Capability dominates hard tasks; performance dominates easy tasks. Negative
	// capability weight for low tasks so easy tasks prefer smaller/cheaper models.
	const capWeight = effort === "low" ? -0.3 : effort === "medium" || effort === "off" || effort === "minimal" ? 0.5 : 1.0;
	const perfWeight = effort === "low" ? 1.0 : effort === "medium" || effort === "off" || effort === "minimal" ? 0.5 : 0.1;

	let bestIdx = 0;
	let bestScore = -Infinity;
	for (let i = 0; i < candidates.length; i++) {
		const score = capWeight * normCap[i]! + perfWeight * perf[i]!;
		if (score > bestScore) {
			bestScore = score;
			bestIdx = i;
		}
	}
	return candidates[bestIdx]?.id;
}

interface ModelSelectionDecision {
	modelId?: string;
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
	metricsById: Map<string, ModelPerfMetrics> = new Map(),
): ModelSelectionDecision {
	const effort = estimateReasoningEffort(task);
	const fallbackModelId = selectModel(task, models, metricsById);
	const candidateId = typeof decision?.modelId === "string" ? decision.modelId : fallbackModelId;
	let modelId = candidateId && models.some((model) => model.id === candidateId) ? candidateId : fallbackModelId;
	// Enforce the capability hard gate on the LLM's choice: for xhigh/high
	// tasks, a non-reasoning or below-fp8 model is never acceptable, even if
	// the selector picked it. Fall back to the gated heuristic selection. The
	// gate uses the task's intrinsic difficulty (keyword estimate), not the
	// LLM's chosen reasoningEffort — a hard task stays hard regardless of
	// reasoning budget.
	if (modelId !== undefined && modelId !== fallbackModelId) {
		const chosen = models.find((m) => m.id === modelId);
		if (chosen && !passesCapabilityGate(chosen, effort)) {
			modelId = fallbackModelId;
		}
	}
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
	metricsById: Map<string, ModelPerfMetrics> = new Map(),
): Promise<ModelSelectionDecision> {
	// Annotate the model list with capability + perf signals so the selector can
	// reason about both quality and speed, not just model names.
	const modelList = models
		.map((model) => {
			const parts: string[] = [model.id];
			if (model.reasoning) parts.push("reasoning");
			if (model.activeParams !== undefined) parts.push(`${model.activeParams}B active`);
			else if (model.params !== undefined) parts.push(`${model.params}B params`);
			if (model.quant) parts.push(model.quant);
			if (model.contextWindow !== undefined) parts.push(`${Math.round(model.contextWindow / 1000)}K ctx`);
			const m = metricsById.get(model.id);
			if (m?.latencyMs !== undefined) parts.push(`${(m.latencyMs / 1000).toFixed(2)}s latency`);
			if (m?.tokensPerSecond !== undefined) parts.push(`${m.tokensPerSecond.toFixed(1)} tok/s`);
			return `- ${parts.join(" · ")}`;
		})
		.join("\n");
	const prompt = `User task:\n${task}\n\nAvailable models:\n${modelList}\n\nChoose the model that should perform the task. You may choose yourself if the task needs the strongest thinking model, and may set reasoningEffort to minimal, low, medium, high, or xhigh for reasoning-capable models. Prefer cheaper/faster models for simple tasks and the strongest thinking model for complex reasoning. Respond with strict JSON only: {"modelId":"provider/model","reasoningEffort":"medium","reason":"short rationale"}`;

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

		return sanitizeSelectionDecision(parseSelectionDecision(extractTextContent(response)), task, models, metricsById);
	} catch (error) {
		console.error("Auto model selector failed; falling back to heuristic selection:", error);
		return sanitizeSelectionDecision(undefined, task, models, metricsById);
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
		// VPN-only model) and hanging. getFreshCachedResults is batch-gated on
		// checkedAt, so every returned result is within TTL (entry.checkedAt is
		// always >= batch.checkedAt), i.e. per-entry freshness is guaranteed.
		const cached = await getFreshCachedResults(MODEL_HEALTH_CACHE_TTL_MS);
		if (!cached) return {};
		// Health-cache results can include image-generation models; only chat
		// models are valid execution candidates, and only healthy ones contribute
		// performance metrics. (service defaults to "chat" for older cache entries.)
		const healthyChat = cached.filter(
			(r: { status?: string; service?: string }) => r.status === "ok" && (r.service ?? "chat") === "chat",
		);
		const healthyIds = new Set(healthyChat.map((r: { id: string }) => r.id));
		const models = allModels.filter((m) => healthyIds.has(m.id));
		if (models.length === 0) return {};
		const metricsById = new Map<string, ModelPerfMetrics>(
			healthyChat.map((r: { id: string; latencyMs?: number; tokensPerSecond?: number }) => [
				r.id,
				{ latencyMs: r.latencyMs, tokensPerSecond: r.tokensPerSecond },
			]),
		);

		if (useLlm) {
			const selectorId = selectMostPowerfulThinkingModel(models, metricsById);
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
						metricsById,
					)
				: sanitizeSelectionDecision(undefined, task, models, metricsById);
			const selectedModel = models.find((m) => m.id === decision.modelId);
			return {
				modelId: decision.modelId && decision.modelId !== "unknown" ? decision.modelId : undefined,
				thinkingLevel: selectedModel?.reasoning ? decision.reasoningEffort : undefined,
				reason: decision.reason,
				selector: "llm",
			};
		}

		// Heuristic
		const modelId = selectModel(task, models, metricsById);
		if (modelId === undefined) return {};
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
