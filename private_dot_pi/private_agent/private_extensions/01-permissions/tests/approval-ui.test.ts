// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/approval-ui.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { confirmBash, confirmFileMutation, editPreview, formatBashApproval, formatFileApproval, writePreview } from "../approval-ui.ts";
import { analyzeBash } from "../shell/policy.ts";

const markerTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

test("write and edit previews preserve full numbered content", () => {
  assert.equal(writePreview("one\ntwo"), "1 │ one\n2 │ two");
  assert.equal(writePreview(""), "<empty file>");
  assert.match(editPreview([{ oldText: "old", newText: "new" }]), /- 1 │ old\n\+ 1 │ new/);
  assert.equal(editPreview([]), "<no diff available>");
});

test("approval formatters apply semantic Catppuccin theme roles", () => {
  const ui = { confirm: async () => true, theme: markerTheme };
  const file = formatFileApproval(ui, "file.txt", "\n\nChanges: 1 replacement");
  assert.match(file, /<toolTitle><b>Path:<\/b><\/toolTitle>/);
  assert.match(file, /<mdCode>file\.txt<\/mdCode>/);
  assert.match(file, /<toolTitle><b>Changes:<\/b><\/toolTitle> <muted>1 replacement<\/muted>/);
  const bash = formatBashApproval(ui, analyzeBash("agent/scripts/list-provider-models.sh --type chat"), "host:/repo");
  assert.doesNotMatch(bash, /Command:/);
  assert.match(bash, /<mdCode>1\)<\/mdCode>/);
  assert.match(bash, /<syntaxFunction>agent\/scripts\/list-provider-models\.sh<\/syntaxFunction>/);
  assert.doesNotMatch(bash, /<b>agent\/scripts\/list-provider-models\.sh<\/b>/);
  assert.match(bash, /<toolTitle><b>Programs to run:<\/b><\/toolTitle>/);
  assert.match(bash, /<warning>unreviewed executable: list-provider-models\.sh<\/warning>/);
  assert.match(bash, /<toolTitle><b>Remote target:<\/b><\/toolTitle> <mdCode>host:\/repo<\/mdCode>/);
});

test("file confirmation restores editor and working state after rejection", async () => {
  let editor = "original";
  const editorValues: string[] = [];
  const working: boolean[] = [];
  const notifications: string[] = [];
  const ui = {
    theme: markerTheme,
    getEditorText: () => editor,
    setEditorText(value: string) { editor = value; editorValues.push(value); },
    setWorkingVisible(value: boolean) { working.push(value); },
    async confirm(title: string, message: string) {
      assert.equal(title, "<warning><b>Allow file edit?</b></warning>");
      assert.match(message, /<toolTitle><b>Path:<\/b><\/toolTitle>\n\n<mdCode>file\.txt<\/mdCode>/);
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
    theme: markerTheme,
    setWorkingVisible(value: boolean) { working.push(value); },
    async confirm(title: string, message: string) {
      assert.equal(title, "<warning><b>Allow bash command?</b></warning>");
      assert.doesNotMatch(message, /Command:/);
      assert.match(message, /<mdCode>1\)<\/mdCode> <syntaxFunction>rm<\/syntaxFunction>/);
      assert.match(message, /<toolTitle><b>Programs to run:<\/b><\/toolTitle>/);
      assert.match(message, /<error>rm can change files or system state<\/error>/);
      return true;
    },
  };
  assert.equal(await confirmBash({ ui }, analyzeBash("rm file"), undefined, async () => {}), true);
  assert.deepEqual(working, [false, true]);
});
