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

function rule(identity: ReturnType<typeof approvalFingerprint>, executable = "command") {
  return { ...identity, kind: "similar" as const, strength: "conservative" as const, contextLabel: "local", anchorCount: 1, slotCount: 0, slotTypes: [], label: `${executable} · conservative · no variable slots` };
}

test("session rules are capped, revocable, and contain safe metadata only", () => {
  const identity = approvalFingerprint("exact", "local", "/workspace", "rm", "private.txt");
  const first = rule(identity, "rm");
  assert.deepEqual(rememberSessionApproval(first, 1), { ok: true, status: "remembered" });
  assert.deepEqual(rememberSessionApproval(first, 1), { ok: true, status: "duplicate" });
  const secondIdentity = approvalFingerprint("exact", "second");
  assert.deepEqual(rememberSessionApproval(rule(secondIdentity, "second"), 1), { ok: false, reason: "limit-reached" });
  assert.ok(findSessionApproval(identity));
  const listed = listSessionApprovals();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.label, first.label);
  assert.doesNotMatch(JSON.stringify(listed), /private\.txt|\/workspace|rm private/);
  assert.equal(revokeSessionApproval(listed[0]!.id), true);
  assert.deepEqual(listSessionApprovals(), []);
});

test("remember rejects sensitive metadata and re-HMACs every persisted identity", () => {
  const identity = approvalFingerprint("safe");
  assert.deepEqual(rememberSessionApproval({ ...rule(identity), label: "/private/payload · conservative · no variable slots" }, 2), { ok: false, reason: "invalid-rule" });
  assert.deepEqual(rememberSessionApproval({ ...rule(identity), fingerprint: "raw command text" }, 2), { ok: false, reason: "invalid-rule" });
  assert.deepEqual(rememberSessionApproval({ ...rule(identity), signatureId: "payload-encoded-as-an-id" }, 2), { ok: false, reason: "invalid-rule" });
  const callerValue = "a".repeat(43);
  assert.deepEqual(rememberSessionApproval({ ...rule(identity), fingerprint: callerValue }, 2), { ok: true, status: "remembered" });
  assert.notEqual(listSessionApprovals()[0]?.fingerprint, callerValue);
  assert.doesNotMatch(JSON.stringify(listSessionApprovals()), /private|payload|a{43}/);
});

test("clearing rotates the session identity and rejects stale rules", () => {
  const before = approvalFingerprint("stable");
  const staleRule = rule(before);
  assert.deepEqual(rememberSessionApproval(staleRule, 2), { ok: true, status: "remembered" });
  clearSessionApprovals();
  const after = approvalFingerprint("stable");
  assert.notEqual(after.epoch, before.epoch);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(findSessionApproval(before), undefined);
  assert.deepEqual(rememberSessionApproval(staleRule, 2), { ok: false, reason: "epoch-mismatch" });
});

test("remember reports invalid limit configuration separately from capacity", () => {
  const identity = approvalFingerprint("limit");
  assert.deepEqual(rememberSessionApproval(rule(identity), 0), { ok: false, reason: "invalid-limit" });
  assert.deepEqual(rememberSessionApproval(rule(identity), Number.NaN), { ok: false, reason: "invalid-limit" });
});

test("management-style binding preserves reloads only while the style is unchanged", () => {
  bindSessionApprovalsToStyle("Empowerment");
  const identity = approvalFingerprint("style-bound");
  rememberSessionApproval(rule(identity, "fixture"), 2);
  bindSessionApprovalsToStyle("Empowerment");
  assert.ok(findSessionApproval(identity));
  bindSessionApprovalsToStyle("Micromanagement");
  assert.equal(findSessionApproval(identity), undefined);
});

test("an older schema migrates in place while clearing unsafe state", () => {
  const root = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const key = Symbol.for("pi.permissions.session-command-approvals");
  const legacy = {
    schema: 1,
    epoch: "preserved-epoch",
    key: "preserved-key",
    rules: new Map([["raw", { label: "stale" }]]),
    pending: new Map([["raw", Promise.resolve()]]),
    managingStyle: "Empowerment" as const,
  };
  root[key] = legacy;
  const identity = approvalFingerprint("fresh");
  assert.equal(identity.epoch, legacy.epoch);
  assert.strictEqual(root[key], legacy);
  assert.equal(legacy.schema, 3);
  assert.equal(legacy.key, "preserved-key");
  assert.equal(legacy.managingStyle, "Empowerment");
  assert.deepEqual(listSessionApprovals(), []);
  assert.equal(legacy.pending.size, 0);
});

test("the short-lived schema-2 exact store is invalidated without rotating its session key", () => {
  const root = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const key = Symbol.for("pi.permissions.session-command-approvals");
  const transitional = {
    schema: 2,
    epoch: "schema-two-epoch",
    key: "schema-two-key",
    rules: new Map([["raw", { kind: "exact", label: "stale" }]]),
    pending: new Map(),
    managingStyle: "Empowerment" as const,
  };
  root[key] = transitional;
  assert.equal(approvalFingerprint("fresh").epoch, transitional.epoch);
  assert.strictEqual(root[key], transitional);
  assert.equal(transitional.schema, 3);
  assert.equal(transitional.key, "schema-two-key");
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
