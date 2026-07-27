import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Shared by permissions, which remains the sole registered Bash owner. */
let remoteBash: (() => BashOperations | undefined) | undefined;
let remoteLabel: (() => string | undefined) | undefined;
let remoteLocalBoundary: (() => string | undefined) | undefined;
let remoteApprovalScope: (() => string | undefined) | undefined;
export function setRemoteBashBackend(provider: (() => BashOperations | undefined) | undefined, label?: () => string | undefined, localBoundary?: () => string | undefined, approvalScope?: () => string | undefined) { remoteBash = provider; remoteLabel = label; remoteLocalBoundary = localBoundary; remoteApprovalScope = approvalScope; }
export function getBashBackend(): BashOperations | undefined { return remoteBash?.(); }
export function getBashTargetLabel(): string | undefined { return remoteLabel?.(); }
/** Local side of the currently registered Handoff mapping; never infer a remote sibling root. */
export function getBashLocalBoundary(): string | undefined { return remoteLocalBoundary?.(); }
/** Stable target + workspace identity used to isolate session approval rules. */
export function getBashApprovalScope(): string | undefined { return remoteApprovalScope?.(); }
