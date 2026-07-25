export type ManagingStyle = "Micromanagement" | "Empowerment";
export type ShellEffect = "read-only" | "mutating" | "unknown";
export type ShellLocation = "local" | "remote";
export type ShellTransport = "ssh" | "handoff" | undefined;

export interface ShellContext { location: ShellLocation; transport?: ShellTransport; target?: string; usesNetwork: boolean; }
/** Flattened command metadata is presentation-only. */
export interface ShellCommand { name: string; argv: string[]; span: { start: number; end: number }; effect: ShellEffect; reason?: string; context: ShellContext; }
/** One independently authorizable direct child of the outermost shell sequence. */
export interface ExecutionUnitSummary { id: number; effect: ShellEffect; span: { start: number; end: number }; operatorAfter?: ";" | "\n" | "&&" | "||"; }
export interface ShellAnalysis { source: string; complete: boolean; effect: ShellEffect; reasons: string[]; commands: ShellCommand[]; context: ShellContext; executionUnits: ExecutionUnitSummary[]; }
export interface PermissionDecision { allow: boolean; needsApproval: boolean; reason?: string; analysis?: ShellAnalysis; }
