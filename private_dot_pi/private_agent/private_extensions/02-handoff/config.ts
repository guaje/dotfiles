import { resolve } from "node:path";

export const HANDOFF_PROTOCOL_VERSION = 1;
export const DEFAULT_REMOTE_ROOT = "~/.local/state/pi/remote-sessions";
export const DEFAULT_SHORTCUT = "ctrl+alt+s";
export const MAX_SSH_CONFIG_DEPTH = 12;
export const MAX_SSH_CONFIG_FILES = 64;
export const MAX_SSH_CONFIG_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;
export const SSH_TIMEOUT_MS = 20_000;
export const extensionDir = import.meta.dirname;
export const cacheRoot = resolve(extensionDir, "../../handoff-cache");
export const helperSource = resolve(extensionDir, "assets/pi-handoff-gate.py");
