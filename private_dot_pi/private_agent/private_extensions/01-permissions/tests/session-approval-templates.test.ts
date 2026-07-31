// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/session-approval-templates.test.ts
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSessionApprovalsForTests } from "../session-command-approvals.ts";
import { approvalCandidate } from "../shell/session-approval-candidate.ts";
import { deriveSessionApprovalTemplate } from "../shell/session-approval-templates.ts";
import { inspectBash } from "../shell/policy.ts";

afterEach(() => resetSessionApprovalsForTests());

test("generated fixed-token mutations never reuse a conservative template", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-template-fixed-"));
  try {
    const baseline = await approvalCandidate(inspectBash("git frobnicate ./one.txt"), cwd);
    assert.ok(baseline);
    for (const command of [
      "git destroy ./one.txt",
      "git frobnicate --mode=unsafe ./one.txt",
      "git frobnicate --mode unsafe ./one.txt",
    ]) {
      const candidate = await approvalCandidate(inspectBash(command), cwd);
      assert.notEqual(candidate?.rule.fingerprint, baseline.rule.fingerprint, command);
    }
    const changedPath = await approvalCandidate(inspectBash("git frobnicate ./two.txt"), cwd);
    assert.equal(changedPath?.rule.fingerprint, baseline.rule.fingerprint);
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("audited filesystem templates preserve option and mode boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-template-paths-"));
  try {
    await writeFile(join(cwd, "a.txt"), "a\n");
    await writeFile(join(cwd, "b.txt"), "b\n");
    await writeFile(join(cwd, "c.txt"), "c\n");
    const cases = [
      ["rm a.txt", "rm b.txt", true],
      ["rm a.txt", "rm -rf b.txt", false],
      ["chmod 600 a.txt", "chmod 600 b.txt", true],
      ["chmod 600 a.txt", "chmod 777 b.txt", false],
      ["cp a.txt b.txt", "cp c.txt b.txt", true],
      ["cp a.txt b.txt", "cp b.txt a.txt", false],
      ["cp a.txt b.txt", "cp a.txt b.txt c.txt", false],
      ["cp a.txt b.txt", "mv a.txt b.txt", false],
    ] as const;
    for (const [left, right, matches] of cases) {
      const first = await approvalCandidate(inspectBash(left), cwd);
      const second = await approvalCandidate(inspectBash(right), cwd);
      assert.equal(first?.rule.fingerprint === second?.rule.fingerprint, matches, `${left} ↔ ${right}`);
    }
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("chezmoi add has an audited workspace-only signature and other mutations are ineligible", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-template-chezmoi-"));
  try {
    await writeFile(join(cwd, "one.txt"), "one\n");
    await writeFile(join(cwd, "two.txt"), "two\n");
    const derive = async (source: string) => {
      const root = inspectBash(source).graph.root;
      assert.equal(root.kind, "command");
      return deriveSessionApprovalTemplate({ command: root, cwd: await realpath(cwd), transport: "local", executableIdentity: "/synthetic/chezmoi" });
    };
    const first = await derive("chezmoi add one.txt");
    const second = await derive("chezmoi add two.txt");
    assert.equal(first?.strength, "audited");
    assert.deepEqual(first?.fingerprintParts, second?.fingerprintParts);
    assert.equal(await derive("chezmoi add ../outside"), undefined);
    assert.equal(await derive("chezmoi apply"), undefined);
    assert.equal(await derive("chezmoi remove one.txt"), undefined);
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});

test("effect and context are fingerprint boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "approval-template-context-"));
  try {
    const inspection = inspectBash("git frobnicate ./file.txt");
    const local = await approvalCandidate(inspection, cwd);
    const changedEffect = {
      ...inspection,
      analysis: {
        ...inspection.analysis,
        executionUnits: inspection.analysis.executionUnits.map((unit) => ({ ...unit, effect: unit.effect === "unknown" ? "mutating" as const : "unknown" as const })),
      },
    };
    const mutating = await approvalCandidate(changedEffect, cwd);
    const handoff = await approvalCandidate(
      inspectBash("git frobnicate ./file.txt", { location: "remote", transport: "handoff", target: "host:/repo", usesNetwork: true }),
      cwd,
      "host\0/repo",
    );
    assert.notEqual(local?.rule.fingerprint, mutating?.rule.fingerprint);
    assert.notEqual(local?.rule.fingerprint, handoff?.rule.fingerprint);
  }
  finally { await rm(cwd, { recursive: true, force: true }); }
});
