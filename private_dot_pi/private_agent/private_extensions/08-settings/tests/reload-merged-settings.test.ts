// Run with: npx -y tsx --test agent/extensions/08-settings/tests/reload-merged-settings.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { registerSettingsExtension } from "../index.ts";

function harness() {
  const handlers = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    pi: { on(event: string, handler: any) { handlers.set(event, handler); } },
    handler(name: string) { assert.ok(handlers.has(name)); return handlers.get(name); },
    ctx: { ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } },
    notifications,
  };
}

test("merges on session start, debounces source changes, and closes on shutdown", async () => {
  const app = harness();
  let merges = 0;
  let listener: (() => void) | undefined;
  let closes = 0;
  registerSettingsExtension(app.pi as any, {
    configPath: "/fixture/settings.config.json",
    debounceMs: 1,
    merge: async () => { merges++; },
    watch: (_path, callback) => { listener = callback; return { close() { closes++; } }; },
  });
  await app.handler("session_start")({}, app.ctx);
  assert.equal(merges, 1);
  listener?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(merges, 2);
  app.handler("session_shutdown")();
  assert.equal(closes, 1);
  assert.deepEqual(app.notifications, []);
});

test("merge failures notify without preventing watcher setup", async () => {
  const app = harness();
  let watched = false;
  registerSettingsExtension(app.pi as any, {
    configPath: "/fixture/settings.config.json",
    merge: async () => { throw new Error("boom"); },
    watch: () => { watched = true; return { close() {} }; },
  });
  await app.handler("session_start")({}, app.ctx);
  assert.equal(watched, true);
  assert.deepEqual(app.notifications, [{ message: "Failed to merge settings: boom", level: "error" }]);
});
