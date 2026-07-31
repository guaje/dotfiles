import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonicalExistingOrParent, canonicalGitWorktree, contained } from "../access-policy.ts";
import type { SessionApprovalSlotType, SessionApprovalTemplateStrength } from "../types.ts";
import type { AstCommand, AstWord } from "./ast.ts";

export type { SessionApprovalSlotType, SessionApprovalTemplateStrength } from "../types.ts";
export type ApprovalTransport = "local" | "handoff" | "ssh";

export interface SessionApprovalTemplate {
  strength: SessionApprovalTemplateStrength;
  signatureId?: string;
  fingerprintParts: string[];
  scopeIdentity?: string;
  preview: string;
  label: string;
  anchorCount: number;
  slotTypes: SessionApprovalSlotType[];
}

export interface SessionApprovalTemplateInput {
  command: AstCommand;
  cwd: string;
  transport: ApprovalTransport;
  executableIdentity: string;
}

type SignatureResult = SessionApprovalTemplate | "unsafe" | undefined;
type ApprovalSignature = {
  id: string;
  executables: ReadonlySet<string>;
  match(input: SessionApprovalTemplateInput): Promise<SignatureResult>;
};

type PathSignature = {
  id: string;
  executable: string;
  minimumPaths: number;
  fixedLeading: number;
  exactPaths?: number;
  fixedDestination?: boolean;
  allowedOptions: ReadonlySet<string>;
};

