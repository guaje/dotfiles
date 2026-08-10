import { isValidHotkey, safeHotkey, sameHotkey, validateHotkey } from "../08-settings/hotkeys.ts";
import { getNested } from "../08-settings/nested.ts";

export const DEFAULT_FORWARD_HOTKEY = "ctrl+;";
export const DEFAULT_BACKWARD_HOTKEY = "shift+ctrl+;";
export const FALLBACK_BACKWARD_HOTKEY = "shift+ctrl+:";

let cachedForwardHotkey = DEFAULT_FORWARD_HOTKEY;
let cachedBackwardHotkey = DEFAULT_BACKWARD_HOTKEY;

export { isValidHotkey, safeHotkey, validateHotkey };

function nestedOrFlatHotkey(settings: Record<string, unknown>, path: string, flatKey: string, fallback: string): string {
  const nested = getNested(settings, path);
  if (isValidHotkey(nested)) return safeHotkey(nested, fallback);
  return safeHotkey(settings[flatKey], fallback);
}

export function resolveHotkeys(settings: Record<string, unknown>): { forward: string; backward: string } {
  const forward = nestedOrFlatHotkey(settings, "permissions.managementStyleForwardHotkey", "managementStyleForwardHotkey", DEFAULT_FORWARD_HOTKEY);
  const backward = nestedOrFlatHotkey(settings, "permissions.managementStyleBackwardHotkey", "managementStyleBackwardHotkey", DEFAULT_BACKWARD_HOTKEY);

  if (sameHotkey(forward, backward)) {
    return { forward: DEFAULT_FORWARD_HOTKEY, backward: DEFAULT_BACKWARD_HOTKEY };
  }
  return { forward, backward };
}

export function cacheHotkeys(forward: string, backward: string): void {
  cachedForwardHotkey = forward;
  cachedBackwardHotkey = backward;
}

export function getCachedForwardHotkey(): string {
  return cachedForwardHotkey;
}
export function getCachedBackwardHotkey(): string {
  return cachedBackwardHotkey;
}

export function isManagementStyleBackwardInput(data: string, matches: (data: string, key: string) => boolean): boolean {
  if (matches(data, getCachedBackwardHotkey())) return true;
  // The terminal representation is needed only for Pi's default shift+ctrl+; binding.
  return getCachedBackwardHotkey() === DEFAULT_BACKWARD_HOTKEY && matches(data, FALLBACK_BACKWARD_HOTKEY);
}
