import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Shared by confirm-before-actions, which remains the sole registered bash owner. */
let remoteBash: (() => BashOperations | undefined) | undefined;
let remoteLabel: (() => string | undefined) | undefined;
export function setRemoteBashBackend(provider: (() => BashOperations | undefined) | undefined, label?: () => string | undefined) { remoteBash = provider; remoteLabel = label; }
export function getBashBackend(): BashOperations | undefined { return remoteBash?.(); }
export function getBashTargetLabel(): string | undefined { return remoteLabel?.(); }
