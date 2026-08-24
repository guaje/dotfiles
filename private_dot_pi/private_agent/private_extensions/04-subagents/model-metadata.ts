import type { ThinkingLevel } from "./benchmark-types.ts";

export interface ModelMetadata {
	id: string;
	reasoning?: boolean;
	supportsReasoningEffort?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingLevel>>;
}

/** Normalize a verified Pi model-registry record into functional routing metadata. */
export function normalizeModelMetadata(provider: string, model: Record<string, unknown>, supportsReasoningEffort?: boolean): ModelMetadata | null {
	if (typeof model.id !== "string" || !model.id) return null;
	return {
		id: `${provider}/${model.id}`,
		...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
		...(typeof supportsReasoningEffort === "boolean" ? { supportsReasoningEffort } : (model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { supportsReasoningEffort: true } : {})),
		...(Array.isArray(model.input) && model.input.every((item) => typeof item === "string")
			? { input: model.input as string[] }
			: model.input === undefined ? { input: ["text"] } : {}),
		...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
		...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
		...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" && !Array.isArray(model.thinkingLevelMap) ? { thinkingLevelMap: model.thinkingLevelMap as Partial<Record<ThinkingLevel, ThinkingLevel>> } : {}),
	};
}
