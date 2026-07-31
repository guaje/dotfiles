import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_REMOTE_ROOT, DEFAULT_SHORTCUT } from "../config.ts";
import { resolveHandoffSettings } from "../settings.ts";

test("Handoff settings accept bounded user preferences", () => {
  assert.deepEqual(resolveHandoffSettings({ handoffRemoteRoot: "~/remote/pi", handoffShortcut: "ctrl+shift+s" }), { handoffRemoteRoot: "~/remote/pi", handoffShortcut: "ctrl+shift+s" });
});

test("Handoff settings reject escapes, controls, and malformed shortcuts", () => {
  assert.deepEqual(resolveHandoffSettings({ handoffRemoteRoot: "../escape", handoffShortcut: "bad shortcut\n" }), { handoffRemoteRoot: DEFAULT_REMOTE_ROOT, handoffShortcut: DEFAULT_SHORTCUT });
});
