import assert from "node:assert/strict";
import test from "node:test";
import { handoffHudVariants, handoffStatus, handoffStatusDetail } from "../status.ts";
import type { HandoffState } from "../types.ts";

const syncing: HandoffState = { connection: "connected", sessionAuthority: "remote", toolRoute: "remote", syncState: "syncing", sessionId: "s", target: { alias: "gb200", workspace: "/srv" } };

test("synchronization shows what is moving and how far it has got", () => {
  assert.equal(handoffStatus(syncing), "⇅ synchronizing remote session");
  assert.equal(handoffStatus(syncing, { phase: "upload", unit: "chunk", done: 2, total: 6 }), "⇅ sending 2/6");
  assert.equal(handoffStatus(syncing, { phase: "download", unit: "chunk", done: 1, total: 4 }), "⇅ reading 1/4");
  assert.equal(handoffStatus(syncing, { phase: "download", unit: "byte", done: 1048576, total: 5767168 }), "⇅ reading 1.0 MB/5.5 MB");
});

test("the narrow HUD shows progress instead of the host name while transferring", () => {
  const text = (segments?: { text: string }[]) => (segments ?? []).map((segment) => segment.text).join("");
  assert.equal(text(handoffHudVariants(syncing).compact), "⇅ gb200");
  const progress = { phase: "upload" as const, unit: "chunk" as const, done: 3, total: 6 };
  const variants = handoffHudVariants(syncing, progress);
  assert.equal(text(variants.compact), "⇅ sending 3/6", "the count matters more than the host name mid-transfer");
  assert.equal(text(variants.full), "⇅ sending 3/6");
  assert.equal(variants.icon?.[0]?.text, "⇅");
  assert.equal(variants.compact?.[0]?.tone, "warning", "a transfer is still the warning tone");
});

test("only a real mismatch or an unreadable remote is shown as a problem", () => {
  const offline: HandoffState = { ...syncing, syncState: "offline", syncReason: "commit failed: OSError: [Errno 28] No space left on device" };
  assert.equal(handoffStatus(offline), "⚠ remote offline • changes retained");
  assert.match(handoffStatusDetail(offline), /No space left on device$/);
  const conflict: HandoffState = { ...syncing, syncState: "conflict", syncReason: "remote snapshot advanced: run /ssh pull" };
  assert.match(handoffStatusDetail(conflict), /^⚡ remote session conflict — remote snapshot advanced/);
});
