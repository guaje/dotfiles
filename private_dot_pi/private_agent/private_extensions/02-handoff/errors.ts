export class HandoffError extends Error { constructor(message: string, readonly code = "handoff") { super(message); this.name = "HandoffError"; } }
export class TransportError extends HandoffError { constructor(message: string) { super(message, "transport"); this.name = "TransportError"; } }
export class PathBoundaryError extends HandoffError { constructor(path: string) { super(`Path is outside the selected remote workspace: ${path}`, "path-boundary"); this.name = "PathBoundaryError"; } }