const PACKAGE_RUNNERS = new Set(["npx", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo"]);
const SIGNATURE_REQUIRED = new Set(["chezmoi"]);
const FILE_SUFFIX = /\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

function quoted(raw: string) {
  return raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')));
}

export function permittedTestGlob(word: AstWord) {
  if (quoted(word.raw) || !word.value.includes("*")) return false;
  const parts = word.value.split("/");
  const leaf = parts.at(-1) ?? "";
  return parts.slice(0, -1).every((part) => part && !/[?*\[\]{}\\]/.test(part) && part !== "..")
    && /^[^*?\[\]{}\\]*\*[^*?\[\]{}\\]*\.test\.ts$/.test(leaf);
}

export function structurallyStableWord(word: AstWord, allowTestGlob = false) {
  if (!word.literal || word.substitutions.length || word.value.includes("\0")) return false;
  const shellExpansion = ["*", "?", "[", "]", "{", "}"].some((character) => word.value.includes(character));
  return !shellExpansion || quoted(word.raw) || (allowTestGlob && permittedTestGlob(word));
}

function normalizeLocalPath(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function safePreviewExecutable(command: AstCommand) {
  return basename(command.words[0]?.value ?? "command").replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 48) || "command";
}

async function canonicalWorkspacePath(value: string, cwd: string) {
  const target = await canonicalExistingOrParent(resolve(cwd, normalizeLocalPath(value))).catch(() => undefined);
  return target && contained(cwd, target) ? target : undefined;
}

function globLeafPattern(leaf: string) {
  const expression = leaf.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${expression}$`);
}

async function safeWorkspaceTestOperand(word: AstWord, cwd: string) {
  if (!permittedTestGlob(word)) return structurallyStableWord(word) && word.value.endsWith(".test.ts") && await canonicalWorkspacePath(word.value, cwd) ? true : false;
  const directory = resolve(cwd, dirname(word.value));
  const canonicalDirectory = await canonicalExistingOrParent(directory).catch(() => undefined);
  if (!canonicalDirectory || !contained(cwd, canonicalDirectory)) return false;
  const leaf = basename(word.value);
  const pattern = globLeafPattern(leaf);
  const names = await readdir(directory).catch(() => undefined);
  const matches = names?.filter((name) => (!name.startsWith(".") || leaf.startsWith(".")) && pattern.test(name)) ?? [];
  if (!matches.length) return false;
  for (const name of matches) {
    if (!await canonicalWorkspacePath(resolve(directory, name), cwd)) return false;
  }
  return true;
}

async function highConfidenceWorkspacePath(word: AstWord, cwd: string): Promise<"path" | "unsafe" | undefined> {
  const value = word.value;
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return undefined;
  const resolved = resolve(cwd, normalizeLocalPath(value));
  const pathLike = isAbsolute(value)
    || value.startsWith("./")
    || value.startsWith("../")
    || value.includes("/")
    || FILE_SUFFIX.test(basename(value))
    || Boolean(await stat(resolved).catch(() => undefined));
  if (!pathLike) return undefined;
  return await canonicalWorkspacePath(value, cwd) ? "path" : "unsafe";
}

function template(options: {
  strength: SessionApprovalTemplateStrength;
  signatureId?: string;
  fingerprintParts: string[];
  scopeIdentity?: string;
  preview: string;
  label: string;
  anchorCount: number;
  slotTypes: SessionApprovalSlotType[];
}): SessionApprovalTemplate {
  return options;
}

function parseGitPrefix(command: AstCommand) {
  if (basename(command.words[0]?.value ?? "").toLowerCase() !== "git") return undefined;
  let index = 1;
  let gitCwd: AstWord | undefined;
  if (command.words[index]?.value === "-C") {
    gitCwd = command.words[index + 1];
    if (!gitCwd || !structurallyStableWord(gitCwd)) return "unsafe" as const;
    index += 2;
  }
  if (!command.words[index] || command.words[index]!.value.startsWith("-")) return "unsafe" as const;
  return { gitCwd, subcommand: command.words[index]!.value, args: command.words.slice(index + 1) };
}

async function gitScope(input: SessionApprovalTemplateInput, gitCwd: AstWord | undefined) {
  const directory = gitCwd ? resolve(input.cwd, normalizeLocalPath(gitCwd.value)) : input.cwd;
  const workspace = await canonicalGitWorktree(directory);
  if (!workspace || (gitCwd && workspace.cwd !== workspace.worktree)) return undefined;
  return workspace;
}

const gitSignature: ApprovalSignature = {
  id: "git-v2",
  executables: new Set(["git"]),
  async match(input) {
    if (input.transport !== "local") return undefined;
    const parsed = parseGitPrefix(input.command);
    if (!parsed || parsed === "unsafe") return parsed;
    if (parsed.subcommand !== "add" && parsed.subcommand !== "commit") return undefined;
    const workspace = await gitScope(input, parsed.gitCwd);
    if (!workspace) return "unsafe";
    const prefix = parsed.gitCwd ? ["git-cwd", workspace.worktree] : ["git-cwd", workspace.cwd];

    if (parsed.subcommand === "add") {
      const paths: AstWord[] = [];
      let separator = false;
      for (const word of parsed.args) {
        if (word.value === "--" && !separator) { separator = true; continue; }
        if (!word.value || word.value === "--" || word.value.startsWith(":") || (!separator && word.value.startsWith("-")) || !structurallyStableWord(word)) return undefined;
        if (!await canonicalWorkspacePath(word.value, workspace.worktree)) return "unsafe";
        paths.push(word);
      }
      if (!paths.length) return undefined;
      return template({
        strength: "audited",
        signatureId: "git-add-workspace-v2",
        fingerprintParts: [...prefix, "subcommand:add", "slot:workspace-path-list"],
        scopeIdentity: workspace.worktree,
        preview: "git add <workspace paths>",
        label: "git add <workspace paths> · audited · 1 variable group",
        anchorCount: 1,
        slotTypes: ["workspace-path-list"],
      });
    }

    const fixed: string[] = [...prefix, "subcommand:commit"];
    const slots: SessionApprovalSlotType[] = [];
    let hasMessage = false;
    for (let index = 0; index < parsed.args.length; index++) {
      const word = parsed.args[index]!;
      if (word.value === "-m" || word.value === "--message") {
        const value = parsed.args[++index];
        if (!value || !structurallyStableWord(value)) return "unsafe";
        fixed.push(`fixed:${word.value}`, "slot:opaque");
        slots.push("opaque");
        hasMessage = true;
        continue;
      }
      if (word.value.startsWith("--message=")) {
        fixed.push("fixed:--message", "slot:opaque");
        slots.push("opaque");
        hasMessage = true;
        continue;
      }
      if (word.value.startsWith("-")) {
        // Unknown separated option arity is ambiguous; keep this invocation conservative.
        if (!["--amend", "--no-edit", "--no-verify", "--signoff", "-s", "--allow-empty", "--allow-empty-message", "--all", "-a", "--verbose", "-v", "--quiet", "-q"].includes(word.value)) return undefined;
        fixed.push(`fixed:${word.value}`);
        continue;
      }
      if (!await canonicalWorkspacePath(word.value, workspace.worktree)) return "unsafe";
      fixed.push("slot:workspace-path");
      slots.push("workspace-path");
    }
    if (!hasMessage) return undefined;
    return template({
      strength: "audited",
      signatureId: "git-commit-message-v2",
      fingerprintParts: [...fixed, ...slots.map((slot) => `slot-type:${slot}`)],
      scopeIdentity: workspace.worktree,
      preview: "git commit -m <message>",
      label: `git commit · audited · ${slots.length} variable slot${slots.length === 1 ? "" : "s"}`,
      anchorCount: 1,
      slotTypes: slots,
    });
  },
};

const npxTestSignature: ApprovalSignature = {
  id: "npx-tsx-test-v2",
  executables: new Set(["npx"]),
  async match(input) {
    if (input.transport !== "local") return undefined;
    const words = input.command.words;
    if (words[1]?.value !== "-y" || words[2]?.value !== "tsx" || words[3]?.value !== "--test" || !/^--test-concurrency=[1-9]\d*$/.test(words[4]?.value ?? "")) return undefined;
    const paths = words.slice(5);
    if (!paths.length) return "unsafe";
    for (const word of paths) {
      if (isAbsolute(word.value) || word.value.split("/").includes("..") || (!structurallyStableWord(word) && !permittedTestGlob(word))) return "unsafe";
      if (!await safeWorkspaceTestOperand(word, input.cwd)) return "unsafe";
    }
    return template({
      strength: "audited",
      signatureId: "npx-tsx-test-v2",
      fingerprintParts: ["launcher:tsx", "mode:test", `fixed:${words[4]!.value}`, "slot:workspace-path-list"],
      preview: "npx -y tsx --test <workspace test files>",
      label: "npx tsx tests · audited · 1 variable group",
      anchorCount: 1,
      slotTypes: ["workspace-path-list"],
    });
  },
};

const chezmoiAddSignature: ApprovalSignature = {
  id: "chezmoi-add-workspace-v1",
  executables: new Set(["chezmoi"]),
  async match(input) {
    if (input.transport !== "local" || input.command.words[1]?.value !== "add") return undefined;
    const paths: AstWord[] = [];
    let separator = false;
    for (const word of input.command.words.slice(2)) {
      if (word.value === "--" && !separator) { separator = true; continue; }
      if (!separator && word.value.startsWith("-")) return "unsafe";
      if (!structurallyStableWord(word) || !await canonicalWorkspacePath(word.value, input.cwd)) return "unsafe";
      paths.push(word);
    }
    if (!paths.length) return "unsafe";
    return template({
      strength: "audited",
      signatureId: "chezmoi-add-workspace-v1",
      fingerprintParts: ["subcommand:add", ...(separator ? ["fixed:--"] : []), "slot:workspace-path-list"],
      preview: "chezmoi add <workspace paths>",
      label: "chezmoi add · audited · 1 variable path group",
      anchorCount: 1,
      slotTypes: ["workspace-path-list"],
    });
  },
};

const PATH_SIGNATURES: PathSignature[] = [
  { id: "rm-paths-v1", executable: "rm", minimumPaths: 1, fixedLeading: 0, allowedOptions: new Set(["-f", "--force", "-r", "-R", "--recursive", "-d", "--dir", "-v", "--verbose", "-rf", "-fr", "-rF"]) },
  { id: "touch-paths-v1", executable: "touch", minimumPaths: 1, fixedLeading: 0, allowedOptions: new Set(["-a", "-c", "--no-create", "-m"]) },
  { id: "mkdir-paths-v1", executable: "mkdir", minimumPaths: 1, fixedLeading: 0, allowedOptions: new Set(["-p", "--parents", "-v", "--verbose"]) },
  { id: "rmdir-paths-v1", executable: "rmdir", minimumPaths: 1, fixedLeading: 0, allowedOptions: new Set(["-p", "--parents", "-v", "--verbose"]) },
  { id: "cp-paths-v2", executable: "cp", minimumPaths: 2, fixedLeading: 0, exactPaths: 2, fixedDestination: true, allowedOptions: new Set(["-f", "--force", "-n", "--no-clobber", "-v", "--verbose", "-r", "-R", "--recursive", "-a", "--archive"]) },
  { id: "mv-paths-v2", executable: "mv", minimumPaths: 2, fixedLeading: 0, exactPaths: 2, fixedDestination: true, allowedOptions: new Set(["-f", "--force", "-n", "--no-clobber", "-v", "--verbose"]) },
  { id: "ln-paths-v1", executable: "ln", minimumPaths: 2, fixedLeading: 0, exactPaths: 2, fixedDestination: true, allowedOptions: new Set(["-f", "--force", "-n", "--no-dereference", "-s", "--symbolic", "-v", "--verbose"]) },
  { id: "chmod-paths-v1", executable: "chmod", minimumPaths: 1, fixedLeading: 1, allowedOptions: new Set(["-R", "--recursive", "-v", "--verbose", "-c", "--changes", "-f", "--silent", "--quiet"]) },
  { id: "chown-paths-v1", executable: "chown", minimumPaths: 1, fixedLeading: 1, allowedOptions: new Set(["-R", "--recursive", "-v", "--verbose", "-c", "--changes", "-f", "--silent", "--quiet"]) },
  { id: "chgrp-paths-v1", executable: "chgrp", minimumPaths: 1, fixedLeading: 1, allowedOptions: new Set(["-R", "--recursive", "-v", "--verbose", "-c", "--changes", "-f", "--silent", "--quiet"]) },
];

const pathSignatures: ApprovalSignature[] = PATH_SIGNATURES.map((definition) => ({
  id: definition.id,
  executables: new Set([definition.executable]),
  async match(input) {
    if (input.transport !== "local") return undefined;
    const fixed: string[] = [];
    const operands: AstWord[] = [];
    let separator = false;
    for (const word of input.command.words.slice(1)) {
      if (word.value === "--" && !separator) { separator = true; fixed.push("fixed:--"); continue; }
      if (!separator && word.value.startsWith("-")) {
        if (!definition.allowedOptions.has(word.value)) return "unsafe";
        fixed.push(`fixed:${word.value}`);
      }
      else operands.push(word);
    }
    if (operands.length < definition.fixedLeading + definition.minimumPaths) return "unsafe";
    const leading = operands.slice(0, definition.fixedLeading);
    const paths = operands.slice(definition.fixedLeading);
    if (definition.exactPaths !== undefined && paths.length !== definition.exactPaths) return "unsafe";
    if (leading.some((word) => !structurallyStableWord(word))) return "unsafe";
    for (const path of paths) {
      if (!structurallyStableWord(path) || !await canonicalWorkspacePath(path.value, input.cwd)) return "unsafe";
    }
    const destination = definition.fixedDestination ? paths.at(-1)! : undefined;
    const slots: SessionApprovalSlotType[] = definition.fixedDestination ? ["workspace-path"] : ["workspace-path-list"];
    return template({
      strength: "audited",
      signatureId: definition.id,
      fingerprintParts: [
        ...fixed,
        ...leading.map((word) => `fixed-leading:${word.value}`),
        definition.fixedDestination ? "slot:source-workspace-path" : "slot:workspace-path-list",
        ...(destination ? [`fixed-destination:${destination.value}`] : []),
      ],
      preview: definition.fixedDestination
        ? `${definition.executable} <workspace source> <same destination>`
        : `${definition.executable} ${leading.map((word) => word.value).join(" ")}${leading.length ? " " : ""}<workspace paths>`,
      label: `${definition.executable} · audited · 1 variable ${definition.fixedDestination ? "source slot" : "path group"}`,
      anchorCount: definition.fixedLeading + (definition.fixedDestination ? 1 : 0),
      slotTypes: slots,
    });
  },
}));

export const SESSION_APPROVAL_SIGNATURES: readonly ApprovalSignature[] = [gitSignature, npxTestSignature, chezmoiAddSignature, ...pathSignatures];

async function conservativeTemplate(input: SessionApprovalTemplateInput): Promise<SessionApprovalTemplate | undefined> {
  const name = safePreviewExecutable(input.command);
  if (PACKAGE_RUNNERS.has(name.toLowerCase())) return undefined;
  const parts: string[] = [];
  const slots: SessionApprovalSlotType[] = [];
  let anchorCount = 0;
  let afterSeparator = false;
  let fixNext = false;
  for (let index = 1; index < input.command.words.length; index++) {
    const word = input.command.words[index]!;
    if (!structurallyStableWord(word)) return undefined;
    if (input.transport !== "local") {
      parts.push(`fixed:${index}:${word.value}`);
      continue;
    }
    if (word.value === "--") { parts.push(`fixed:${index}:--`); afterSeparator = true; fixNext = false; continue; }
    if (!afterSeparator && word.value.startsWith("-")) {
      parts.push(`fixed:${index}:${word.value}`);
      fixNext = !word.value.includes("=");
      continue;
    }
    if (fixNext) {
      parts.push(`fixed:${index}:${word.value}`);
      fixNext = false;
      continue;
    }
    const pathRole = await highConfidenceWorkspacePath(word, input.cwd);
    if (pathRole === "unsafe") return undefined;
    if (pathRole === "path") {
      parts.push(`slot:${index}:workspace-path`);
      slots.push("workspace-path");
      continue;
    }
    parts.push(`fixed:${index}:${word.value}`);
    anchorCount++;
  }
  return template({
    strength: "conservative",
    fingerprintParts: parts,
    preview: `${name} · same operation/options${slots.length ? ` · ${slots.length} workspace-path slot${slots.length === 1 ? "" : "s"}` : " · no variable slots"}`,
    label: `${name} · conservative · ${slots.length ? `${slots.length} variable path slot${slots.length === 1 ? "" : "s"}` : "no variable slots"}`,
    anchorCount,
    slotTypes: slots,
  });
}

export async function deriveSessionApprovalTemplate(input: SessionApprovalTemplateInput): Promise<SessionApprovalTemplate | undefined> {
  const executable = basename(input.command.words[0]?.value ?? "").toLowerCase();
  for (const signature of SESSION_APPROVAL_SIGNATURES) {
    if (!signature.executables.has(executable)) continue;
    const result = await signature.match(input);
    if (result === "unsafe") return undefined;
    if (result) return result;
  }
  if (SIGNATURE_REQUIRED.has(executable)) return undefined;
  return conservativeTemplate(input);
}
