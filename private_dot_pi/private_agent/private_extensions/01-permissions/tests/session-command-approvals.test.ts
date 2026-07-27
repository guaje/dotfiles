// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/session-command-approvals.test.ts
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  approvalFingerprint,
  bindSessionApprovalsToStyle,
  clearSessionApprovals,
  findSessionApproval,
  listSessionApprovals,
  rememberSessionApproval,
  resetSessionApprovalsForTests,
  revokeSessionApproval,
  withPendingApproval,
} from "../session-command-approvals.ts";

afterEach(() => resetSessionApprovalsForTests());

test("session rules are capped, revocable, and contain safe metadata only", () => {
  const identity = approvalFingerprint("exact", "local", "/workspace", "rm", "private.txt");
  const first = { ...identity, kind: "exact" as const, label: "rm · exact · 1 argument · local" };
  assert.equal(rememberSessionApproval(first, 1), true);
  const secondIdentity = approvalFingerprint("exact", "second");
  assert.equal(rememberSessionApproval({ ...secondIdentity, kind: "exact", label: "second · exact · local" }, 1), false);
  assert.ok(findSessionApproval(identity));
  const listed = listSessionApprovals();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.label, first.label);
  assert.doesNotMatch(JSON.stringify(listed), /private\.txt|\/workspace|rm private/);
  assert.equal(revokeSessionApproval(listed[0]!.id), true);
  assert.deepEqual(listSessionApprovals(), []);
});

test("clearing rotates the session identity and rejects stale rules", () => {
  const before = approvalFingerprint("stable");
  const rule = { ...before, kind: "exact" as const, label: "command · exact · local" };
  assert.equal(rememberSessionApproval(rule, 2), true);
  clearSessionApprovals();
  const after = approvalFingerprint("stable");
  assert.notEqual(after.epoch, before.epoch);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(findSessionApproval(before), undefined);
  assert.equal(rememberSessionApproval(rule, 2), false);
});

test("management-style binding preserves reloads only while the style is unchanged", () => {
  bindSessionApprovalsToStyle("Empowerment");
  const identity = approvalFingerprint("style-bound");
  rememberSessionApproval({ ...identity, kind: "exact", label: "fixture" }, 2);
  bindSessionApprovalsToStyle("Empowerment");
  assert.ok(findSessionApproval(identity));
  bindSessionApprovalsToStyle("Micromanagement");
  assert.equal(findSessionApproval(identity), undefined);
});

test("a schema mismatch replaces the reload-safe store", () => {
  const root = globalThis as typeof globalThis & { [key: symbol]: unknown };
  root[Symbol.for("pi.permissions.session-command-approvals")] = { schema: 0, epoch: "stale", key: "stale", rules: new Map([["raw", { label: "stale" }]]), pending: new Map() };
  const identity = approvalFingerprint("fresh");
  assert.notEqual(identity.epoch, "stale");
  assert.deepEqual(listSessionApprovals(), []);
});

test("identical concurrent approval flows are serialized without sharing one-time consent", async () => {
  const identity = approvalFingerprint("flow", "same request");
  let active = 0;
  let maximumActive = 0;
  let prompts = 0;
  const request = async (result: "once" | "deny") => withPendingApproval(identity.fingerprint, async () => {
    prompts++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return result;
  });
  const [first, second] = await Promise.all([request("once"), request("deny")]);
  assert.deepEqual([first, second], ["once", "deny"]);
  assert.equal(prompts, 2);
  assert.equal(maximumActive, 1);
});
