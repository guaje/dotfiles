import assert from "node:assert/strict";
import test from "node:test";

test("session-store rejects path-traversal session ids", async () => {
  const { cacheDirectory } = await import("../session-store.ts");
  assert.throws(() => cacheDirectory("."), /Invalid/);
  assert.throws(() => cacheDirectory(".."), /Invalid/);
  assert.throws(() => cacheDirectory("../etc"), /Invalid/);
  assert.ok(cacheDirectory("valid-session").includes("valid-session"));
});
