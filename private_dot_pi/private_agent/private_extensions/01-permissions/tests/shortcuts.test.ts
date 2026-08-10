import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BACKWARD_HOTKEY,
  DEFAULT_FORWARD_HOTKEY,
  FALLBACK_BACKWARD_HOTKEY,
  cacheHotkeys,
  isManagementStyleBackwardInput,
  isValidHotkey,
  resolveHotkeys,
  safeHotkey,
  validateHotkey,
} from "../shortcuts.ts";

function fakeMatches(data: string, key: string) { return data === key; }

test("strict hotkey validation accepts documented keys and canonicalizes page keys", () => {
  for (const binding of ["ctrl+;", "shift+ctrl+;", "ctrl++", "ctrl+f1", "ctrl+1", "alt+pageDown", "pageUp"]) {
    assert.equal(validateHotkey(binding), null, binding);
  }
  assert.equal(safeHotkey("ctrl+PAGEUP", DEFAULT_FORWARD_HOTKEY), "ctrl+pageUp");
  assert.equal(safeHotkey("shift+pagedown", DEFAULT_FORWARD_HOTKEY), "shift+pageDown");
});

test("strict hotkey validation rejects malformed, unknown, duplicate, and protected bindings", () => {
  for (const binding of ["win+a", "ctrl+shift+ctrl+a", "ctrl+ab", "ctrl+", "++", "ctrl++a", "ctrl+é", " ctrl+a"]) {
    assert.notEqual(validateHotkey(binding), null, binding);
  }
  for (const binding of [
    "escape", "esc", "enter", "return", "ctrl+c", "ctrl+d", "ctrl+z", "shift+tab",
    "ctrl+p", "ctrl+shift+p", "shift+ctrl+p", "ctrl+l", "ctrl+o", "ctrl+t", "ctrl+g", "alt+enter", "ctrl+k",
  ]) {
    assert.ok(validateHotkey(binding)?.includes("protected"), `expected ${binding} to be rejected`);
  }
  assert.equal(isValidHotkey("ctrl+c"), false);
  assert.equal(isValidHotkey(""), false);
  assert.equal(isValidHotkey("ctrl+;"), true);
  assert.equal(safeHotkey("ctrl+c", DEFAULT_FORWARD_HOTKEY), DEFAULT_FORWARD_HOTKEY);
});

test("resolveHotkeys uses nested settings and falls back to flat", () => {
  assert.deepEqual(resolveHotkeys({
    permissions: { managementStyleForwardHotkey: "ctrl+1", managementStyleBackwardHotkey: "shift+ctrl+2" },
  }), { forward: "ctrl+1", backward: "shift+ctrl+2" });

  assert.deepEqual(resolveHotkeys({
    managementStyleForwardHotkey: "ctrl+1",
    managementStyleBackwardHotkey: "shift+ctrl+2",
  }), { forward: "ctrl+1", backward: "shift+ctrl+2" });

  assert.deepEqual(resolveHotkeys({
    permissions: { managementStyleForwardHotkey: "ctrl+c", managementStyleBackwardHotkey: "bad+key" },
    managementStyleForwardHotkey: "ctrl+1",
    managementStyleBackwardHotkey: "shift+ctrl+2",
  }), { forward: "ctrl+1", backward: "shift+ctrl+2" });

  assert.deepEqual(resolveHotkeys({}), { forward: DEFAULT_FORWARD_HOTKEY, backward: DEFAULT_BACKWARD_HOTKEY });
});

test("resolveHotkeys uses defaults when bindings collide or are invalid", () => {
  assert.deepEqual(resolveHotkeys({
    permissions: { managementStyleForwardHotkey: "ctrl+shift+1", managementStyleBackwardHotkey: "shift+ctrl+1" },
  }), { forward: DEFAULT_FORWARD_HOTKEY, backward: DEFAULT_BACKWARD_HOTKEY });
  assert.deepEqual(resolveHotkeys({
    permissions: { managementStyleForwardHotkey: "ctrl+c", managementStyleBackwardHotkey: "shift+ctrl+;" },
  }), { forward: DEFAULT_FORWARD_HOTKEY, backward: "shift+ctrl+;" });
});

test("the terminal fallback applies only to the default backward binding", () => {
  cacheHotkeys(DEFAULT_FORWARD_HOTKEY, DEFAULT_BACKWARD_HOTKEY);
  assert.equal(isManagementStyleBackwardInput("shift+ctrl+;", fakeMatches), true);
  assert.equal(isManagementStyleBackwardInput(FALLBACK_BACKWARD_HOTKEY, fakeMatches), true);
  assert.equal(isManagementStyleBackwardInput("ctrl+;", fakeMatches), false);

  cacheHotkeys("ctrl+1", "shift+ctrl+1");
  assert.equal(isManagementStyleBackwardInput("shift+ctrl+1", fakeMatches), true);
  assert.equal(isManagementStyleBackwardInput(FALLBACK_BACKWARD_HOTKEY, fakeMatches), false);
});
