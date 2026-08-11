// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/session-approval-candidate.test.ts
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resetSessionApprovalsForTests } from "../session-command-approvals.ts";
import { approvalCandidate } from "../shell/session-approval-candidate.ts";
import { inspectBash } from "../shell/policy.ts";

const execFile = promisify(execFileCallback);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

afterEach(() => resetSessionApprovalsForTests());

test("audited Git rules vary paths and messages but fix operations and options", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-git-"));
  try {
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    await mkdir(repo);
    await mkdir(outside);
    await execFile("git", ["init", "-q", repo]);
    const first = await approvalCandidate(inspectBash("git add file1.txt"), repo);
    const second = await approvalCandidate(inspectBash("git add file2.md"), repo);
    const withCwd = await approvalCandidate(inspectBash(`git -C ${quote(repo)} add file3.ts`), root);
    assert.equal(first?.rule.kind, "similar");
    assert.equal(first?.rule.strength, "audited");
    assert.equal(first?.rule.fingerprint, second?.rule.fingerprint);
    assert.equal(first?.rule.fingerprint, withCwd?.rule.fingerprint);
    assert.equal(first?.rememberLabel, "Allow similar commands for this session");

    const commitOne = await approvalCandidate(inspectBash(`git -C ${quote(repo)} commit -m one`), root);
    const commitTwo = await approvalCandidate(inspectBash(`git -C ${quote(repo)} commit -m two`), root);
    const amend = await approvalCandidate(inspectBash(`git -C ${quote(repo)} commit --amend -m two`), root);
    assert.equal(commitOne?.rule.strength, "audited");
    assert.equal(commitOne?.rule.fingerprint, commitTwo?.rule.fingerprint);
    assert.notEqual(commitOne?.rule.fingerprint, amend?.rule.fingerprint);
    assert.notEqual(first?.rule.fingerprint, commitOne?.rule.fingerprint);

    assert.equal(await approvalCandidate(inspectBash("git add ../outside/file.txt"), repo), undefined);
    await symlink(outside, join(repo, "escape"));
    assert.equal(await approvalCandidate(inspectBash("git add escape/file.txt"), repo), undefined);
    assert.equal(await approvalCandidate(inspectBash(`git --no-pager -C ${quote(repo)} add file.txt`), root), undefined);
    assert.equal(await approvalCandidate(inspectBash(`git -C ${quote(join(repo, ".git"))} add file.txt`), root), undefined);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("audited npx test rules vary contained test paths only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-npx-tests-"));
  try {
    await mkdir(join(cwd, "tests"));
    await writeFile(join(cwd, "tests", "one.test.ts"), "export {};\n");
    await writeFile(join(cwd, "tests", "two.test.ts"), "export {};\n");
    const explicit = await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=1 tests/one.test.ts tests/two.test.ts"), cwd);
    const glob = await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=1 tests/*.test.ts"), cwd);
    const differentConcurrency = await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=2 tests/*.test.ts"), cwd);
    assert.equal(explicit?.rule.kind, "similar");
    assert.equal(explicit?.rule.strength, "audited");
    assert.equal(explicit?.rule.fingerprint, glob?.rule.fingerprint);
    assert.notEqual(explicit?.rule.fingerprint, differentConcurrency?.rule.fingerprint);
    assert.equal(await approvalCandidate(inspectBash("npx -y eslint ."), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=1 ../outside.test.ts"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=1 tests/not-a-test.ts"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=1 tests/**/*.test.ts"), cwd), undefined);
    const outside = await mkdtemp(join(tmpdir(), "approval-npx-outside-"));
    try {
      await writeFile(join(outside, "escape.test.ts"), "export {};\n");
      await symlink(join(outside, "escape.test.ts"), join(cwd, "tests", "escape.test.ts"));
      assert.equal(await approvalCandidate(inspectBash("npx -y tsx --test --test-concurrency=1 tests/*.test.ts"), cwd), undefined);
    }
    finally { await rm(outside, { recursive: true, force: true }); }
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("audited filesystem rules vary contained paths but fix semantic options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-paths-"));
  try {
    await writeFile(join(cwd, "one.txt"), "one\n");
    await writeFile(join(cwd, "two.txt"), "two\n");
    const rmOne = await approvalCandidate(inspectBash("rm one.txt"), cwd);
    const rmTwo = await approvalCandidate(inspectBash("rm two.txt"), cwd);
    const recursive = await approvalCandidate(inspectBash("rm -rf one.txt"), cwd);
    assert.equal(rmOne?.rule.strength, "audited");
    assert.equal(rmOne?.rule.fingerprint, rmTwo?.rule.fingerprint);
    assert.notEqual(rmOne?.rule.fingerprint, recursive?.rule.fingerprint);

    const touchOne = await approvalCandidate(inspectBash("touch new-one"), cwd);
    const touchTwo = await approvalCandidate(inspectBash("touch new-two"), cwd);
    assert.equal(touchOne?.rule.fingerprint, touchTwo?.rule.fingerprint);
    assert.equal((await approvalCandidate(inspectBash("chmod 600 one.txt"), cwd))?.rule.strength, "audited");
    assert.equal(await approvalCandidate(inspectBash("rm ../outside"), cwd), undefined);
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("conservative rules vary only high-confidence paths and fix operations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-conservative-"));
  try {
    const plain = await approvalCandidate(inspectBash("git frobnicate task.js"), cwd);
    const quoted = await approvalCandidate(inspectBash("git frobnicate \"task.js\""), cwd);
    const changedPath = await approvalCandidate(inspectBash("git frobnicate other.js"), cwd);
    const changedOperation = await approvalCandidate(inspectBash("git destroy task.js"), cwd);
    assert.equal(plain?.rule.kind, "similar");
    assert.equal(plain?.rule.strength, "conservative");
    assert.equal(plain?.rule.fingerprint, quoted?.rule.fingerprint);
    assert.equal(plain?.rule.fingerprint, changedPath?.rule.fingerprint);
    assert.notEqual(plain?.rule.fingerprint, changedOperation?.rule.fingerprint);
    assert.equal(plain?.rememberLabel, "Allow similar commands for this session");

    assert.equal(await approvalCandidate(inspectBash(`${quote(process.execPath)} task.js`), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("eval 'rm x'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("cat <<EOF\nbody\nEOF"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("echo $(rm file)"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("cat file | tee out"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("(rm file)"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("rm file > log"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("sudo rm file"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("bash script.sh"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("sed -i '1e rm file' file"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("find . -exec rm '{}' ';'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("rm -I file"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh host \"find . -exec rm '{}' ';'\""), cwd), undefined);
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("relative PATH, workspace executables, and path-qualified aliases cannot create remembered rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-relative-path-"));
  const originalPath = process.env.PATH;
  try {
    await mkdir(join(cwd, "bin-a"));
    const executable = join(cwd, "bin-a", "workspace-tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);

    process.env.PATH = "bin-a";
    assert.equal(await approvalCandidate(inspectBash("workspace-tool --mode=fixed"), cwd), undefined);
    process.env.PATH = join(cwd, "bin-a");
    assert.equal(await approvalCandidate(inspectBash("workspace-tool --mode=fixed"), cwd), undefined);

    await symlink(executable, join(cwd, "alias-a"));
    assert.equal(await approvalCandidate(inspectBash("./alias-a --mode=fixed"), cwd), undefined);
  }
  finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remembered rules use the supplied execution PATH and reject startup/function overrides", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-execution-env-cwd-"));
  const bin = await mkdtemp(join(tmpdir(), "approval-execution-env-bin-"));
  try {
    const executable = join(bin, "fixture-tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    const inspection = inspectBash("fixture-tool --mode=fixed");
    assert.ok(await approvalCandidate(inspection, cwd, undefined, { PATH: bin }));
    assert.equal(await approvalCandidate(inspection, cwd, undefined, { PATH: bin, BASH_ENV: "fixture" }), undefined);
    assert.equal(await approvalCandidate(inspection, cwd, undefined, { PATH: bin, "BASH_FUNC_fixture-tool%%": "() { :; }" }), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  }
});

test("local, Handoff, and SSH similar rules remain isolated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-context-"));
  try {
    const local = await approvalCandidate(inspectBash("git frobnicate task.js"), cwd);
    const handoff = await approvalCandidate(
      inspectBash("git frobnicate task.js", { location: "remote", transport: "handoff", target: "host:/repo", usesNetwork: true }),
      cwd,
      ["host", "user", "22", "/repo"].join("\0"),
    );
    const otherHandoff = await approvalCandidate(
      inspectBash("git frobnicate task.js", { location: "remote", transport: "handoff", target: "host:/other", usesNetwork: true }),
      cwd,
      ["host", "user", "22", "/other"].join("\0"),
    );
    const ssh = await approvalCandidate(inspectBash("ssh -p 22 host 'rm x'"), cwd);
    const changedSsh = await approvalCandidate(inspectBash("ssh -p 23 host 'rm x'"), cwd);
    assert.equal(handoff?.rule.strength, "conservative");
    assert.equal(ssh?.rule.strength, "conservative");
    assert.notEqual(local?.rule.fingerprint, handoff?.rule.fingerprint);
    assert.notEqual(handoff?.rule.fingerprint, otherHandoff?.rule.fingerprint);
    assert.notEqual(ssh?.rule.fingerprint, changedSsh?.rule.fingerprint);
    assert.equal(await approvalCandidate(inspectBash("ssh host"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh host 'bash script.sh'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh -t host 'rm file'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh -tt host 'rm file'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh -o RequestTTY=force host 'rm file'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh -oRequestTTY=yes host 'rm file'"), cwd), undefined);
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});
