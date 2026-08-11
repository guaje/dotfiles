import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { discoverWorkspaceBoundary, verifyAutoAllowIdentity } from "../shell/executable-identity.ts";
import { parseShell } from "../shell/parser.ts";

async function executable(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o700);
}

test("filesystem-only workspace discovery handles repositories, worktrees, and no-repo roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-identity-boundary-"));
  try {
    const repo = join(root, "repo");
    const nested = join(repo, "src", "nested");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(join(repo, "src", ".git"));
    assert.deepEqual(await discoverWorkspaceBoundary(nested), { ok: true, cwd: await realpath(nested), boundary: await realpath(repo) });

    const worktree = join(root, "worktree");
    const gitdir = join(root, "git-data");
    await mkdir(worktree);
    await mkdir(gitdir);
    await writeFile(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    assert.deepEqual(await discoverWorkspaceBoundary(worktree), { ok: true, cwd: await realpath(worktree), boundary: await realpath(worktree) });

    const plain = join(root, "plain");
    await mkdir(plain);
    assert.deepEqual(await discoverWorkspaceBoundary(plain), { ok: true, cwd: await realpath(plain), boundary: await realpath(plain) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace discovery fails closed on malformed and symlinked markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-identity-markers-"));
  try {
    const malformed = join(root, "malformed");
    await mkdir(malformed);
    await writeFile(join(malformed, ".git"), "not-a-gitdir\n");
    assert.deepEqual(await discoverWorkspaceBoundary(malformed), { ok: false, reason: "workspace marker file is malformed" });

    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target);
    await mkdir(linked);
    await symlink(target, join(linked, ".git"));
    assert.deepEqual(await discoverWorkspaceBoundary(linked), { ok: false, reason: "workspace marker symlinks are not trusted" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity verification accepts external tools but rejects workspace shadows and unsafe PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-identity-path-"));
  try {
    const repo = join(root, "repo");
    const externalBin = join(root, "trusted-bin");
    const workspaceBin = join(repo, "bin");
    await mkdir(join(repo, ".git"), { recursive: true });
    await executable(join(externalBin, "nl"));
    await executable(join(workspaceBin, "nl"));
    const analysis = parseShell("nl -ba file.txt");

    assert.deepEqual(await verifyAutoAllowIdentity(analysis, repo, { env: { PATH: externalBin } }), { ok: true });
    assert.match((await verifyAutoAllowIdentity(analysis, repo, { env: { PATH: workspaceBin } }) as { reason: string }).reason, /workspace/);
    assert.match((await verifyAutoAllowIdentity(analysis, repo, { env: { PATH: `.${process.platform === "win32" ? ";" : ":"}${externalBin}` } }) as { reason: string }).reason, /empty or relative/);
    assert.match((await verifyAutoAllowIdentity(analysis, repo, { env: { PATH: "" } }) as { reason: string }).reason, /PATH is unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity verification rejects startup injection, exported functions, and unmodeled wrappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-identity-env-"));
  try {
    const bin = join(root, "bin");
    const cwd = join(root, "cwd");
    await mkdir(cwd);
    await executable(join(bin, "nl"));
    await executable(join(bin, "env"));
    const analysis = parseShell("nl file");
    assert.match((await verifyAutoAllowIdentity(analysis, cwd, { env: { PATH: bin, BASH_ENV: "fixture" } }) as { reason: string }).reason, /startup environment/);
    assert.match((await verifyAutoAllowIdentity(analysis, cwd, { env: { PATH: bin, ZDOTDIR: cwd } }) as { reason: string }).reason, /startup environment/);
    assert.match((await verifyAutoAllowIdentity(analysis, cwd, { env: { PATH: bin, "BASH_FUNC_nl%%": "() { :; }" } }) as { reason: string }).reason, /exported shell function/);
    assert.match((await verifyAutoAllowIdentity(parseShell("env -i nl file"), cwd, { env: { PATH: bin } }) as { reason: string }).reason, /env -i/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CDPATH veto applies only to eligible relative cd operands", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-identity-cd-"));
  try {
    const env = { PATH: join(root, "bin"), CDPATH: join(root, "elsewhere") };
    assert.match((await verifyAutoAllowIdentity(parseShell("cd child"), root, { env }) as { reason: string }).reason, /CDPATH/);
    assert.deepEqual(await verifyAutoAllowIdentity(parseShell("cd ./child"), root, { env }), { ok: true });
    assert.deepEqual(await verifyAutoAllowIdentity(parseShell(`cd ${join(root, "child")}`), root, { env }), { ok: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity requirements include nested commands and reviewed wrappers", async () => {
  const nested = parseShell("command nl file | timeout 1 cat $(pwd)");
  const requirements = nested.identityRequirements.map((item) => `${item.role}:${item.name}`);
  assert.ok(requirements.includes("wrapper:command"));
  assert.ok(requirements.includes("command:nl"));
  assert.ok(requirements.includes("wrapper:timeout"));
  assert.ok(requirements.includes("command:cat"));
  assert.ok(requirements.includes("command:pwd"));
});
