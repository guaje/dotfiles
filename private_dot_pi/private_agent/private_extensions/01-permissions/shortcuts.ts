/** Code-owned directional shortcuts. Keep the shifted terminal fallback backward-only. */
export const MANAGEMENT_STYLE_FORWARD_SHORTCUT = "ctrl+;";
export const MANAGEMENT_STYLE_BACKWARD_SHORTCUT = "shift+ctrl+;";
export const MANAGEMENT_STYLE_BACKWARD_FALLBACK_SHORTCUT = "shift+ctrl+:";
export const MANAGEMENT_STYLE_HOTKEY_DISPLAY = `${MANAGEMENT_STYLE_FORWARD_SHORTCUT} / ${MANAGEMENT_STYLE_BACKWARD_SHORTCUT}`;
export function isManagementStyleBackwardInput(data: string, matches: (data: string, key: string) => boolean): boolean {
 return matches(data, MANAGEMENT_STYLE_BACKWARD_SHORTCUT) || matches(data, MANAGEMENT_STYLE_BACKWARD_FALLBACK_SHORTCUT);
}
