import { execFile as execFileCallback } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const WORKTREE_TTL_MS = 30_000;
const MAX_WORKTREE_CACHES = 32;
type WorktreeCache = { expires: number; roots: string[] };
const worktreeCache = new Map<string, WorktreeCache>();
let disposableRoot: string | undefined;

export function contained(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function canonicalExistingOrParent(path: string) {
  let candidate = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await realpath(candidate);
      return resolve(real, ...suffix.reverse());
    }
    catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error("path has no existing parent");
      suffix.push(candidate.slice(parent.length).replace(/^[/\\]+/, ""));
      candidate = parent;
    }
  }
}

async function ownedPrivateTemp() {
  if (disposableRoot) return disposableRoot;
  const uid = process.getuid?.();
  const base = resolve(tmpdir(), `pi-permissions-${uid ?? "user"}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await stat(base);
  if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error("Pi temporary directory is not private");
  }
  disposableRoot = await realpath(base);
  return disposableRoot;
}

async function discoverWorktrees(cwd: string): Promise<string[]> {
  const { stdout } = await execFile(
    "git",
    ["-C", cwd, "--no-optional-locks", "worktree", "list", "--porcelain", "-z"],
    { timeout: 3_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
  );
  const paths = String(stdout).split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  const uid = process.getuid?.();
  const roots: string[] = [];
  for (const path of paths) {
    const root = await realpath(path).catch(() => undefined);
    if (!root) continue;
    const info = await stat(root).catch(() => undefined);
    if (!info || (uid !== undefined && info.uid !== uid)) continue;
    roots.push(root);
  }
  return [...new Set(roots)];
}

async function worktrees(cwd: string) {
  const canonical = await realpath(cwd);
  const cached = worktreeCache.get(canonical);
  if (cached && cached.expires > Date.now()) return cached.roots;
  const roots = await discoverWorktrees(canonical).catch(() => []);
  if (worktreeCache.size >= MAX_WORKTREE_CACHES) worktreeCache.delete(worktreeCache.keys().next().value!);
  worktreeCache.set(canonical, { expires: Date.now() + WORKTREE_TTL_MS, roots });
  return roots;
}

async function configuredRoots(roots: string[] | undefined) {
  const result: string[] = [];
  for (const root of roots ?? ["@user-temp"]) {
    if (root === "@user-temp") result.push(await ownedPrivateTemp());
    else if (isAbsolute(root) || root.startsWith("~/")) {
      const expanded = root.startsWith("~/") ? resolve(homedir(), root.slice(2)) : root;
      const canonical = await realpath(expanded).catch(() => undefined);
      if (canonical) result.push(canonical);
    }
  }
  return [...new Set(result)];
}

/** Resolves existing targets and new targets through their nearest real parent. */
export async function canAutoAllowLocalFile(path: string | undefined, cwd: string | undefined, disposableRoots?: string[]) {
  if (!path || !cwd) return false;
  const base = await realpath(cwd).catch(() => undefined);
  if (!base) return false;
  const target = await canonicalExistingOrParent(resolve(base, path)).catch(() => undefined);
  if (!target) return false;
  const roots = [base, ...await worktrees(base), ...await configuredRoots(disposableRoots)];
  return roots.some((root) => contained(root, target));
}

/** Handoff's local boundary is trusted only for its existing bounded workspace mapping. */
export async function canAutoAllowHandoffFile(path: string | undefined, cwd: string | undefined, boundary: string | undefined) {
  if (!path || !cwd || !boundary) return false;
  const base = await realpath(cwd).catch(() => undefined);
  const mapped = await realpath(boundary).catch(() => undefined);
  if (!base || !mapped || base !== mapped) return false;
  const target = await canonicalExistingOrParent(resolve(base, path)).catch(() => undefined);
  return Boolean(target && contained(base, target));
}

export async function canonicalGitWorktree(cwd: string) {
  const canonicalCwd = await realpath(cwd).catch(() => undefined);
  if (!canonicalCwd) return undefined;
  const { stdout } = await execFile("git", ["-C", canonicalCwd, "--no-optional-locks", "rev-parse", "--show-toplevel"], { timeout: 3_000, maxBuffer: 1024 * 1024, encoding: "utf8" }).catch(() => ({ stdout: "" }));
  const worktree = await realpath(String(stdout).trim()).catch(() => undefined);
  return worktree ? { cwd: canonicalCwd, worktree } : undefined;
}

export function invalidateAccessPolicyCache() {
  worktreeCache.clear();
  disposableRoot = undefined;
}
