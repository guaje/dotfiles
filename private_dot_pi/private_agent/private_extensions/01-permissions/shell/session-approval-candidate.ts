import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { canonicalExistingOrParent } from "../access-policy.ts";
import { approvalFingerprint, type SessionApprovalRuleInput } from "../session-command-approvals.ts";
import type { AstCommand, AstSsh, ShellGraph, ShellNode } from "./ast.ts";
import { deriveSessionApprovalTemplate, structurallyStableWord, type ApprovalTransport } from "./session-approval-templates.ts";
import { discoverWorkspaceBoundary, executableEnvironmentVeto, resolveStrictExecutable } from "./executable-identity.ts";
import { hasRuntimeExecutionRisk, isProgrammableInterpreter } from "./profiles.ts";
import type { ShellInspection } from "./policy.ts";

export const SESSION_APPROVAL_OPTION_LABEL = "Allow similar commands for this session";

export interface ApprovalCandidate {
  rule: SessionApprovalRuleInput;
  rememberLabel: typeof SESSION_APPROVAL_OPTION_LABEL;
  ruleDescription: string;
}

type DirectCandidate = { command: AstCommand; ssh?: AstSsh };

function directCandidate(graph: ShellGraph): DirectCandidate | undefined {
  const root: ShellNode = graph.root;
  if (root.kind === "command") return { command: root };
  if (root.kind !== "ssh" || !root.payload || root.payload.root.kind !== "command") return undefined;
  const payload = root.payload.root;
  if (payload.redirections.length || payload.words.some((word) => !structurallyStableWord(word))) return undefined;
  return { command: root.command, ssh: root };
}

function interactiveCommand(command: AstCommand) {
  const executable = basename(command.words[0]?.value ?? "").toLowerCase();
  const argv = command.words.slice(1).map((word) => word.value);
  if (["vim", "vi", "nano", "less", "more", "top", "htop", "man", "watch"].includes(executable)) return true;
  if (["sh", "bash", "zsh", "fish", "ksh"].includes(executable)) return true;
  const gitCommitWithoutMessage = executable === "git" && argv.includes("commit") && !argv.some((argument) => argument === "-m" || argument === "--message" || argument.startsWith("--message="));
  const sshRequestsTty = executable === "ssh" && argv.some((argument, index) =>
    (/^-[^-]*t/.test(argument) && argument !== "-T")
    || /^-o(?:=)?requesttty(?:=|$)/i.test(argument)
    || ((argument === "-o" || argument === "-o=") && /^requesttty(?:=|$)/i.test(argv[index + 1] ?? "")));
  return argv.some((argument) => argument === "--interactive" || argument.startsWith("--interactive=") || argument === "--edit" || argument === "--prompt" || argument.startsWith("--prompt="))
    || (["rm", "cp", "mv"].includes(executable) && argv.some((argument) => argument === "--interactive" || /^-[^-]*[iI]/.test(argument)))
    || (executable === "git" && (argv.includes("-i") || argv.includes("-p") || argv.includes("--patch")))
    || gitCommitWithoutMessage
    || sshRequestsTty;
}

function eligibleCommand(command: AstCommand, allowTestGlob = false) {
  const executable = command.words[0]?.value ?? "";
  const argv = command.words.slice(1).map((word) => word.value);
  return !command.redirections.length
    && command.words.every((word) => structurallyStableWord(word, allowTestGlob))
    && !interactiveCommand(command)
    && !isProgrammableInterpreter(executable)
    && !hasRuntimeExecutionRisk(executable, argv);
}

function eligibleDirectCandidate(inspection: ShellInspection) {
  const candidate = directCandidate(inspection.graph);
  if (!inspection.analysis.complete
    || inspection.analysis.executionUnits.length !== 1
    || inspection.analysis.executionUnits[0]?.effect === "read-only"
    || !candidate
    || !eligibleCommand(candidate.command, true)) return undefined;
  if (candidate.ssh?.payload?.root.kind === "command" && !eligibleCommand(candidate.ssh.payload.root)) return undefined;
  return candidate;
}

async function resolveLocalExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (executableEnvironmentVeto(env, executable)) return undefined;
  const workspace = await discoverWorkspaceBoundary(cwd);
  if (!workspace.ok) return undefined;
  const resolved = await resolveStrictExecutable(executable, workspace.cwd, workspace.boundary, { env });
  return resolved.ok ? resolved.path : undefined;
}

/** Builds a non-authoritative session-consent template from the already inspected AST. */
export async function approvalCandidate(inspection: ShellInspection, cwd: string, handoffScope?: string, executionEnv: NodeJS.ProcessEnv = process.env): Promise<ApprovalCandidate | undefined> {
  const direct = eligibleDirectCandidate(inspection);
  if (!direct) return undefined;

  const transport: ApprovalTransport = inspection.analysis.context.transport === "handoff"
    ? "handoff"
    : direct.ssh ? "ssh" : "local";
  if (transport === "handoff" && !handoffScope) return undefined;

  const canonicalCwd = transport === "handoff" ? undefined : await realpath(cwd).catch(() => undefined);
  if (transport !== "handoff" && !canonicalCwd) return undefined;
  const executable = direct.command.words[0]!.value;
  const executableIdentity = transport === "handoff"
    ? `remote:${executable}`
    : await resolveLocalExecutable(executable, canonicalCwd!, executionEnv);
  if (!executableIdentity) return undefined;

  const scopeIdentity = transport === "handoff" ? handoffScope! : await canonicalExistingOrParent(canonicalCwd!).catch(() => undefined);
  if (!scopeIdentity) return undefined;
  const effect = inspection.analysis.executionUnits[0]!.effect;
  const template = await deriveSessionApprovalTemplate({
    command: direct.command,
    cwd: canonicalCwd ?? scopeIdentity,
    transport,
    executableIdentity,
  });
  if (!template) return undefined;

  const fingerprintScope = template.scopeIdentity ?? scopeIdentity;
  const identity = approvalFingerprint(
    "similar-template-v2",
    template.strength,
    template.signatureId ?? "",
    effect,
    "invocation-token",
    executable,
    executableIdentity,
    transport,
    fingerprintScope,
    ...template.fingerprintParts,
  );
  const contextLabel = transport === "ssh" ? "SSH" : transport === "handoff" ? "Handoff" : "local";
  return {
    rule: {
      ...identity,
      kind: "similar",
      strength: template.strength,
      signatureId: template.signatureId,
      contextLabel,
      anchorCount: template.anchorCount,
      slotCount: template.slotTypes.length,
      slotTypes: template.slotTypes,
      label: template.label,
    },
    rememberLabel: SESSION_APPROVAL_OPTION_LABEL,
    ruleDescription: template.preview,
  };
}
