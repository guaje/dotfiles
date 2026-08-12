import assert from "node:assert/strict";
import test from "node:test";
import { parseShell } from "../shell/parser.ts";
import { classifyProfile } from "../shell/profiles.ts";
import type { ShellContext, ShellEffect } from "../types.ts";

const local: ShellContext = { location: "local", usesNetwork: false };
const remote: ShellContext = { location: "remote", transport: "handoff", target: "host:/repo", usesNetwork: true };
function effect(command: string, context = local): ShellEffect { return parseShell(command, context).effect; }

test("path-qualified executable names never inherit reviewed basename profiles", () => {
  for (const command of ["./cat file", "../bin/nl file", "/usr/bin/git status", "/usr/bin/curl https://example.com", "/usr/bin/ssh host 'git status'", "CAT file", "Git status"]) {
    assert.equal(effect(command), "unknown", command);
  }
});

test("existing reader profiles reject pager, follow, compile, output, and execution forms", () => {
  assert.equal(effect("bat file"), "read-only");
  for (const command of ["bat --pager less file", "bat --pager=less file", "bat --paging=always file", "bat --paging always file"]) assert.equal(effect(command), "unknown", command);
  for (const command of ["tail -f file", "tail -F file", "tail -nf 2 file", "tail --follow=name file"]) assert.equal(effect(command), "unknown", command);
  assert.equal(effect("tail -n 2 file"), "read-only");
  assert.equal(effect("file -C -m magic"), "mutating");
  assert.equal(effect("file --compile -m magic"), "mutating");
  for (const command of ["find . -exec echo '{}' ';'", "find . -fprint output", "find . -fprintf output '%p'", "find . -fls output"]) assert.notEqual(effect(command), "read-only", command);
});

test("uniq parses option arity and treats its output operand as mutating", () => {
  for (const command of ["uniq", "uniq input", "uniq -c input", "uniq -f 2 input", "uniq -f2 -s3 -w4 input", "uniq --skip-fields=2 input", "uniq -- input", "uniq input -"]) assert.equal(effect(command), "read-only", command);
  for (const command of ["uniq input output", "uniq -f 2 input output", "uniq -- input output"]) assert.equal(effect(command), "mutating", command);
  for (const command of ["uniq -f", "uniq --skip-fields", "uniq --unknown input", "uniq a b c"]) assert.equal(effect(command), "unknown", command);
});

test("cd and nl are local-only finite read profiles", () => {
  for (const command of ["cd", "cd src/components", "cd /tmp", "nl file", "nl -ba file", "nl -n rz file"]) assert.equal(effect(command), "read-only", command);
  for (const command of ["cd -", "cd -P dir", "cd one two"]) assert.equal(effect(command), "unknown", command);
  assert.equal(effect("cd src", remote), "unknown");
  assert.equal(effect("nl -ba file", remote), "unknown");
});

test("adb allows only exact local device listings", () => {
  for (const command of ["adb devices", "adb devices -l"]) {
    const analysis = parseShell(command);
    assert.equal(analysis.effect, "read-only", command);
    assert.equal(analysis.commands[0]?.context.usesNetwork, false, command);
  }
  for (const command of [
    "adb", "adb devices --", "adb devices -L", "adb devices --anything", "adb devices -l extra",
    "adb -s serial devices", "adb -d devices", "adb -e devices", "adb -t 1 devices", "adb -H host devices", "adb -P 5037 devices",
    "adb shell true", "adb track-devices", "adb get-state", "adb push source target", "adb pull source target", "adb install app.apk",
    "adb root", "adb reboot", "adb forward tcp:1 tcp:2", "adb connect host", "adb start-server", "adb kill-server",
    "/usr/bin/adb devices", "ADB devices",
  ]) assert.equal(effect(command), "unknown", command);
  assert.equal(effect("adb devices", remote), "unknown");
});

