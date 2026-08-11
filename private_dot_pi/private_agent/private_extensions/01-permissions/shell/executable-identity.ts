import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { contained } from "../access-policy.ts";
import type { ExecutableIdentityRequirement, ShellAnalysis } from "../types.ts";

export type IdentityVerification = { ok: true } | { ok: false; reason: string };

export interface ExecutableIdentityDependencies {
  env?: NodeJS.ProcessEnv;
  access?: typeof access;
  lstat?: typeof lstat;
  readFile?: typeof readFile;
  realpath?: typeof realpath;
}

const REVIEWED_BUILTINS = new Set([
  "[", "cd", "command", "echo", "false", "printf", "pwd", "test", "true", "type",
]);

function failure(reason: string): IdentityVerification { return { ok: false, reason }; }
function errorCode(error: unknown) { return (error as NodeJS.ErrnoException)?.code; }
function functionOverride(env: NodeJS.ProcessEnv, name: string) {
  const expected = `BASH_FUNC_${name}%%`;
  return Object.keys(env).some((key) => key === expected || key === `BASH_FUNC_${name}()`);
}
export function executableEnvironmentVeto(env: NodeJS.ProcessEnv, name?: string) {
  if (env.BASH_ENV || env.ENV || env.ZDOTDIR) return "shell startup environment can override executable behavior";
  if (name && functionOverride(env, name)) return `${name} is overridden by an exported shell function`;
  return undefined;
}

/**
 * Discovers the untrusted workspace boundary without executing PATH-resolved git.
 * The outermost canonical ancestor containing a valid .git marker wins so nested repositories cannot narrow the untrusted boundary.
 */
export async function discoverWorkspaceBoundary(
  cwd: string,
  dependencies: ExecutableIdentityDependencies = {},
): Promise<{ ok: true; cwd: string; boundary: string } | { ok: false; reason: string }> {
  const fsRealpath = dependencies.realpath ?? realpath;
  const fsLstat = dependencies.lstat ?? lstat;
  const fsReadFile = dependencies.readFile ?? readFile;
  const canonicalCwd = await fsRealpath(cwd).catch(() => undefined);
  if (!canonicalCwd) return { ok: false, reason: "working directory identity could not be canonicalized" };

  let current = canonicalCwd;
  let boundary: string | undefined;
  while (true) {
    const marker = join(current, ".git");
    let markerStat;
    try { markerStat = await fsLstat(marker); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") return { ok: false, reason: "workspace marker could not be inspected safely" };
    }
    if (markerStat) {
      if (markerStat.isSymbolicLink()) return { ok: false, reason: "workspace marker symlinks are not trusted" };
      if (markerStat.isDirectory()) boundary = current;
      else {
        if (!markerStat.isFile()) return { ok: false, reason: "workspace marker has an unsupported type" };
        let text: string;
        try { text = await fsReadFile(marker, "utf8"); }
        catch { return { ok: false, reason: "workspace marker file could not be read" }; }
        const lines = text.trim().split(/\r?\n/);
        const match = lines.length === 1 ? /^gitdir:\s*(.+)$/.exec(lines[0]!) : undefined;
        if (!match?.[1] || match[1].includes("\0")) return { ok: false, reason: "workspace marker file is malformed" };
        const gitDirPath = resolve(current, match[1]);
        let gitDirStat;
        try { gitDirStat = await fsLstat(gitDirPath); }
        catch { return { ok: false, reason: "workspace git directory could not be inspected" }; }
        if (gitDirStat.isSymbolicLink() || !gitDirStat.isDirectory()) return { ok: false, reason: "workspace git directory is ambiguous" };
        const canonicalGitDir = await fsRealpath(gitDirPath).catch(() => undefined);
        if (!canonicalGitDir) return { ok: false, reason: "workspace git directory could not be canonicalized" };
        boundary = current;
      }
    }
    const parent = dirname(current);
    if (parent === current) return { ok: true, cwd: canonicalCwd, boundary: boundary ?? canonicalCwd };
    current = parent;
  }
}

export async function resolveStrictExecutable(
  name: string,
  cwd: string,
  boundary: string,
  dependencies: ExecutableIdentityDependencies = {},
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (!/^[A-Za-z0-9._+-]{1,128}$/.test(name) || name.includes("/") || name.includes("\\")) {
    return { ok: false, reason: `executable identity is not a bare reviewed name: ${name || "(empty)"}` };
  }
  const env = dependencies.env ?? process.env;
  const pathValue = env.PATH;
  if (!pathValue) return { ok: false, reason: `PATH is unavailable while resolving ${name}` };
  const entries = pathValue.split(delimiter);
  if (entries.some((entry) => !entry || !isAbsolute(entry))) {
    return { ok: false, reason: `PATH contains an empty or relative entry while resolving ${name}` };
  }
  const fsAccess = dependencies.access ?? access;
  const fsRealpath = dependencies.realpath ?? realpath;
  for (const entry of entries) {
    const candidate = resolve(entry, name);
    try { await fsAccess(candidate, constants.X_OK); }
    catch { continue; }
    if (contained(boundary, candidate)) return { ok: false, reason: `${name} resolves through the current workspace` };
    const canonical = await fsRealpath(candidate).catch(() => undefined);
    if (!canonical) return { ok: false, reason: `${name} could not be canonicalized` };
    if (contained(boundary, canonical)) return { ok: false, reason: `${name} resolves inside the current workspace` };
    return { ok: true, path: canonical };
  }
  return { ok: false, reason: `${name} could not be resolved to an executable` };
}

function cdpathApplies(requirement: ExecutableIdentityRequirement, env: NodeJS.ProcessEnv) {
  if (requirement.name !== "cd" || !env.CDPATH) return false;
  const operand = requirement.argv[0];
  if (!operand || isAbsolute(operand) || operand === "." || operand === ".." || operand.startsWith("./") || operand.startsWith("../") || operand === "~" || operand.startsWith("~/")) return false;
  return true;
}

/** Additional veto only: it can never make an unknown or mutating analysis safe. */
export async function verifyAutoAllowIdentity(
  analysis: ShellAnalysis,
  cwd: string,
  dependencies: ExecutableIdentityDependencies = {},
): Promise<IdentityVerification> {
  if (!analysis.complete || analysis.effect !== "read-only") return failure("only complete read-only commands can pass executable identity verification");
  const env = dependencies.env ?? process.env;
  const local = analysis.identityRequirements.filter((requirement) => requirement.context.location === "local");
  if (!local.length) return { ok: true };
  const startupVeto = executableEnvironmentVeto(env);
  if (startupVeto) return failure(startupVeto);
  const workspace = await discoverWorkspaceBoundary(cwd, dependencies);
  if (!workspace.ok) return workspace;

  for (const requirement of local) {
    if (requirement.unverifiableReason) return failure(requirement.unverifiableReason);
    if (requirement.rawName.includes("/") || requirement.rawName.includes("\\")) return failure("path-qualified executables require approval");
    const environmentVeto = executableEnvironmentVeto(env, requirement.rawName);
    if (environmentVeto) return failure(environmentVeto);
    if (cdpathApplies(requirement, env)) return failure("CDPATH can redirect the requested cd operand");
    if (requirement.rawName === requirement.name && REVIEWED_BUILTINS.has(requirement.name)) continue;
    const resolved = await resolveStrictExecutable(requirement.rawName, workspace.cwd, workspace.boundary, { ...dependencies, env });
    if (!resolved.ok) return resolved;
  }
  return { ok: true };
}
