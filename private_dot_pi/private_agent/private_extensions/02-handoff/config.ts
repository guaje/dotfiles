import { resolve } from "node:path";

export const HANDOFF_PROTOCOL_VERSION = 3;
export const DEFAULT_REMOTE_ROOT = "~/.local/state/pi/remote-sessions";
export const DEFAULT_HOTKEY = "ctrl+alt+s";
export const MAX_SSH_CONFIG_DEPTH = 12;
export const MAX_SSH_CONFIG_FILES = 64;
export const MAX_SSH_CONFIG_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
/** Mirrors MAX_SNAPSHOT_BYTES in assets/pi-handoff-gate.py (a runaway-client rail; the binding limit is remote free space, checked before transfer). */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
/** Mirrors MAX_CHUNK_BYTES in the helper; the smaller of the two is negotiated per transfer. */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** One SSH connection is reused for the requests of an operation instead of a fresh handshake each. */
export const SSH_MULTIPLEX = true;
/** How long a verified remote helper stays trusted before the version handshake runs again. */
export const HELPER_READY_TTL_MS = 15_000;
/** Payloads above this use staged chunked upload; a single request must survive base64 inside the envelope. */
export const DIRECT_COMMIT_BYTES = 5 * 1024 * 1024;
export const MAX_STDIN_BYTES = MAX_PROTOCOL_BYTES;
export const MAX_OUTPUT_LINES = 2000;
export const SSH_TIMEOUT_MS = 20_000;
export const extensionDir = import.meta.dirname;
export const cacheRoot = resolve(extensionDir, "../../handoff-cache");
export const helperSource = resolve(extensionDir, "assets/pi-handoff-gate.py");
export const helperRemotePath = "${HOME}/.local/libexec/pi-handoff-gate.py";
