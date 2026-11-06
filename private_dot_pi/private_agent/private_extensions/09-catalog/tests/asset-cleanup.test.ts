import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTrackedAssetDeletions } from "../asset-cleanup.ts";

test("tracked deletions under the shared asset root run chezmoi forget then rm -f", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-asset-cleanup-"));
  try {
    const target = path.join(root, "models", "drop.json");
    const calls: Array<[string, readonly string[]]> = [];
    const result = await executeTrackedAssetDeletions(
      [{ kind: "D", targetPath: target }, { kind: "M", targetPath: path.join(root, "aa-manifest.json") }],
      { root, run: async (command, args) => { calls.push([command, args]); return { code: 0 }; } },
    );
    assert.deepEqual(calls, [["chezmoi", ["forget", target]], ["rm", ["-f", target]]]);
    assert.deepEqual(result.removed, [target]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.warnings, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a deletion outside the shared asset root is never executed automatically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-asset-cleanup-"));
  try {
    const calls: Array<[string, readonly string[]]> = [];
    const result = await executeTrackedAssetDeletions(
      [{ kind: "D", targetPath: path.resolve(root, "..", "escape.json") }],
      { root, run: async (command, args) => { calls.push([command, args]); return { code: 0 }; } },
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skipped, [path.resolve(root, "..", "escape.json")]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed chezmoi forget still removes the file and reports the warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-asset-cleanup-"));
  try {
    const target = path.join(root, "model.json");
    const commands: string[] = [];
    const result = await executeTrackedAssetDeletions([{ kind: "D", targetPath: target }], {
      root,
      run: async (command) => { commands.push(command); return command === "chezmoi" ? { code: 1, stderr: "not tracked" } : { code: 0 }; },
    });
    assert.deepEqual(commands, ["chezmoi", "rm"]);
    assert.deepEqual(result.removed, [target]);
    assert.match(result.warnings.join("\n"), /chezmoi forget did not complete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});