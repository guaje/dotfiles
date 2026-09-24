import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DIRECT_COMMIT_BYTES, MAX_CHUNK_BYTES, MAX_PROTOCOL_BYTES, MAX_SNAPSHOT_BYTES, helperSource } from "../config.ts";

/**
 * Size rules exist on both sides of the wire: the helper enforces them and the client pre-checks
 * them. These assertions keep the mirrored literals honest and prove the negotiated transfer units
 * can physically fit the framed protocol, so no constant can be raised in isolation.
 */
function pythonConstant(source: string, name: string): number {
  const match = new RegExp(`^${name} = (\\d+)((?: \\* \\d+)+)$`, "m").exec(source);
  assert.ok(match, `helper is missing a literal ${name}`);
  return (match[1] + (match[2] ?? "")).split(/\s*\*\s*/).reduce((total, factor) => total * Number(factor), 1);
}

const ENVELOPE_OVERHEAD = 4096;
const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4;

test("client size literals match the deployed helper constants", () => {
  const helper = readFileSync(helperSource, "utf8");
  assert.equal(MAX_SNAPSHOT_BYTES, pythonConstant(helper, "MAX_SNAPSHOT_BYTES"));
  assert.equal(MAX_CHUNK_BYTES, pythonConstant(helper, "MAX_CHUNK_BYTES"));
  assert.equal(MAX_PROTOCOL_BYTES, pythonConstant(helper, "MAX_PROTOCOL_BYTES"));
});

test("a maximum chunk and a maximum single-shot commit both fit the request envelope", () => {
  assert.ok(base64(MAX_CHUNK_BYTES) + ENVELOPE_OVERHEAD < MAX_PROTOCOL_BYTES, "maximum chunk cannot be framed");
  assert.ok(base64(DIRECT_COMMIT_BYTES) + ENVELOPE_OVERHEAD < MAX_PROTOCOL_BYTES, "single-shot commit cannot be framed");
});

test("chunking is meaningful: the single-shot threshold is below the snapshot cap", () => {
  assert.ok(DIRECT_COMMIT_BYTES < MAX_SNAPSHOT_BYTES);
  assert.ok(MAX_CHUNK_BYTES < DIRECT_COMMIT_BYTES);
});
