/**
 * Subagent autotrigger roster — pure logic.
 *
 * The autotrigger mechanism: inject the live agent roster into the system
 * prompt so the model can match a task to a specialist and delegate via the
 * subagent tool on its own (Claude Code / Gemini style).
 *
 * Split per Option C:
 *   - `DELEGATE_GUIDELINES` (stable instruction) → tool `promptGuidelines`
 *     (cached in the system-prompt base).
 *   - `buildRosterInjection` (dynamic roster) → appended per turn by the
 *     `before_agent_start` handler in index.ts.
 *
 * This module is pure: no I/O, no pi internals. Fully unit-testable.
 */

import type { AgentConfig } from "./agents.ts";

export type RosterScope = "user" | "both";

export interface RosterSettings {
	scope: RosterScope;
	cap: number;
}

export const DEFAULT_ROSTER_SCOPE: RosterScope = "user";
export const DEFAULT_ROSTER_CAP = 10;

/** Cap values offered in the settings menu. */
export const CAP_CHOICES = [5, 8, 10, 15, 20];

/** Sentinel marking an already-injected roster. Prevents duplication across turns. */
export const ROSTER_SENTINEL = "<!-- pi-subagent-roster -->";

/**
 * The stable delegate-don't-inline instruction. Lives in `promptGuidelines`
 * (cached system-prompt base). Tells the model *to* delegate; the dynamic
 * roster (handler) tells it *who* is available.
 */
export const DELEGATE_GUIDELINES = [
	"When a task would benefit from a specialist (codebase recon, planning, conventions analysis, web research, code review), delegate to a subagent via the `subagent` tool instead of doing it inline.",
	"Delegating keeps bulky intermediate output (file contents, search results, page text) out of this context. The subagent runs in its own context and returns only a summary.",
	"Prefer a chain (scout → planner → worker → reviewer) for multi-step work, and parallel tasks for independent investigation. Only delegate when the specialist's isolation is worth the spawn cost; don't delegate trivial one-liners.",
].join(" ");

/** Parse + validate roster settings from a settings object, with defaults. */
export function parseRosterSettings(settings: Record<string, unknown> | null | undefined): RosterSettings {
	const rawScope = settings?.subagentRosterScope;
	const scope: RosterScope = rawScope === "both" ? "both" : "user";

	const rawCap = settings?.subagentRosterCap;
	let cap = DEFAULT_ROSTER_CAP;
	if (typeof rawCap === "number" && Number.isFinite(rawCap) && rawCap >= 1) {
		cap = Math.floor(rawCap);
	} else if (typeof rawCap === "string") {
		const parsed = Number.parseInt(rawCap, 10);
		if (Number.isFinite(parsed) && parsed >= 1) cap = parsed;
	}

	return { scope, cap };
}

/** True if the roster sentinel is already present in the system prompt. */
export function hasRosterSentinel(systemPrompt: string): boolean {
	return systemPrompt.includes(ROSTER_SENTINEL);
}

/**
 * Format the agent roster as capped `name — description` lines.
 * Agents are sorted by name for stable ordering.
 */
export function formatRoster(agents: Pick<AgentConfig, "name" | "description">[], cap: number): string {
	const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
	const capped = sorted.slice(0, cap);
	const lines = capped.map((a) => `- ${a.name} — ${a.description}`);
	const omitted = sorted.length - capped.length;
	if (omitted > 0) lines.push(`- ... +${omitted} more (raise the roster cap in /settings to see them)`);
	return lines.join("\n");
}

/**
 * Build the full roster block to append to the system prompt, including the
 * sentinel marker. Returns the block; the caller appends it (after checking
 * `hasRosterSentinel` to stay idempotent).
 */
export function buildRosterInjection(agents: Pick<AgentConfig, "name" | "description">[], settings: RosterSettings): string {
	if (agents.length === 0) return "";
	const roster = formatRoster(agents, settings.cap);
	return [
		"",
		ROSTER_SENTINEL,
		"## Available subagents",
		"",
		"These specialized agents are available now. When a task matches one, delegate via the `subagent` tool (e.g. `{agent: \"scout\", task: \"...\"}`) instead of doing it inline:",
		"",
		roster,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Settings-menu integration (pure list mutation, coexistence-safe)
// ---------------------------------------------------------------------------

export interface RosterSettingsListItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
}

export interface RosterSettingsListLike {
	items: RosterSettingsListItem[];
	filteredItems: RosterSettingsListItem[];
	onChange: (id: string, newValue: string) => void;
	updateValue?: (id: string, newValue: string) => void;
}

/**
 * Inject the two roster settings (scope + cap) into a settings list.
 * Pure: mutates the passed list in place. Coexists with other extensions
 * because the caller wraps (not replaces) `getSettingsList`.
 *
 * @param onScopeChange called when the scope changes (new value: "user" | "both")
 * @param onCapChange   called when the cap changes (new value: number)
 */
export function addRosterSettingsToList(
	settingsList: RosterSettingsListLike,
	current: RosterSettings,
	onScopeChange: (scope: RosterScope) => void | Promise<void>,
	onCapChange: (cap: number) => void | Promise<void>,
): void {
	const scopeItem: RosterSettingsListItem = {
		id: "subagent-roster-scope",
		label: "Subagent roster scope",
		description: "Which agents appear in the autotrigger roster. user: personal agents only. both: include project-local .pi/agents.",
		currentValue: current.scope,
		values: ["user", "both"],
	};

	const capItem: RosterSettingsListItem = {
		id: "subagent-roster-cap",
		label: "Subagent roster cap",
		description: "Maximum agents listed in the system prompt each turn.",
		currentValue: String(current.cap),
		values: CAP_CHOICES.map(String),
	};

	// Update existing items in place if already present (re-open menu).
	for (const item of [scopeItem, capItem]) {
		const existingIndex = settingsList.items.findIndex((entry) => entry.id === item.id);
		if (existingIndex !== -1) {
			const existing = settingsList.items[existingIndex]!;
			existing.label = item.label;
			existing.description = item.description;
			existing.currentValue = item.currentValue;
			existing.values = item.values;
			settingsList.updateValue?.(item.id, item.currentValue);
			continue;
		}

		// Insert after the managing-style item if present, else after thinking, else at end.
		const insertAt = (() => {
			const managingIndex = settingsList.items.findIndex((entry) => entry.id === "managing-style");
			if (managingIndex !== -1) return managingIndex + 1;
			const thinkingIndex = settingsList.items.findIndex((entry) => entry.id === "thinking");
			if (thinkingIndex !== -1) return thinkingIndex + 1;
			return settingsList.items.length;
		})();

		settingsList.items.splice(insertAt, 0, item);
	}

	settingsList.filteredItems = settingsList.items;

	// Wrap onChange to intercept our two items; pass everything else through.
	const originalOnChange = settingsList.onChange;
	settingsList.onChange = (id: string, newValue: string) => {
		if (id === scopeItem.id) {
			const scope: RosterScope = newValue === "both" ? "both" : "user";
			void onScopeChange(scope);
			return;
		}
		if (id === capItem.id) {
			const cap = Number.parseInt(newValue, 10);
			if (Number.isFinite(cap) && cap >= 1) void onCapChange(cap);
			return;
		}
		originalOnChange(id, newValue);
	};
}
