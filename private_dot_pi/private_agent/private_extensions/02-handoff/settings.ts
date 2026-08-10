import { createSettingsStore } from "../08-settings/index.ts";
import { isValidHotkey, safeHotkey } from "../08-settings/hotkeys.ts";
import { getNested } from "../08-settings/nested.ts";
import { DEFAULT_REMOTE_ROOT, DEFAULT_HOTKEY } from "./config.ts";

export interface HandoffSettings { handoffRemoteRoot: string; handoffHotkey: string }

function validRemoteRoot(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || /[\0\r\n\x00-\x1f\x7f]/.test(value)) return false;
  return (value.startsWith("/") || value.startsWith("~/")) && !value.split("/").includes("..");
}

function nestedOrFlatRemoteRoot(settings: Record<string, unknown>): string {
  const nested = getNested(settings, "handoff.remoteRoot");
  if (validRemoteRoot(nested)) return nested;
  return validRemoteRoot(settings.handoffRemoteRoot) ? settings.handoffRemoteRoot : DEFAULT_REMOTE_ROOT;
}

function nestedOrFlatHotkey(settings: Record<string, unknown>): string {
  const nested = getNested(settings, "handoff.hotkey");
  if (isValidHotkey(nested)) return safeHotkey(nested, DEFAULT_HOTKEY);
  return safeHotkey(settings.handoffShortcut, DEFAULT_HOTKEY);
}

export function resolveHandoffSettings(settings: Record<string, unknown>): HandoffSettings {
  return {
    handoffRemoteRoot: nestedOrFlatRemoteRoot(settings),
    handoffHotkey: nestedOrFlatHotkey(settings),
  };
}

export async function getHandoffSettings(): Promise<HandoffSettings> {
  return resolveHandoffSettings(await createSettingsStore().read());
}

export function registerHandoffShortcut(
  pi: { registerShortcut?: (hotkey: string, options: { description: string; handler: (ctx: any) => Promise<void> }) => void },
  settings: HandoffSettings,
  handler: (ctx: any) => Promise<void>,
): void {
  pi.registerShortcut?.(settings.handoffHotkey, { description: "Toggle SSH tool routing", handler });
}
