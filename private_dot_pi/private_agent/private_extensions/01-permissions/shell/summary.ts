import type { ShellAnalysis } from "../types.ts";
export function summarizeShell(analysis: ShellAnalysis) {
  if (!analysis.commands.length) return "No supported command detected.";
  const programs = analysis.commands.map((command, index) => `${index + 1}) ${command.name}`).join(", ");
  const reasons = analysis.reasons.length ? `\n\nApproval reasons: ${[...new Set(analysis.reasons)].join("; ")}` : "";
  return `Programs to run: ${programs}${reasons}`;
}
