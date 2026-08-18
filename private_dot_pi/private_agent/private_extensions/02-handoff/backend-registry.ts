import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Narrow Handoff-owned route capability consumed by Permissions. */
export interface RemoteRoute {
  backend: BashOperations;
  label: string;
  localBoundary?: string;
  approvalScope?: string;
}

export interface RemoteRouteAuthorization {
  required: boolean;
  route?: RemoteRoute;
}

type BackendProvider = () => BashOperations | undefined;
type StringProvider = () => string | undefined;
type RouteSubscriber = (active: boolean) => void;
interface BackendRegistry {
  owner?: symbol;
  remoteBash?: BackendProvider;
  remoteLabel?: StringProvider;
  remoteLocalBoundary?: StringProvider;
  remoteApprovalScope?: StringProvider;
  subscribers: Set<RouteSubscriber>;
  pendingRemoteCalls: Map<string, string>;
  lastActive: boolean;
}

/** Pi loads each extension through an isolated jiti module cache, so cross-extension state must be process-global. */
export const BACKEND_REGISTRY_SYMBOL = Symbol.for("pi.handoff.backend-registry.v1");
type RegistryRoot = typeof globalThis & { [key: symbol]: unknown };

function registry(): BackendRegistry {
  const root = globalThis as RegistryRoot;
  const current = root[BACKEND_REGISTRY_SYMBOL] as BackendRegistry | undefined;
  if (current) return current;
  const created: BackendRegistry = { subscribers: new Set(), pendingRemoteCalls: new Map(), lastActive: false };
  root[BACKEND_REGISTRY_SYMBOL] = created;
  return created;
}

export function getRemoteRoute(): RemoteRoute | undefined {
  const current = registry();
  const backend = current.remoteBash?.();
  const label = current.remoteLabel?.();
  return backend && label
    ? {
        backend,
        label,
        localBoundary: current.remoteLocalBoundary?.(),
        approvalScope: current.remoteApprovalScope?.(),
      }
    : undefined;
}

/** True only for Handoff's currently connected, remotely-routed backend. */
export function hasActiveRemoteRoute(): boolean {
  return Boolean(getRemoteRoute());
}

function publishRouteChange() {
  const current = registry();
  const active = hasActiveRemoteRoute();
  if (active === current.lastActive) return;
  current.lastActive = active;
  for (const subscriber of current.subscribers) subscriber(active);
}

function clearProviders(current: BackendRegistry) {
  current.owner = undefined;
  current.remoteBash = undefined;
  current.remoteLabel = undefined;
  current.remoteLocalBoundary = undefined;
  current.remoteApprovalScope = undefined;
}

function routeIdentity(route: RemoteRoute): string {
  return route.approvalScope ?? route.label;
}

/** Handoff calls this after a mutable route state transition. */
export function notifyRemoteRouteChanged() { publishRouteChange(); }

/** Subscription exposes availability only; Permissions cannot alter Handoff routing. */
export function subscribeRemoteRoute(listener: RouteSubscriber): () => void {
  const current = registry();
  current.subscribers.add(listener);
  listener(hasActiveRemoteRoute());
  return () => current.subscribers.delete(listener);
}

/**
 * Register a Handoff backend and return an ownership-checked disposer. An older extension
 * instance cannot clear a newer registration during reload shutdown.
 */
export function setRemoteBashBackend(
  provider: BackendProvider | undefined,
  label?: StringProvider,
  localBoundary?: StringProvider,
  approvalScope?: StringProvider,
): () => void {
  const current = registry();
  if (!provider) {
    clearProviders(current);
    publishRouteChange();
    return () => {};
  }

  const owner = Symbol("handoff-backend-owner");
  current.owner = owner;
  current.remoteBash = provider;
  current.remoteLabel = label;
  current.remoteLocalBoundary = localBoundary;
  current.remoteApprovalScope = approvalScope;
  publishRouteChange();

  return () => {
    const latest = registry();
    if (latest.owner !== owner) return;
    clearProviders(latest);
    publishRouteChange();
  };
}

/** Record that Permissions authorized this call only because the current route was remote. */
export function requireRemoteRouteForToolCall(toolCallId: string, route = getRemoteRoute()): boolean {
  if (!route) return false;
  registry().pendingRemoteCalls.set(toolCallId, routeIdentity(route));
  return true;
}

/** Consume the requirement and return the still-matching route, if one exists. */
export function consumeRemoteRouteForToolCall(toolCallId: string): RemoteRouteAuthorization {
  const current = registry();
  const expected = current.pendingRemoteCalls.get(toolCallId);
  if (expected === undefined) return { required: false };
  current.pendingRemoteCalls.delete(toolCallId);
  const route = getRemoteRoute();
  return route && routeIdentity(route) === expected ? { required: true, route } : { required: true };
}

export function clearRemoteRouteForToolCall(toolCallId: string) {
  registry().pendingRemoteCalls.delete(toolCallId);
}

export function getBashBackend(): BashOperations | undefined { return getRemoteRoute()?.backend; }
export function getBashTargetLabel(): string | undefined { return getRemoteRoute()?.label; }
/** Local side of the currently registered Handoff mapping; never infer a remote sibling root. */
export function getBashLocalBoundary(): string | undefined { return getRemoteRoute()?.localBoundary; }
/** Stable target + workspace identity used to isolate session approval rules. */
export function getBashApprovalScope(): string | undefined { return getRemoteRoute()?.approvalScope; }

export function resetBackendRegistryForTests() {
  const root = globalThis as RegistryRoot;
  const current = root[BACKEND_REGISTRY_SYMBOL] as BackendRegistry | undefined;
  if (current) {
    if (current.lastActive) for (const subscriber of current.subscribers) subscriber(false);
    current.subscribers.clear();
    current.pendingRemoteCalls.clear();
  }
  delete root[BACKEND_REGISTRY_SYMBOL];
}
