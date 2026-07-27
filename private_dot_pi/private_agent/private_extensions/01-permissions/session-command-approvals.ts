import { createHmac, randomBytes, randomUUID } from "node:crypto";

const STORE_KEY = Symbol.for("pi.permissions.session-command-approvals");
const SCHEMA_VERSION = 1;

export type SessionApprovalKind = "exact" | "git-add";
export type ApprovalChoice = "deny" | "once" | "remember";

export interface SessionApprovalRuleInput {
  epoch: string;
  fingerprint: string;
  kind: SessionApprovalKind;
  label: string;
}

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

function validStore(value: unknown): value is SessionApprovalStore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionApprovalStore>;
  return candidate.schema === SCHEMA_VERSION
    && typeof candidate.epoch === "string"
    && typeof candidate.key === "string"
    && candidate.rules instanceof Map
    && candidate.pending instanceof Map;
}

function store(): SessionApprovalStore {
  const root = globalThis as StoreRoot;
  if (validStore(root[STORE_KEY])) return root[STORE_KEY];
  const created = newStore();
  root[STORE_KEY] = created;
  return created;
}

/** HMACs compare requests without retaining command material. */
export function approvalFingerprint(...parts: string[]) {
  const current = store();
  const fingerprint = createHmac("sha256", current.key)
    .update(parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join("\0"))
    .digest("base64url");
  return { epoch: current.epoch, fingerprint };
}

export function findSessionApproval(rule: Pick<SessionApprovalRuleInput, "epoch" | "fingerprint">) {
  const current = store();
  if (rule.epoch !== current.epoch) return undefined;
  const found = current.rules.get(rule.fingerprint);
  if (!found) return undefined;
  found.lastUsedAt = Date.now();
  return { ...found };
}

export function rememberSessionApproval(rule: SessionApprovalRuleInput, maxRules: number) {
  const current = store();
  if (rule.epoch !== current.epoch) return false;
  if (current.rules.has(rule.fingerprint)) return true;
  if (!Number.isSafeInteger(maxRules) || maxRules < 1 || current.rules.size >= maxRules) return false;
  const now = Date.now();
  current.rules.set(rule.fingerprint, { ...rule, id: randomUUID(), createdAt: now, lastUsedAt: now });
  return true;
}

export function listSessionApprovals(): SessionApprovalRecord[] {
  return [...store().rules.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((rule) => ({ ...rule }));
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

/**
 * Serializes identical approval flows. The callback runs for every caller after its
 * predecessor finishes, allowing it to re-check a newly remembered rule. A one-time
 * approval or denial is therefore never inherited by a concurrent caller.
 */
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
