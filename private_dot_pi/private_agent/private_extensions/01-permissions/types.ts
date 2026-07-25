export type ManagingStyle = "Micromanagement" | "Empowerment";
export type ShellEffect = "read-only" | "mutating" | "unknown";
export type ShellLocation = "local" | "remote";
export type ShellTransport = "ssh" | "handoff" | undefined;

export interface ShellContext { location: ShellLocation; transport?: ShellTransport; target?: string; usesNetwork: boolean; }
export interface ShellCommand { name: string; argv: string[]; span: { start: number; end: number }; effect: ShellEffect; reason?: string; context: ShellContext; coupledDependency?: boolean; }
export interface ShellAnalysis { source: string; complete: boolean; effect: ShellEffect; reasons: string[]; commands: ShellCommand[]; containsReadOnly: boolean; containsNonReadOnly: boolean; context: ShellContext; }
export interface PermissionDecision { allow: boolean; needsApproval: boolean; reason?: string; analysis?: ShellAnalysis; }
