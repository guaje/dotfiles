import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HOTKEY, DEFAULT_REMOTE_ROOT } from "../config.ts";
import { registerHandoffShortcut, resolveHandoffSettings } from "../settings.ts";

test("Handoff settings prefer nested remote root and hotkey", () => {
  assert.deepEqual(resolveHandoffSettings({
    handoff: { remoteRoot: "~/remote/pi", hotkey: "ctrl+shift+s" },
    handoffRemoteRoot: "~/legacy", handoffShortcut: "ctrl+1",
  }), { handoffRemoteRoot: "~/remote/pi", handoffHotkey: "ctrl+shift+s" });
});

test("Handoff settings support legacy flat values", () => {
  assert.deepEqual(resolveHandoffSettings({ handoffRemoteRoot: "~/remote/pi", handoffShortcut: "ctrl+shift+s" }), {
    handoffRemoteRoot: "~/remote/pi",
    handoffHotkey: "ctrl+shift+s",
  });
});

test("Handoff falls back to valid legacy values when nested values are invalid", () => {
  assert.deepEqual(resolveHandoffSettings({
    handoff: { remoteRoot: "../invalid", hotkey: "ctrl+c" },
    handoffRemoteRoot: "~/legacy/pi",
    handoffShortcut: "ctrl+1",
  }), { handoffRemoteRoot: "~/legacy/pi", handoffHotkey: "ctrl+1" });
});

test("Handoff registers its resolved hotkey for /hotkeys", async () => {
  const shortcuts = new Map<string, { description: string; handler: (ctx: any) => Promise<void> }>();
  let toggled = false;
  registerHandoffShortcut({ registerShortcut: (hotkey, options) => shortcuts.set(hotkey, options) }, {
    handoffRemoteRoot: "~/remote/pi",
    handoffHotkey: "ctrl+shift+s",
  }, async () => { toggled = true; });
  assert.equal(shortcuts.get("ctrl+shift+s")?.description, "Toggle SSH tool routing");
  await shortcuts.get("ctrl+shift+s")?.handler({});
  assert.equal(toggled, true);
});

test("Handoff settings reject unsafe roots and invalid or protected hotkeys", () => {
  assert.deepEqual(resolveHandoffSettings({
    handoff: { remoteRoot: "../escape", hotkey: "ctrl+c" },
  }), { handoffRemoteRoot: DEFAULT_REMOTE_ROOT, handoffHotkey: DEFAULT_HOTKEY });
  assert.deepEqual(resolveHandoffSettings({ handoffRemoteRoot: "~/safe", handoffShortcut: "ctrl+PAGEUP" }), {
    handoffRemoteRoot: "~/safe",
    handoffHotkey: "ctrl+pageUp",
  });
});
