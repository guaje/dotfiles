/**
 * Shared types and constants for the subagent extension.
 *
 * Pure type/const module — no runtime logic, no side effects. Every other
 * subagent module imports from here so the data shapes have one definition.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";
import type { ThinkingLevel } from "./model-selection.ts";

/** Limits and tuning constants shared across orchestration / rendering. */
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** How the model was chosen: "explicit" (agent frontmatter), "heuristic", or "llm". */
	modelSelector?: "explicit" | "heuristic" | "llm";
	/** Thinking level passed to the child (reasoning models only). */
	thinkingLevel?: ThinkingLevel;
	/** Rationale from the LLM selector, when present. */
	selectorReason?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Minimal structural theme interface for the renderers. The real pi Theme
 * satisfies this; we keep it narrow so render.ts does not depend on the full
 * Theme type graph.
 */
export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Arguments passed to renderCall (a structural view of the tool params). */
export interface SubagentCallArgs {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
	agentScope?: AgentScope;
	useLlmSelector?: boolean;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
