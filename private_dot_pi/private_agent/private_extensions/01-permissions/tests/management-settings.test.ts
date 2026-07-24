// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/management-settings.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { readConfiguredManagingStyle, resetManagementSettingsForTests, setManagingStyle } from "../management-settings.ts";

afterEach(() => resetManagementSettingsForTests());

test("legacy Guidance reads as Empowerment without rewriting the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    const source = '{"managingStyle":"Guidance","other":true}\n';
    await writeFile(path, source);
    assert.equal(await readConfiguredManagingStyle(path), "Empowerment");
    assert.equal(await readFile(path, "utf8"), source);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit settings saves are atomic, preserve other keys, and serialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    await writeFile(path, '{"managingStyle":"Micromanagement","other":true}\n');
    const order: string[] = [];
    const first = setManagingStyle("Empowerment", async () => { order.push("first"); }, path);
    const second = setManagingStyle("Micromanagement", async () => { order.push("second"); }, path);
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first", "second"]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.managingStyle, "Micromanagement");
    assert.equal(saved.other, true);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("merge failure restores the exact settings source", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    const source = '{\n  "managingStyle": "Micromanagement",\n  "other": true\n}\n';
    await writeFile(path, source);
    await assert.rejects(setManagingStyle("Empowerment", async () => { throw new Error("merge failed"); }, path), /merge failed/);
    assert.equal(await readFile(path, "utf8"), source);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});
