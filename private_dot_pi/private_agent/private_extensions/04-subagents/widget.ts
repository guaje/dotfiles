/**
 * Subagent status widget — pure rendering logic.
 *
 * Renders a live aggregate view of in-flight subagent calls for the
 * belowEditor widget. Driven by the `onUpdate` streaming callback in
 * index.ts, which calls `detailsToWidgetState` + `tui.requestRender()`.
 *
 * Pure: no I/O, no pi internals, no TUI. Fully unit-testable.
 */

import type { RenderTheme, SubagentDetails } from "./types.ts";

export interface SubagentWidgetEntry {
	agent: string;
	/** -1 = still running, 0 = succeeded, 1+ = failed. */
	exitCode: number;
	/** Chain step number (1-indexed), omitted for single/parallel. */
	step?: number;
}

export interface SubagentWidgetState {
	mode: "single" | "parallel" | "chain";
	results: SubagentWidgetEntry[];
}

/** Convert full SubagentDetails into the minimal widget state. */
export function detailsToWidgetState(details: SubagentDetails): SubagentWidgetState {
	return {
		mode: details.mode,
		results: details.results.map((r) => ({
			agent: r.agent,
			exitCode: r.exitCode,
			step: r.step,
		})),
	};
}

/**
 * Render the widget as an array of pre-themed strings (one per line).
 * Returns `[]` (auto-hide) when idle (null state or no results).
 */
export function renderSubagentWidget(
	state: SubagentWidgetState | null,
	theme: RenderTheme,
): string[] {
	if (!state || state.results.length === 0) return [];

	const running = state.results.filter((r) => r.exitCode === -1);
	const done = state.results.filter((r) => r.exitCode === 0);
	const failed = state.results.filter((r) => r.exitCode !== 0 && r.exitCode !== -1);

	// Header: mode label + aggregate counts
	const modeLabel =
		state.mode === "chain"
			? ` ${theme.fg("dim", "(chain)")}`
			: state.mode === "parallel"
				? ` ${theme.fg("dim", "(parallel)")}`
				: "";

	const headerParts: string[] = [];
	if (running.length > 0) headerParts.push(`${theme.fg("warning", "⏳")} ${running.length} running`);
	if (done.length > 0) headerParts.push(`${theme.fg("success", "✓")} ${done.length} done`);
	if (failed.length > 0) headerParts.push(`${theme.fg("error", "✗")} ${failed.length} failed`);

	const lines: string[] = [];
	lines.push(
		`${theme.fg("toolTitle", theme.bold("subagents"))}${modeLabel}  ${headerParts.join("  ")}`,
	);

	// Per-agent lines
	for (const r of state.results) {
		const icon =
			r.exitCode === -1
				? theme.fg("warning", "⏳")
				: r.exitCode === 0
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
		const stepLabel = r.step !== undefined ? `${theme.fg("dim", `${r.step}.`)} ` : "";
		lines.push(`  ${stepLabel}${icon} ${theme.fg("accent", r.agent)}`);
	}

	return lines;
}
