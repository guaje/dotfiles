// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/approval-ui.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { chooseBashApproval, confirmBash, confirmFileMutation, editPreview, formatBashApproval, formatFileApproval, writePreview } from "../approval-ui.ts";
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
  assert.match(file, /<toolOutput>file\.txt<\/toolOutput>/);
  assert.match(file, /<toolTitle><b>Changes:<\/b><\/toolTitle> <muted>1 replacement<\/muted>/);
  const issueFile = formatFileApproval(ui, "/tmp/issue_analysis.md", "\n\nNew content: 75 lines, 3506 chars");
  assert.match(issueFile, /<toolTitle><b>Path:<\/b><\/toolTitle>\n\n<toolOutput>\/tmp\/issue_analysis\.md<\/toolOutput>/);
  assert.match(issueFile, /<toolTitle><b>New content:<\/b><\/toolTitle> <muted>75 lines, 3506 chars<\/muted>/);
  assert.doesNotMatch(issueFile, /<b>\/tmp\/issue_analysis\.md<\/b>/);
  assert.doesNotMatch(issueFile, /<b>75 lines, 3506 chars<\/b>/);
  const bash = formatBashApproval(ui, analyzeBash("agent/scripts/list-provider-models.sh --type chat"), "host:/repo");
  assert.doesNotMatch(bash, /Command:/);
  assert.match(bash, /<mdCode>1\)<\/mdCode>/);
  assert.match(bash, /<syntaxFunction>agent\/scripts\/list-provider-models\.sh<\/syntaxFunction>/);
  assert.doesNotMatch(bash, /<b>agent\/scripts\/list-provider-models\.sh<\/b>/);
  assert.match(bash, /<toolTitle><b>Programs to run:<\/b><\/toolTitle>/);
  assert.match(bash, /<warning>unreviewed executable: list-provider-models\.sh<\/warning>/);
  assert.match(bash, /<toolTitle><b>Remote target:<\/b><\/toolTitle> <toolOutput>host:\/repo<\/toolOutput>/);
  const gitCommit = formatBashApproval(ui, analyzeBash("git commit -m 'message'"));
  assert.match(gitCommit, /<warning>git commit<\/warning> <muted>creates a commit and updates repository history<\/muted>/);
  assert.doesNotMatch(gitCommit, /not a reviewed query/);
  const qualifiedGitCommit = formatBashApproval(ui, analyzeBash("/usr/bin/git -C repo commit -m message"));
  assert.match(qualifiedGitCommit, /<warning>git commit<\/warning> <muted>creates a commit and updates repository history<\/muted>/);
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
      assert.match(message, /<toolTitle><b>Path:<\/b><\/toolTitle>\n\n<toolOutput>file\.txt<\/toolOutput>/);
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
      assert.equal(title, "<warning><b>Allow Bash command?</b></warning>");
      assert.doesNotMatch(message, /Command:/);
      assert.match(message, /<mdCode>1\)<\/mdCode> <syntaxFunction>rm<\/syntaxFunction>/);
      assert.match(message, /<toolTitle><b>Programs to run:<\/b><\/toolTitle>/);
      assert.match(message, /<error>rm<\/error> <muted>can change files or system state<\/muted>/);
      return true;
    },
  };
  assert.equal(await confirmBash({ ui }, analyzeBash("rm file"), undefined, async () => {}), true);
  assert.deepEqual(working, [false, true]);
});

test("Bash session approval uses one selector with preview, rule, and three choices", async () => {
  const prompts: string[] = [];
  const choices: string[][] = [];
  const ui = {
    theme: markerTheme,
    confirm: async () => { throw new Error("select should be used"); },
    select: async (prompt: string, items: string[]) => {
      prompts.push(prompt);
      choices.push(items);
      return "Allow similar commands for this session";
    },
  };
  const result = await chooseBashApproval(
    { ui },
    analyzeBash("git add file.txt"),
    { optionLabel: "Allow similar commands for this session", ruleDescription: "git add <paths inside this workspace>" },
    undefined,
    async () => {},
  );
  assert.equal(result, "remember");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Allow Bash command\?/);
  assert.match(prompts[0]!, /Programs to run:/);
  assert.match(prompts[0]!, /git add <paths inside this workspace>/);
  assert.deepEqual(choices[0], ["Deny", "Allow once", "Allow similar commands for this session"]);
});

test("ineligible Bash approvals expose only deny and once", async () => {
  let choices: string[] = [];
  const result = await chooseBashApproval({ ui: {
    confirm: async () => false,
    select: async (_prompt: string, items: string[]) => { choices = items; return "Allow once"; },
  } }, analyzeBash("echo $(rm file)"), undefined, undefined, async () => {});
  assert.equal(result, "once");
  assert.deepEqual(choices, ["Deny", "Allow once"]);
});

test("Bash selector errors deny and restore the working indicator", async () => {
  const working: boolean[] = [];
  const result = await chooseBashApproval({ ui: {
    confirm: async () => true,
    select: async () => { throw new Error("fixture"); },
    setWorkingVisible(value: boolean) { working.push(value); },
  } }, analyzeBash("rm file"), { optionLabel: "Allow this exact command for this session", ruleDescription: "Exact local invocation of rm" }, undefined, async () => {});
  assert.equal(result, "deny");
  assert.deepEqual(working, [false, true]);
});
