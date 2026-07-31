import { createSettingsStore } from "../08-settings/index.ts";
import { DEFAULT_REMOTE_ROOT, DEFAULT_SHORTCUT } from "./config.ts";

export interface HandoffSettings { handoffRemoteRoot: string; handoffShortcut: string }

function remoteRoot(value: unknown) {
  if (typeof value !== "string" || value.length > 512 || /[\0\r\n\x00-\x1f\x7f]/.test(value)) return DEFAULT_REMOTE_ROOT;
  if (!(value.startsWith("/") || value.startsWith("~/")) || value.split("/").includes("..")) return DEFAULT_REMOTE_ROOT;
  return value;
}

function shortcut(value: unknown) {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9+;:_-]+$/.test(value) ? value : DEFAULT_SHORTCUT;
}

export function resolveHandoffSettings(settings: Record<string, unknown>): HandoffSettings {
  return { handoffRemoteRoot: remoteRoot(settings.handoffRemoteRoot), handoffShortcut: shortcut(settings.handoffShortcut) };
}

export async function getHandoffSettings(): Promise<HandoffSettings> {
  return resolveHandoffSettings(await createSettingsStore().read());
}
