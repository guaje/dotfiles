export type PersistedManagingStyle = "Micromanagement" | "Empowerment";
/** YOLO is runtime-only and can exist only while Handoff routes tools remotely. */
export type ManagingStyle = PersistedManagingStyle | "YOLO";
export type ShellEffect = "read-only" | "mutating" | "unknown";
export type ShellLocation = "local" | "remote";
export type ShellTransport = "ssh" | "handoff" | undefined;
export type SessionApprovalTemplateStrength = "audited" | "conservative";
export type SessionApprovalSlotType = "workspace-path" | "workspace-path-list" | "opaque";

export interface ShellContext { location: ShellLocation; transport?: ShellTransport; target?: string; usesNetwork: boolean; }
/** Flattened command metadata is presentation-only. */
export interface ShellCommand { name: string; argv: string[]; span: { start: number; end: number }; effect: ShellEffect; reason?: string; context: ShellContext; }
/** Executables the shell will resolve if a structurally read-only call is auto-allowed. */
export interface ExecutableIdentityRequirement {
  name: string;
  rawName: string;
  argv: string[];
  context: ShellContext;
  role: "command" | "wrapper";
  unverifiableReason?: string;
}
/** One independently authorizable direct child of the outermost shell sequence. */
export interface ExecutionUnitSummary { id: number; effect: ShellEffect; span: { start: number; end: number }; operatorAfter?: ";" | "\n" | "&&" | "||"; }
export interface ShellAnalysis { source: string; complete: boolean; effect: ShellEffect; reasons: string[]; commands: ShellCommand[]; identityRequirements: ExecutableIdentityRequirement[]; context: ShellContext; executionUnits: ExecutionUnitSummary[]; }
export interface PermissionDecision { allow: boolean; needsApproval: boolean; reason?: string; analysis?: ShellAnalysis; }
