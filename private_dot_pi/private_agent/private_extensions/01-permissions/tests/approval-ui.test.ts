// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/approval-ui.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { confirmBash, confirmFileMutation, editPreview, writePreview } from "../approval-ui.ts";

test("write and edit previews preserve full numbered content", () => {
  assert.equal(writePreview("one\ntwo"), "1 │ one\n2 │ two");
  assert.equal(writePreview(""), "<empty file>");
  assert.match(editPreview([{ oldText: "old", newText: "new" }]), /- 1 │ old\n\+ 1 │ new/);
  assert.equal(editPreview([]), "<no diff available>");
});

test("file confirmation restores editor and working state after rejection", async () => {
  let editor = "original";
  const editorValues: string[] = [];
  const working: boolean[] = [];
  const notifications: string[] = [];
  const ui = {
    getEditorText: () => editor,
    setEditorText(value: string) { editor = value; editorValues.push(value); },
    setWorkingVisible(value: boolean) { working.push(value); },
    async confirm(title: string, message: string) {
      assert.equal(title, "Allow file edit?");
      assert.match(message, /Path:\n\nfile\.txt/);
      assert.equal(editor, "diff preview");
      return false;
    },
  };
  const allowed = await confirmFileMutation(
    { ui },
    { title: "Allow file edit?", path: "file.txt", preview: "diff preview", summary: "\n\nChanges: 1 replacement" },
    async (body) => { notifications.push(body); },
  );
  assert.equal(allowed, false);
  assert.deepEqual(editorValues, ["diff preview", "original"]);
  assert.deepEqual(working, [false, true]);
  assert.deepEqual(notifications, ["Approval needed: Allow file edit"]);
});

test("bash confirmation hides and restores the working indicator", async () => {
  const working: boolean[] = [];
  const ui = {
    setWorkingVisible(value: boolean) { working.push(value); },
    async confirm(title: string, message: string) {
      assert.equal(title, "Allow bash command?");
      assert.equal(message, "Programs to run: 1) rm");
      return true;
    },
  };
  assert.equal(await confirmBash({ ui }, "Programs to run: 1) rm", async () => {}), true);
  assert.deepEqual(working, [false, true]);
});
