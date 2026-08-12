import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Narrow Handoff-owned route capability consumed by Permissions. */
export interface RemoteRoute {
  backend: BashOperations;
  label: string;
  localBoundary?: string;
  approvalScope?: string;
}

/** Shared by Permissions, which remains the sole registered Bash owner. */
let remoteBash: (() => BashOperations | undefined) | undefined;
let remoteLabel: (() => string | undefined) | undefined;
let remoteLocalBoundary: (() => string | undefined) | undefined;
let remoteApprovalScope: (() => string | undefined) | undefined;
const subscribers = new Set<(active: boolean) => void>();
let lastActive = false;

export function getRemoteRoute(): RemoteRoute | undefined {
  const backend = remoteBash?.();
  const label = remoteLabel?.();
  return backend && label ? { backend, label, localBoundary: remoteLocalBoundary?.(), approvalScope: remoteApprovalScope?.() } : undefined;
}

/** True only for Handoff's currently connected, remotely-routed backend. */
export function hasActiveRemoteRoute(): boolean {
  return Boolean(getRemoteRoute());
}

function publishRouteChange() {
  const active = hasActiveRemoteRoute();
  if (active === lastActive) return;
  lastActive = active;
  for (const subscriber of subscribers) subscriber(active);
}

/** Handoff calls this after a mutable route state transition. */
export function notifyRemoteRouteChanged() { publishRouteChange(); }

/** Subscription exposes availability only; Permissions cannot alter Handoff routing. */
export function subscribeRemoteRoute(listener: (active: boolean) => void): () => void {
  subscribers.add(listener);
  listener(hasActiveRemoteRoute());
  return () => subscribers.delete(listener);
}

export function setRemoteBashBackend(provider: (() => BashOperations | undefined) | undefined, label?: () => string | undefined, localBoundary?: () => string | undefined, approvalScope?: () => string | undefined) {
  remoteBash = provider;
  remoteLabel = label;
  remoteLocalBoundary = localBoundary;
  remoteApprovalScope = approvalScope;
  publishRouteChange();
}
export function getBashBackend(): BashOperations | undefined { return getRemoteRoute()?.backend; }
export function getBashTargetLabel(): string | undefined { return getRemoteRoute()?.label; }
/** Local side of the currently registered Handoff mapping; never infer a remote sibling root. */
export function getBashLocalBoundary(): string | undefined { return getRemoteRoute()?.localBoundary; }
/** Stable target + workspace identity used to isolate session approval rules. */
export function getBashApprovalScope(): string | undefined { return getRemoteRoute()?.approvalScope; }

export function resetBackendRegistryForTests() {
  remoteBash = undefined;
  remoteLabel = undefined;
  remoteLocalBoundary = undefined;
  remoteApprovalScope = undefined;
  lastActive = false;
  subscribers.clear();
}
