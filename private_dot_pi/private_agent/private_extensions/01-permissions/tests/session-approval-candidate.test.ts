// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/session-approval-candidate.test.ts
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { resetSessionApprovalsForTests } from "../session-command-approvals.ts";
import { approvalCandidate } from "../shell/session-approval-candidate.ts";
import { inspectBash } from "../shell/policy.ts";

const execFile = promisify(execFileCallback);
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

afterEach(() => resetSessionApprovalsForTests());

test("literal workspace-contained git add commands share one semantic rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-git-"));
  try {
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    await mkdir(repo);
    await mkdir(outside);
    await execFile("git", ["init", "-q", repo]);
    const first = await approvalCandidate(inspectBash("git add file1.txt"), repo);
    const second = await approvalCandidate(inspectBash("git add file2.md"), repo);
    assert.equal(first?.rule.kind, "git-add");
    assert.equal(first?.rule.fingerprint, second?.rule.fingerprint);
    assert.equal(first?.rememberLabel, "Allow similar commands for this session");
    assert.match(first?.ruleDescription ?? "", /paths inside this workspace/);

    assert.equal(await approvalCandidate(inspectBash("git add ../outside/file.txt"), repo), undefined);
    await symlink(outside, join(repo, "escape"));
    assert.equal(await approvalCandidate(inspectBash("git add escape/file.txt"), repo), undefined);

    assert.equal((await approvalCandidate(inspectBash("git add --all"), repo))?.rule.kind, "exact");
    assert.equal((await approvalCandidate(inspectBash("git add '*.txt'"), repo))?.rule.kind, "exact");
    assert.equal(await approvalCandidate(inspectBash("git add --patch file.txt"), repo), undefined);
  }
  finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete literal unknown commands receive normalized exact rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-exact-"));
  const executable = quote(process.execPath);
  try {
    const plain = await approvalCandidate(inspectBash(`${executable} task.js`), cwd);
    const quoted = await approvalCandidate(inspectBash(`${executable} "task.js"`), cwd);
    const changed = await approvalCandidate(inspectBash(`${executable} other.js`), cwd);
    assert.equal(plain?.rule.kind, "exact");
    assert.equal(plain?.rule.fingerprint, quoted?.rule.fingerprint);
    assert.notEqual(plain?.rule.fingerprint, changed?.rule.fingerprint);
    assert.match(plain?.rule.label ?? "", new RegExp(basename(process.execPath)));
    assert.equal(await approvalCandidate(inspectBash("eval 'rm x'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("cat <<EOF\nbody\nEOF"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("echo $(rm file)"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("cat file | tee out"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("(rm file)"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("rm file > log"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("sudo rm file"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("env -i rm file"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("command rm file"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("bash -c 'rm file'"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("rm *.txt"), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("rm ~/file"), cwd), undefined);
    assert.equal((await approvalCandidate(inspectBash("rm '*.txt'"), cwd))?.rule.kind, "exact");
  }
  finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("local, Handoff, and SSH exact rules are isolated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-context-"));
  const executable = quote(process.execPath);
  try {
    const local = await approvalCandidate(inspectBash(`${executable} task.js`), cwd);
    const handoff = await approvalCandidate(
      inspectBash("node task.js", { location: "remote", transport: "handoff", target: "host:/repo", usesNetwork: true }),
      cwd,
      ["host", "user", "22", "/repo"].join("\0"),
    );
    const otherHandoff = await approvalCandidate(
      inspectBash("node task.js", { location: "remote", transport: "handoff", target: "host:/other", usesNetwork: true }),
      cwd,
      ["host", "user", "22", "/other"].join("\0"),
    );
    const ssh = await approvalCandidate(inspectBash("ssh -p 22 host 'rm x'"), cwd);
    const changedSsh = await approvalCandidate(inspectBash("ssh -p 23 host 'rm x'"), cwd);
    assert.equal(handoff?.rule.kind, "exact");
    assert.equal(ssh?.rule.kind, "exact");
    assert.notEqual(local?.rule.fingerprint, handoff?.rule.fingerprint);
    assert.notEqual(handoff?.rule.fingerprint, otherHandoff?.rule.fingerprint);
    assert.notEqual(ssh?.rule.fingerprint, changedSsh?.rule.fingerprint);
    assert.equal(await approvalCandidate(inspectBash("ssh host", { location: "local", usesNetwork: false }), cwd), undefined);
    assert.equal(await approvalCandidate(inspectBash("ssh host 'bash -c rm'", { location: "local", usesNetwork: false }), cwd), undefined);
    assert.equal(await approvalCandidate(
      inspectBash("node task.js", { location: "remote", transport: "handoff", target: "host:/repo", usesNetwork: true }),
      cwd,
      undefined,
    ), undefined);
  }
  finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
