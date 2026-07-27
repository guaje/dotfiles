import { inspectShell } from "./parser.ts";
import type { ShellGraph } from "./ast.ts";
import type { PermissionDecision, ShellAnalysis, ShellContext } from "../types.ts";

const LOCAL_CONTEXT: ShellContext = { location: "local", usesNetwork: false };

export type ShellInspection = { graph: ShellGraph; analysis: ShellAnalysis };

/** Parse once so authorization and remembered-approval matching share one structural graph. */
export function inspectBash(command: string | undefined, executionContext: ShellContext = LOCAL_CONTEXT): ShellInspection {
  return inspectShell(command ?? "", executionContext);
}
export function analyzeBash(command: string | undefined, executionContext: ShellContext = LOCAL_CONTEXT): ShellAnalysis {
  return inspectBash(command, executionContext).analysis;
}

/** Decides exclusively from structural analysis; flattened commands are display metadata. */
export function decideAnalysis(analysis: ShellAnalysis, style: "Micromanagement" | "Empowerment"): PermissionDecision {
  if (style === "Micromanagement") {
    return { allow: false, needsApproval: true, analysis, reason: "Micromanagement asks before every Bash call" };
  }
  const hasReadOnlyUnit = analysis.executionUnits.some((unit) => unit.effect === "read-only");
  const hasNonReadOnlyUnit = analysis.executionUnits.some((unit) => unit.effect !== "read-only");
  if (hasReadOnlyUnit && hasNonReadOnlyUnit) {
    return {
      allow: false,
      needsApproval: false,
      analysis,
      reason: "Split read-only top-level inspection units from mutations or unknown units, preserving any &&/|| condition; Pi will not split shell text automatically.",
    };
  }
  if (analysis.complete && analysis.executionUnits.length > 0 && analysis.executionUnits.every((unit) => unit.effect === "read-only")) {
    return { allow: true, needsApproval: false, analysis };
  }
  return {
    allow: false,
    needsApproval: true,
    analysis,
    reason: analysis.reasons[0] ?? "Bash command is not a fully classified read-only command",
  };
}

export function decideBash(
  command: string | undefined,
  style: "Micromanagement" | "Empowerment",
  executionContext: ShellContext = LOCAL_CONTEXT,
): PermissionDecision {
  return decideAnalysis(inspectBash(command, executionContext).analysis, style);
}
