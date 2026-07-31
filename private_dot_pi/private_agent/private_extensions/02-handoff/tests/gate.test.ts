import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_PROTOCOL_VERSION } from "../config.ts";
import { verifyHelperPreflight } from "../gate.ts";

test("verifyHelperPreflight matches exact version and checksum", () => {
  assert.equal(verifyHelperPreflight({ version: HANDOFF_PROTOCOL_VERSION, checksum: "abc" }, "abc"), true);
});

test("verifyHelperPreflight rejects mismatched version or checksum", () => {
  assert.equal(verifyHelperPreflight({ version: HANDOFF_PROTOCOL_VERSION + 1, checksum: "abc" }, "abc"), false);
  assert.equal(verifyHelperPreflight({ version: HANDOFF_PROTOCOL_VERSION, checksum: "abc" }, "def"), false);
  assert.equal(verifyHelperPreflight({}, "abc"), false);
});
