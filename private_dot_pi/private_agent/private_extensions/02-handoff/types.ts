export type ConnectionState = "disconnected" | "connected";
export type SessionAuthority = "local" | "remote";
export type ToolRoute = "local" | "remote";
export type SyncState = "clean" | "dirty" | "syncing" | "offline" | "stale" | "locked" | "conflict";

export interface RemoteTarget { alias: string; host?: string; user?: string; port?: number; workspace: string; }
export interface HandoffState {
  connection: ConnectionState;
  sessionAuthority: SessionAuthority;
  toolRoute: ToolRoute;
  syncState: SyncState;
  target?: RemoteTarget;
  sessionId?: string;
  cachePath?: string;
  manifest?: { generation: number; hash: string };
  lock?: { token: string; nonce: string; expiresAt: number };
}
export interface HandoffContextEntry { type: "handoff-context"; state: HandoffState; }
export interface SshHost { alias: string; source: string; }
export interface TransportResult { stdout: Buffer; stderr: Buffer; code: number; }