test("adb listings compose with other classified top-level units", () => {
  const readOnly = parseShell("git status; adb devices");
  assert.equal(readOnly.complete, true);
  assert.deepEqual(readOnly.executionUnits.map((unit) => unit.effect), ["read-only", "read-only"]);

  const mixed = parseShell("git status; git add file; adb devices");
  assert.equal(mixed.complete, true);
  assert.deepEqual(mixed.executionUnits.map((unit) => unit.effect), ["read-only", "mutating", "read-only"]);
});

test("glab exact queries and REST GET forms are read-only only in local context", () => {
  for (const command of [
    "glab mr view 1", "glab mr list", "glab mr diff 1", "glab mr pipelines 1",
    "glab ci lint", "glab ci list", "glab ci trace", "glab ci view", "glab ci status",
    "glab auth status", "glab repo view", "glab job trace", "glab pipeline list", "glab pipeline view", "glab variable list", "glab config list",
    "glab api projects/1", "glab api projects/1 -X GET -f page=1", "glab api projects/1 --method=HEAD", "glab api projects/1 --paginate --output json",
  ]) assert.equal(effect(command), "read-only", command);
  for (const command of ["glab ci status --live", "glab ci status --wait", "glab mr view 1 --web", "glab job artifact", "glab api graphql", "glab api projects/1 --input body.json", "glab api projects/1 -X GET --form file=@payload", "glab api projects/1 --unknown"]) assert.equal(effect(command), "unknown", command);
  for (const command of ["glab api projects/1 -f value=x", "glab api projects/1 -X POST", "glab mr create", "glab ci run"]) assert.equal(effect(command), "mutating", command);
  assert.equal(effect("glab mr view 1", remote), "unknown");
});

test("gh exact queries and REST GET forms reject bodies, GraphQL, helpers, and mutations", () => {
  for (const command of ["gh run list", "gh run view 1", "gh pr checks 1", "gh pr view 1", "gh pr list", "gh auth status", "gh repo view", "gh release view v1", "gh release list", "gh api repos/o/r", "gh api repos/o/r -X GET -F page=1", "gh api repos/o/r --paginate --jq .name"]) assert.equal(effect(command), "read-only", command);
  for (const command of ["gh run watch 1", "gh run download 1", "gh pr view 1 --web", "gh api graphql", "gh api repos/o/r --input body.json", "gh api repos/o/r --cache 1h", "gh api repos/o/r --unknown"]) assert.equal(effect(command), "unknown", command);
  for (const command of ["gh api repos/o/r -f value=x", "gh api repos/o/r --method DELETE", "gh pr merge 1", "gh workflow run build.yml"]) assert.equal(effect(command), "mutating", command);
  assert.equal(effect("gh run list", remote), "unknown");
});

test("new Git query profiles are guarded and local-only while existing remote queries stay unchanged", () => {
  for (const subcommand of ["ls-tree HEAD", "merge-base main HEAD", "rev-list HEAD", "show-ref", "for-each-ref", "blame file", "describe HEAD", "name-rev HEAD", "diff-tree HEAD", "diff-index HEAD", "diff-files", "shortlog HEAD"]) assert.equal(effect(`git ${subcommand}`), "read-only", subcommand);
  for (const command of ["git diff-tree --ext-diff HEAD", "git diff-files --textconv", "git show-ref --output=out", "git -c core.pager=cat ls-tree HEAD", "git --config-env=x=y rev-list HEAD"]) assert.notEqual(effect(command), "read-only", command);
  assert.equal(effect("git ls-tree HEAD", remote), "unknown");
  assert.equal(effect("git status", remote), "read-only");
});

test("direct classifier keeps all additive profiles out of remote contexts", () => {
  for (const [name, argv] of [["adb", ["devices"]], ["cd", ["src"]], ["nl", ["file"]], ["glab", ["mr", "view", "1"]], ["gh", ["run", "list"]], ["git", ["ls-tree", "HEAD"]]] as const) {
    assert.equal(classifyProfile(name, [...argv], remote).effect, "unknown", name);
  }
});
