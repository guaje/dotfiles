import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { SessionApprovalSlotType, SessionApprovalTemplateStrength } from "./types.ts";

const STORE_KEY = Symbol.for("pi.permissions.session-command-approvals");
// Schema 3 supersedes the short-lived exact/git-add schema 2 implementation.
const SCHEMA_VERSION = 3;

export type SessionApprovalKind = "similar";
export type ApprovalChoice = "deny" | "once" | "remember";

export interface SessionApprovalRuleInput {
  epoch: string;
  fingerprint: string;
  kind: SessionApprovalKind;
  strength: SessionApprovalTemplateStrength;
  signatureId?: string;
  contextLabel: string;
  anchorCount: number;
  slotCount: number;
  slotTypes: SessionApprovalSlotType[];
  label: string;
}

export type RememberSessionApprovalResult =
  | { ok: true; status: "remembered" | "duplicate" }
  | { ok: false; reason: "epoch-mismatch" | "invalid-rule" | "invalid-limit" | "limit-reached" };

export interface SessionApprovalRecord extends SessionApprovalRuleInput {
  id: string;
  createdAt: number;
  lastUsedAt: number;
}

type SessionApprovalStore = {
  schema: number;
  epoch: string;
  key: string;
  rules: Map<string, SessionApprovalRecord>;
  pending: Map<string, Promise<unknown>>;
  managingStyle?: "Micromanagement" | "Empowerment";
};

type StoreRoot = typeof globalThis & { [key: symbol]: unknown };

function newStore(): SessionApprovalStore {
  return {
    schema: SCHEMA_VERSION,
    epoch: randomUUID(),
    key: randomBytes(32).toString("base64url"),
    rules: new Map(),
    pending: new Map(),
  };
}

const PATH_SIGNATURE_LABELS: Readonly<Record<string, [string, "path group" | "source slot"]>> = {
  "rm-paths-v1": ["rm", "path group"],
  "touch-paths-v1": ["touch", "path group"],
  "mkdir-paths-v1": ["mkdir", "path group"],
  "rmdir-paths-v1": ["rmdir", "path group"],
  "cp-paths-v2": ["cp", "source slot"],
  "mv-paths-v2": ["mv", "source slot"],
  "ln-paths-v1": ["ln", "source slot"],
  "chmod-paths-v1": ["chmod", "path group"],
  "chown-paths-v1": ["chown", "path group"],
  "chgrp-paths-v1": ["chgrp", "path group"],
};

function expectedSafeLabel(rule: SessionApprovalRuleInput) {
  if (rule.strength === "conservative") {
    if (rule.signatureId || !rule.slotTypes.every((slot) => slot === "workspace-path")) return undefined;
    const executable = rule.label.split(" · ", 1)[0] ?? "";
    if (!/^[A-Za-z0-9._+-]{1,48}$/.test(executable)) return undefined;
    return `${executable} · conservative · ${rule.slotCount ? `${rule.slotCount} variable path slot${rule.slotCount === 1 ? "" : "s"}` : "no variable slots"}`;
  }
  if (rule.signatureId === "git-add-workspace-v2") return "git add <workspace paths> · audited · 1 variable group";
  if (rule.signatureId === "git-commit-message-v2") return `git commit · audited · ${rule.slotCount} variable slot${rule.slotCount === 1 ? "" : "s"}`;
  if (rule.signatureId === "npx-tsx-test-v2") return "npx tsx tests · audited · 1 variable group";
  if (rule.signatureId === "chezmoi-add-workspace-v1") return "chezmoi add · audited · 1 variable path group";
  const path = rule.signatureId ? PATH_SIGNATURE_LABELS[rule.signatureId] : undefined;
  return path ? `${path[0]} · audited · 1 variable ${path[1]}` : undefined;
}

function validRuleInput(rule: SessionApprovalRuleInput) {
  const expectedLabel = expectedSafeLabel(rule);
  return rule.kind === "similar"
    && (rule.strength === "audited" || rule.strength === "conservative")
    && /^[A-Za-z0-9_-]{1,64}$/.test(rule.epoch)
    && /^[A-Za-z0-9_-]{43}$/.test(rule.fingerprint)
    && (rule.contextLabel === "local" || rule.contextLabel === "Handoff" || rule.contextLabel === "SSH")
    && Number.isSafeInteger(rule.anchorCount) && rule.anchorCount >= 0 && rule.anchorCount <= 256
    && Number.isSafeInteger(rule.slotCount) && rule.slotCount >= 0 && rule.slotCount <= 64
    && Array.isArray(rule.slotTypes)
    && rule.slotCount === rule.slotTypes.length
    && rule.slotTypes.every((slot) => slot === "workspace-path" || slot === "workspace-path-list" || slot === "opaque")
    && rule.label === expectedLabel;
}

