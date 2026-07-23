import assert from "node:assert/strict";
import test from "node:test";
import { verifyHelperPreflight } from "../gate.ts";

test("verifyHelperPreflight matches exact version and checksum", () => {
  assert.ok(verifyHelperPreflight({ version: 1, checksum: "abc" }, "abc"));
});

test("verifyHelperPreflight rejects mismatched version or checksum", () => {
  assert.equal(verifyHelperPreflight({ version: 2, checksum: "abc" }, "abc"), false);
  assert.equal(verifyHelperPreflight({ version: 1, checksum: "abc" }, "def"), false);
  assert.equal(verifyHelperPreflight({}, "abc"), false);
});
