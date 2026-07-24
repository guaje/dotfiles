import { parseShell } from "./parser.ts";
import type { PermissionDecision, ShellAnalysis, ShellContext } from "../types.ts";

const LOCAL_CONTEXT: ShellContext = { location: "local", usesNetwork: false };

export function analyzeBash(command: string | undefined, executionContext: ShellContext = LOCAL_CONTEXT): ShellAnalysis {
  const analysis = parseShell(command ?? "");
  if (executionContext.location === "local" && !executionContext.transport) return analysis;
  return {
    ...analysis,
    context: executionContext,
    commands: analysis.commands.map((item) => item.context.transport || item.context.usesNetwork
      ? item
      : { ...item, context: executionContext }),
  };
}

export function decideBash(
  command: string | undefined,
  style: "Micromanagement" | "Empowerment",
  executionContext: ShellContext = LOCAL_CONTEXT,
): PermissionDecision {
  const analysis = analyzeBash(command, executionContext);
  if (style === "Micromanagement") {
    return { allow: false, needsApproval: true, analysis, reason: "Micromanagement asks before every Bash call" };
  }
  if (analysis.containsReadOnly && analysis.containsNonReadOnly) {
    return {
      allow: false,
      needsApproval: false,
      analysis,
      reason: "Split read-only inspection commands from mutations or unknown commands; Pi will not split shell text automatically.",
    };
  }
  if (analysis.complete && analysis.effect === "read-only") return { allow: true, needsApproval: false, analysis };
  return {
    allow: false,
    needsApproval: true,
    analysis,
    reason: analysis.reasons[0] ?? "Bash command is not a fully classified read-only command",
  };
}
