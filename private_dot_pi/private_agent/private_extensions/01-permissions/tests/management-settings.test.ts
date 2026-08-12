// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/management-settings.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { permissionsSessionApprovalMaxRules, readConfiguredManagingStyle, resetManagementSettingsForTests, setManagingStyle } from "../management-settings.ts";

afterEach(() => resetManagementSettingsForTests());

test("invalid and runtime-only YOLO configuration fail closed without rewriting the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    for (const invalid of ["invalid", "YOLO"]) {
      const source = `{"managingStyle":"${invalid}","other":true}\n`;
      await writeFile(path, source);
      assert.equal(await readConfiguredManagingStyle(path), "Micromanagement");
      assert.equal(await readFile(path, "utf8"), source);
    }
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("nested permission settings take precedence over flat", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    const source = '{"permissions":{"managingStyle":"Empowerment"},"managingStyle":"Micromanagement","other":true}\n';
    await writeFile(path, source);
    assert.equal(await readConfiguredManagingStyle(path), "Empowerment");
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid nested management style falls back to a valid flat value, otherwise Micromanagement", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    await writeFile(path, '{"permissions":{"managingStyle":"invalid"},"managingStyle":"Empowerment"}\n');
    assert.equal(await readConfiguredManagingStyle(path), "Empowerment");
    await writeFile(path, '{"permissions":{"managingStyle":"YOLO"},"managingStyle":"invalid"}\n');
    assert.equal(await readConfiguredManagingStyle(path), "Micromanagement");
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("attempting to persist runtime YOLO writes the fail-closed persisted style", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    await writeFile(path, '{"permissions":{"managingStyle":"Empowerment"}}\n');
    await setManagingStyle("YOLO" as never, async () => {}, path);
    assert.equal(JSON.parse(await readFile(path, "utf8")).permissions.managingStyle, "Micromanagement");
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("approval cap reads the configured value, nested first, then flat, accepts only non-negative integers", async () => {
  assert.equal(await permissionsSessionApprovalMaxRules(), 100);
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    await writeFile(path, '{"permissions":{"sessionApprovalMaxRules":7}}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 7);
    await writeFile(path, '{"permissionsSessionApprovalMaxRules":8}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 8);
    await writeFile(path, '{"permissions":{"sessionApprovalMaxRules":"invalid"},"permissionsSessionApprovalMaxRules":9}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 9);
    await writeFile(path, '{"permissionsSessionApprovalMaxRules":"7"}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 0);
    await writeFile(path, '{"permissionsSessionApprovalMaxRules":-1}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 0);
    await writeFile(path, '{"permissionsSessionApprovalMaxRules":1.5}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 0);
    await writeFile(path, '{}\n');
    assert.equal(await permissionsSessionApprovalMaxRules(path), 0);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit settings saves are atomic, preserve other keys and siblings, and serialize into nested", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    await writeFile(path, '{"managingStyle":"Empowerment","permissions":{"managingStyle":"Micromanagement","other":true,"sessionApprovalMaxRules":100},"theme":"catppuccin-mocha"}\n');
    const order: string[] = [];
    const first = setManagingStyle("Empowerment", async () => { order.push("first"); }, path);
    const second = setManagingStyle("Micromanagement", async () => { order.push("second"); }, path);
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first", "second"]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.permissions.managingStyle, "Micromanagement");
    assert.equal(saved.managingStyle, "Empowerment");
    assert.equal(saved.permissions.other, true);
    assert.equal(saved.permissions.sessionApprovalMaxRules, 100);
    assert.equal(saved.theme, "catppuccin-mocha");
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("merge failure restores the exact settings source", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-settings-"));
  const path = join(root, "settings.config.json");
  try {
    const source = '{\n  "permissions": {\n    "managingStyle": "Micromanagement",\n    "other": true\n  }\n}\n';
    await writeFile(path, source);
    await assert.rejects(setManagingStyle("Empowerment", async () => { throw new Error("merge failed"); }, path), /merge failed/);
    assert.equal(await readFile(path, "utf8"), source);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});
