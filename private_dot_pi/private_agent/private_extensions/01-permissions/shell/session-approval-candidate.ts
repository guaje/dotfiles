import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
import { canonicalExistingOrParent, canonicalGitWorktree, contained } from "../access-policy.ts";
import { approvalFingerprint, type SessionApprovalRuleInput } from "../session-command-approvals.ts";
import type { AstCommand, AstSsh, AstWord, ShellGraph, ShellNode } from "./ast.ts";
import type { ShellInspection } from "./policy.ts";

export interface ApprovalCandidate {
  rule: SessionApprovalRuleInput;
  rememberLabel: string;
  ruleDescription: string;
}

type DirectCandidate = { command: AstCommand; ssh?: AstSsh };

function cleanLabel(value: string) {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 48);
  return cleaned || "command";
}

function stableLiteralWord(word: AstWord) {
  if (!word.literal || word.substitutions.length > 0 || word.value.includes("\0")) return false;
  const shellExpands = word.value.startsWith("~") || ["*", "?", "[", "]", "{", "}"].some((character) => word.value.includes(character));
  if (!shellExpands) return true;
  const raw = word.raw;
  return raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')));
}

function directCandidate(graph: ShellGraph): DirectCandidate | undefined {
  const root: ShellNode = graph.root;
  if (root.kind === "command") return { command: root };
  if (root.kind !== "ssh" || !root.payload || root.payload.root.kind !== "command") return undefined;
  const payload = root.payload.root;
  if (payload.redirections.length || payload.words.some((word) => !stableLiteralWord(word))) return undefined;
  return { command: root.command, ssh: root };
}

function interactiveCommand(command: AstCommand) {
  const executable = basename(command.words[0]?.value ?? "").toLowerCase();
  const argv = command.words.slice(1).map((word) => word.value);
  if (["vim", "vi", "nano", "less", "more", "top", "htop", "man", "watch"].includes(executable)) return true;
  if (["bash", "sh", "zsh", "fish"].includes(executable) && (!argv.length || argv.includes("-i") || argv.includes("--interactive") || argv.includes("-c") || argv.includes("--command"))) return true;
  const gitCommitWithoutMessage = executable === "git" && argv[0] === "commit" && !argv.some((argument) => argument === "-m" || argument.startsWith("--message="));
  return argv.some((argument) => argument === "--interactive" || argument.startsWith("--interactive=") || argument === "--edit")
    || (["rm", "cp", "mv"].includes(executable) && argv.includes("-i"))
    || (executable === "git" && (argv.includes("-i") || argv.includes("-p") || argv.includes("--patch")))
    || gitCommitWithoutMessage;
}

function isInteractive(candidate: DirectCandidate) {
  if (interactiveCommand(candidate.command)) return true;
  if (!candidate.ssh) return false;
  const argv = candidate.command.words.slice(1).map((word) => word.value);
  if (!candidate.ssh.payload || argv.some((argument) => /^-t+$/.test(argument))) return true;
  return candidate.ssh.payload.root.kind === "command" && interactiveCommand(candidate.ssh.payload.root);
}

function literalDirectCandidate(inspection: ShellInspection) {
  const candidate = directCandidate(inspection.graph);
  if (!inspection.analysis.complete
    || inspection.analysis.executionUnits.length !== 1
    || inspection.analysis.executionUnits[0]?.effect === "read-only"
    || !candidate
    || candidate.command.redirections.length
    || isInteractive(candidate)) return undefined;
  if (!candidate.command.words.length || candidate.command.words.some((word) => !stableLiteralWord(word))) return undefined;
  return candidate;
}

async function resolveLocalExecutable(executable: string, cwd: string) {
  const candidates = executable.includes("/")
    ? [isAbsolute(executable) ? executable : resolve(cwd, executable)]
    : (process.env.PATH ?? "").split(delimiter).map((entry) => resolve(entry || cwd, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    }
    catch { /* try the next PATH entry */ }
  }
  return undefined;
}

function plainGitAddPaths(command: AstCommand): AstWord[] | undefined {
  if (basename(command.words[0]?.value ?? "").toLowerCase() !== "git" || command.words[1]?.value !== "add") return undefined;
  const operands: AstWord[] = [];
  let separator = false;
  for (const word of command.words.slice(2)) {
    const value = word.value;
    if (value === "--" && !separator) { separator = true; continue; }
    if (value === "--" || !value || value.startsWith(":") || ["*", "?", "[", "]", "\\"].some((character) => value.includes(character)) || (!separator && value.startsWith("-"))) return undefined;
    operands.push(word);
  }
  return operands.length ? operands : undefined;
}

async function gitAddCandidate(inspection: ShellInspection, direct: DirectCandidate, cwd: string, executableIdentity: string): Promise<ApprovalCandidate | null | undefined> {
  if (direct.ssh) return undefined;
  const command = direct.command;
  if (basename(command.words[0]?.value ?? "").toLowerCase() !== "git" || command.words[1]?.value !== "add") return undefined;
  const paths = plainGitAddPaths(command);
  if (!paths) return undefined;
  const workspace = await canonicalGitWorktree(cwd);
  if (!workspace) return null;
  for (const path of paths) {
    const target = await canonicalExistingOrParent(resolve(workspace.cwd, path.value)).catch(() => undefined);
    if (!target || !contained(workspace.worktree, target)) return null;
  }
  const identity = approvalFingerprint("template", "git-add-workspace-v1", executableIdentity, workspace.cwd, workspace.worktree);
  return {
    rule: { ...identity, kind: "git-add", label: "git add <workspace paths> · local" },
    rememberLabel: "Allow similar commands for this session",
    ruleDescription: "git add <paths inside this workspace>",
  };
}

/**
 * Derives a remembered-consent rule from the structural graph. Authorization never
 * consumes this result, and no matching data comes from display commands or rendering.
 */
export async function approvalCandidate(inspection: ShellInspection, cwd: string, handoffScope?: string): Promise<ApprovalCandidate | undefined> {
  const direct = literalDirectCandidate(inspection);
  if (!direct) return undefined;

  const transport = inspection.analysis.context.transport === "handoff"
    ? "handoff"
    : direct.ssh ? "ssh" : "local";
  if (transport === "handoff" && !handoffScope) return undefined;

  const canonicalCwd = transport === "handoff"
    ? undefined
    : await canonicalExistingOrParent(cwd).catch(() => undefined);
  if (transport !== "handoff" && !canonicalCwd) return undefined;

  const executable = direct.command.words[0]!.value;
  const executableIdentity = transport === "handoff"
    ? `remote:${executable}`
    : await resolveLocalExecutable(executable, canonicalCwd!);
  if (!executableIdentity) return undefined;

  if (transport === "local") {
    const similar = await gitAddCandidate(inspection, direct, canonicalCwd!, executableIdentity);
    if (similar === null) return undefined;
    if (similar) return similar;
  }

  const normalizedWords = direct.command.words.map((word) => word.value);
  const scopeIdentity = transport === "handoff" ? handoffScope! : canonicalCwd!;
  const identity = approvalFingerprint("exact", transport, scopeIdentity, executableIdentity, ...normalizedWords);
  const executableLabel = cleanLabel(basename(executable));
  const contextLabel = transport === "ssh" ? "SSH" : transport === "handoff" ? "Handoff" : "local";
  const label = `${executableLabel} · exact · ${Math.max(0, normalizedWords.length - 1)} arguments · ${contextLabel}`;
  return {
    rule: { ...identity, kind: "exact", label },
    rememberLabel: "Allow this exact command for this session",
    ruleDescription: `Exact ${contextLabel} invocation of ${executableLabel}`,
  };
}
