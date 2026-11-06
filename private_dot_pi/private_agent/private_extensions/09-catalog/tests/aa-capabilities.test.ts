import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accumulateCapabilities, loadReviewedCapabilities } from "../aa-capabilities.ts";

const capture = (provider: string, model: string, capabilities?: { input?: ("text" | "image")[]; reasoning?: boolean }) => ({ provider, model, capabilities });

test("reviewed captures that agree become capability evidence", () => {
  const reviewed = accumulateCapabilities([
    capture("test-provider", "reasoner", { input: ["text", "image"], reasoning: true }),
    capture("test-provider", "reasoner", { input: ["text", "image"] }),
  ]);
  assert.deepEqual(reviewed.get("test-provider/reasoner"), { input: ["text", "image"], reasoning: true });
});

test("captures that disagree are dropped instead of averaged", () => {
  const reviewed = accumulateCapabilities([
    capture("test-provider", "contested", { input: ["text"], reasoning: true }),
    capture("test-provider", "contested", { input: ["text", "image"], reasoning: false }),
  ]);
  assert.deepEqual(reviewed.get("test-provider/contested"), undefined, "neither modality nor reasoning survives a disagreement");
  const partial = accumulateCapabilities([
    capture("test-provider", "partial", { input: ["text"], reasoning: true }),
    capture("test-provider", "partial", { input: ["text", "image"] }),
  ]);
  assert.deepEqual(partial.get("test-provider/partial"), { reasoning: true }, "only the contested field is dropped");
});

test("a model nobody described is absent rather than text-only", () => {
  assert.deepEqual([...accumulateCapabilities([capture("test-provider", "silent"), capture("test-provider", "silent", {})])], []);
});

test("capability loading stays empty when no reviewed generation is published", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-aa-capabilities-"));
  const previous = process.env.PI_AA_SNAPSHOT_ROOT;
  process.env.PI_AA_SNAPSHOT_ROOT = directory;
  try {
    assert.deepEqual([...await loadReviewedCapabilities()], []);
  } finally {
    if (previous === undefined) delete process.env.PI_AA_SNAPSHOT_ROOT; else process.env.PI_AA_SNAPSHOT_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
