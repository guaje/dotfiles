import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Tracked AA artifact deletions under `04-subagents/assets` are maintenance of catalog-owned files:
 * `/catalog sync` applies them itself (chezmoi forget followed by rm -f) rather than printing commands for
 * the operator to paste. Anything outside that single directory is never executed automatically.
 */
export interface AssetCleanupChange { kind: string; targetPath: string }
export interface AssetCleanupRunner { (command: string, args: readonly string[]): Promise<{ code: number; stderr?: string }> }
export interface AssetCleanupResult { forgotten: string[]; removed: string[]; skipped: string[]; warnings: string[] }

const DEFAULT_ASSET_ROOT = path.resolve(import.meta.dirname, "../04-subagents/assets");
const runByDefault: AssetCleanupRunner = (command, args) => new Promise((resolve) => {
  execFile(command, [...args], { windowsHide: true }, (error, _stdout, stderr) => resolve({ code: error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1) : 0, stderr: String(stderr) }));
});

function insideAssetRoot(root: string, targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved !== root && resolved.startsWith(`${root}${path.sep}`);
}

/** Applies only deletion changes confined to the shared benchmark asset directory; skips and reports anything else. */
export async function executeTrackedAssetDeletions(
  changes: readonly AssetCleanupChange[],
  options: { root?: string; run?: AssetCleanupRunner } = {},
): Promise<AssetCleanupResult> {
  const root = path.resolve(options.root ?? DEFAULT_ASSET_ROOT);
  const run = options.run ?? runByDefault;
  const allowed: string[] = [], skipped: string[] = [], warnings: string[] = [];
  for (const change of changes) {
    if (change.kind !== "D") continue;
    if (typeof change.targetPath !== "string" || !insideAssetRoot(root, change.targetPath)) { skipped.push(String(change.targetPath)); continue; }
    allowed.push(path.resolve(change.targetPath));
  }
  const forgotten: string[] = [], removed: string[] = [];
  if (!allowed.length) return { forgotten, removed, skipped, warnings };
  const unique = [...new Set(allowed)];
  const forget = await run("chezmoi", ["forget", ...unique]);
  if (forget.code === 0) forgotten.push(...unique);
  else warnings.push(`chezmoi forget did not complete for ${unique.length} deleted asset path(s); rm -f still ran. ${forget.stderr?.trim() || ""}`.trim());
  const removal = await run("rm", ["-f", ...unique]);
  if (removal.code === 0) removed.push(...unique);
  else warnings.push(`rm -f did not complete for ${unique.length} deleted asset path(s): ${removal.stderr?.trim() || ""}`.trim());
  return { forgotten, removed, skipped, warnings };
}