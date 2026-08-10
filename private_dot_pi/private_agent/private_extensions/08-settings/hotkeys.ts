const VALID_MODIFIERS = new Set(["ctrl", "shift", "alt"]);
const VALID_SINGLE_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  ...["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"],
]);
const SPECIAL_KEYS = new Map([
  ["escape", "escape"], ["esc", "esc"], ["enter", "enter"], ["return", "return"],
  ["tab", "tab"], ["space", "space"], ["backspace", "backspace"], ["delete", "delete"], ["insert", "insert"], ["clear", "clear"],
  ["home", "home"], ["end", "end"], ["pageup", "pageUp"], ["pagedown", "pageDown"],
  ["up", "up"], ["down", "down"], ["left", "left"], ["right", "right"],
  ...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`] as const),
]);
const PROTECTED_BINDINGS = new Set([
  "escape", "enter", "ctrl+c", "ctrl+d", "ctrl+z", "shift+tab", "ctrl+p", "ctrl+shift+p",
  "ctrl+l", "ctrl+o", "ctrl+t", "ctrl+g", "alt+enter", "ctrl+k",
]);

interface ParsedHotkey { modifiers: string[]; key: string; semanticKey: string }

function parseHotkey(value: unknown): ParsedHotkey | string {
  if (typeof value !== "string" || value.length === 0) return "empty";
  if (value !== value.trim()) return "whitespace is not allowed";
  const normalized = value.toLowerCase();
  let modifierSource: string;
  let key: string;
  if (normalized.endsWith("+")) {
    const beforeKey = normalized.slice(0, -1);
    if (!beforeKey) {
      modifierSource = "";
    } else {
      if (!beforeKey.endsWith("+")) return "empty key";
      modifierSource = beforeKey.slice(0, -1);
      if (!modifierSource) return "unknown modifier: (empty)";
    }
    key = "+";
  } else {
    const parts = normalized.split("+");
    key = parts.pop()!;
    modifierSource = parts.join("+");
  }
  const modifiers = modifierSource ? modifierSource.split("+") : [];
  const seen = new Set<string>();
  for (const modifier of modifiers) {
    if (!VALID_MODIFIERS.has(modifier)) return `unknown modifier: ${modifier || "(empty)"}`;
    if (seen.has(modifier)) return `duplicate modifier: ${modifier}`;
    seen.add(modifier);
  }
  if (!key) return "empty key";
  const specialKey = SPECIAL_KEYS.get(key);
  if (!specialKey && !VALID_SINGLE_KEYS.has(key)) return `unknown or multi-character key: ${key}`;
  return {
    modifiers,
    key: specialKey ?? key,
    semanticKey: key === "esc" ? "escape" : key === "return" ? "enter" : specialKey ?? key,
  };
}

function parsed(value: unknown): ParsedHotkey | undefined {
  const result = parseHotkey(value);
  return typeof result === "string" ? undefined : result;
}

function semanticBinding(value: ParsedHotkey): string {
  return [...value.modifiers].sort().concat(value.semanticKey).join("+");
}

/** Returns a user-facing validation error, or null for a documented Pi keybinding. */
export function validateHotkey(value: unknown): string | null {
  const result = parseHotkey(value);
  if (typeof result === "string") return result;
  return PROTECTED_BINDINGS.has(semanticBinding(result)) ? "protected binding" : null;
}

/** Canonicalizes pageUp/pageDown casing after successful validation. */
export function normalizeHotkey(value: string): string {
  const result = parsed(value);
  return result ? [...result.modifiers, result.key].join("+") : value;
}

export function isValidHotkey(value: unknown): value is string {
  return validateHotkey(value) === null;
}

/** Returns a known-good fallback whenever a configured value is malformed or protected. */
export function safeHotkey(value: unknown, fallback: string): string {
  return isValidHotkey(value) ? normalizeHotkey(value) : fallback;
}

/** Compares bindings independently of modifier order and documented key aliases. */
export function sameHotkey(left: string, right: string): boolean {
  const parsedLeft = parsed(left);
  const parsedRight = parsed(right);
  return Boolean(parsedLeft && parsedRight && semanticBinding(parsedLeft) === semanticBinding(parsedRight));
}
