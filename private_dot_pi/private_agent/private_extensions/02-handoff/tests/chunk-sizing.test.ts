import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHUNK_BYTES } from "../config.ts";
import { CHUNK_MAX_BYTES, CHUNK_MIN_BYTES, createChunkSizer, pickChunkBytes, recordTransfer, targetKey } from "../chunk-sizing.ts";

const gb200 = { alias: "gb200.launchpad.nvidia.com", user: "nvidia" };
const MEBI = 1024 * 1024;

test("an unmeasured link starts at the mirrored default, never above the negotiated cap", () => {
  assert.equal(pickChunkBytes(gb200, {}), MAX_CHUNK_BYTES);
  assert.equal(pickChunkBytes(gb200, {}, 512 * 1024), 512 * 1024, "the helper's cap always wins");
});

test("a fast measured link earns big chunks; a slow one is kept conservative", () => {
  const fast = recordTransfer({}, targetKey(gb200), { bytes: 8 * MEBI, ms: 500, ok: true }); // ~16 MB/s
  assert.equal(pickChunkBytes(gb200, fast, 4 * MEBI), CHUNK_MAX_BYTES, "a generous negotiated cap lets fast links carry the maximum");
  assert.equal(pickChunkBytes(gb200, fast), MAX_CHUNK_BYTES, "the default cap is the mirrored helper constant");
  const slow = recordTransfer({}, targetKey(gb200), { bytes: 256 * 1024, ms: 4_000, ok: true }); // ~65 KB/s
  assert.equal(pickChunkBytes(gb200, slow), CHUNK_MIN_BYTES, "aiming for half a second of transfer keeps poor links cheap to retry");
});

test("a failed transfer halves the remembered size", () => {
  const remembered = { [targetKey(gb200)]: { chunkBytes: 2 * MEBI } };
  const after = recordTransfer(remembered, targetKey(gb200), { bytes: 2 * MEBI, ms: 100, ok: false });
  assert.equal(pickChunkBytes(gb200, after), 1 * MEBI);
});

test("one host's measurements never size another host's chunks", () => {
  const history = recordTransfer({}, targetKey(gb200), { bytes: 8 * MEBI, ms: 500, ok: true });
  assert.equal(pickChunkBytes({ alias: "jetstream" }, history), MAX_CHUNK_BYTES);
});

test("measurements persist so the next session starts from reality", async (t) => {
  const path = join(tmpdir(), `handoff-chunk-sizes-${randomUUID()}.json`);
  t.after(() => rm(path, { force: true }));
  const first = await createChunkSizer(path);
  first.record(gb200, { bytes: 8 * MEBI, ms: 500, ok: true });
  const second = await createChunkSizer(path);
  assert.equal(second.pick(gb200), Math.min(CHUNK_MAX_BYTES, MAX_CHUNK_BYTES));
});
