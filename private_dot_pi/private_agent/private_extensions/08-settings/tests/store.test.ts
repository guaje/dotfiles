import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore, resetSettingsStoreForTests } from "../store.ts";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config: join(root, "source.json"), generated: join(root, "generated.json") };
}

test("settings use source first and generated settings only as fallback", async (t) => {
  const { config, generated } = await fixture(t);
  await writeFile(config, '{"source":true}\n');
  await writeFile(generated, '{"generated":true}\n');
  const store = createSettingsStore({ paths: { configPath: config, generatedPath: generated }, runMerge: async () => {} });
  assert.deepEqual(await store.read(), { source: true });
  await unlink(config);
  assert.deepEqual(await store.read(), { generated: true });
});

test("failed merge restores the exact source bytes", async (t) => {
  const { config, generated } = await fixture(t);
  await writeFile(config, '{ "x": 1 }\n');
  await writeFile(generated, '{"x":2}');
  const store = createSettingsStore({ paths: { configPath: config, generatedPath: generated }, runMerge: async () => { throw new Error("merge failed"); } });
  await assert.rejects(store.update({ x: 3 }), /merge failed/);
  assert.equal(await readFile(config, "utf8"), '{ "x": 1 }\n');
});

test("failed first-time creation restores source absence", async (t) => {
  const { config, generated } = await fixture(t);
  await writeFile(generated, '{}\n');
  const store = createSettingsStore({ paths: { configPath: config, generatedPath: generated }, runMerge: async () => { throw new Error("merge failed"); } });
  await assert.rejects(store.update({ created: true }), /merge failed/);
  await assert.rejects(readFile(config, "utf8"), (error: any) => error?.code === "ENOENT");
});

test("concurrent updates are serialized without losing unrelated keys", async (t) => {
  resetSettingsStoreForTests();
  const { config, generated } = await fixture(t);
  await writeFile(config, '{"base":true}\n');
  await writeFile(generated, '{}\n');
  const store = createSettingsStore({ paths: { configPath: config, generatedPath: generated }, runMerge: async () => {} });
  await Promise.all([store.update({ first: 1 }), store.update({ second: 2 })]);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { base: true, first: 1, second: 2 });
});