function validRule(value: unknown): value is SessionApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<SessionApprovalRecord>;
  return typeof rule.id === "string"
    && typeof rule.createdAt === "number"
    && typeof rule.lastUsedAt === "number"
    && validRuleInput(rule as SessionApprovalRuleInput);
}

function validStore(value: unknown): value is SessionApprovalStore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionApprovalStore>;
  return candidate.schema === SCHEMA_VERSION
    && typeof candidate.epoch === "string"
    && typeof candidate.key === "string"
    && candidate.rules instanceof Map
    && [...candidate.rules.values()].every(validRule)
    && candidate.pending instanceof Map;
}

/** Preserve session identity/style while invalidating incompatible pre-template rules. */
function migrateStore(value: unknown): SessionApprovalStore | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SessionApprovalStore>;
  if (!Number.isSafeInteger(candidate.schema)
    || candidate.schema! >= SCHEMA_VERSION
    || typeof candidate.epoch !== "string"
    || typeof candidate.key !== "string") return undefined;
  const migrated = candidate as SessionApprovalStore;
  migrated.schema = SCHEMA_VERSION;
  migrated.rules = new Map();
  migrated.pending = new Map();
  return migrated;
}

function store(): SessionApprovalStore {
  const root = globalThis as StoreRoot;
  const existing = root[STORE_KEY];
  if (validStore(existing)) return existing;
  const migrated = migrateStore(existing);
  if (migrated) {
    root[STORE_KEY] = migrated;
    return migrated;
  }
  const created = newStore();
  root[STORE_KEY] = created;
  return created;
}

function hmac(key: string, value: string) {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function storedFingerprint(current: SessionApprovalStore, candidateFingerprint: string) {
  return hmac(current.key, `stored-session-approval\0${candidateFingerprint}`);
}

/** HMACs compare templates without retaining command material. */
export function approvalFingerprint(...parts: string[]) {
  const current = store();
  const fingerprint = hmac(current.key, parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join("\0"));
  return { epoch: current.epoch, fingerprint };
}

export function findSessionApproval(rule: Pick<SessionApprovalRuleInput, "epoch" | "fingerprint">) {
  const current = store();
  if (rule.epoch !== current.epoch) return undefined;
  const found = current.rules.get(storedFingerprint(current, rule.fingerprint));
  if (!found) return undefined;
  found.lastUsedAt = Date.now();
  return { ...found, slotTypes: [...found.slotTypes] };
}

export function rememberSessionApproval(rule: SessionApprovalRuleInput, maxRules: number): RememberSessionApprovalResult {
  const current = store();
  if (rule.epoch !== current.epoch) return { ok: false, reason: "epoch-mismatch" };
  if (!validRuleInput(rule)) return { ok: false, reason: "invalid-rule" };
  const fingerprint = storedFingerprint(current, rule.fingerprint);
  if (current.rules.has(fingerprint)) return { ok: true, status: "duplicate" };
  if (!Number.isSafeInteger(maxRules) || maxRules < 1) return { ok: false, reason: "invalid-limit" };
  if (current.rules.size >= maxRules) return { ok: false, reason: "limit-reached" };
  const now = Date.now();
  current.rules.set(fingerprint, { ...rule, fingerprint, slotTypes: [...rule.slotTypes], id: randomUUID(), createdAt: now, lastUsedAt: now });
  return { ok: true, status: "remembered" };
}

export function listSessionApprovals(): SessionApprovalRecord[] {
  return [...store().rules.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((rule) => ({ ...rule, slotTypes: [...rule.slotTypes] }));
}

export function bindSessionApprovalsToStyle(style: "Micromanagement" | "Empowerment") {
  const current = store();
  if (current.managingStyle === style && !(style === "Micromanagement" && current.rules.size)) return;
  if (current.managingStyle === undefined && style === "Empowerment") {
    current.managingStyle = style;
    return;
  }
  clearSessionApprovals();
  store().managingStyle = style;
}

export function revokeSessionApproval(id: string) {
  const current = store();
  for (const [fingerprint, rule] of current.rules) {
    if (rule.id === id) return current.rules.delete(fingerprint);
  }
  return false;
}

/** Clears rules and rotates the session HMAC identity. Reload callers deliberately skip this. */
export function clearSessionApprovals() {
  (globalThis as StoreRoot)[STORE_KEY] = newStore();
}

/** Serialize identical prompts without sharing one-time consent between callers. */
export async function withPendingApproval<T>(fingerprint: string, request: () => Promise<T>): Promise<T> {
  const current = store();
  const previous = current.pending.get(fingerprint) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(request);
  current.pending.set(fingerprint, pending);
  try {
    return await pending;
  }
  finally {
    if (current.pending.get(fingerprint) === pending) current.pending.delete(fingerprint);
  }
}

export function resetSessionApprovalsForTests() {
  delete (globalThis as StoreRoot)[STORE_KEY];
}
