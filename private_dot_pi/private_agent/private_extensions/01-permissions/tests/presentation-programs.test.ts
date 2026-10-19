// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/presentation-programs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { extractProgramsForDisplay } from "../shell/presentation-programs.ts";

test("descriptor duplication and pipelines keep every apparent program visible", () => {
  const source = `cd /Users/guaje/Dev/app && export JAVA_HOME=/opt/x ANDROID_HOME=/opt/y && ./gradlew :app:testDebugUnitTest --tests "*Foo*" 2>&1 | grep -E "FAILED|PASSED" | head -12`;
  assert.deepEqual(extractProgramsForDisplay(source), ["cd", "export", "./gradlew", "grep", "head"]);
});
test("quoted operators and quoted pipes never create programs", () => {
  assert.deepEqual(extractProgramsForDisplay(`echo "a && b | c; d"`), ["echo"]);
  assert.deepEqual(extractProgramsForDisplay(`grep -E 'x|y' file`), ["grep"]);
});
test("assignment-only segments contribute nothing", () => {
  assert.deepEqual(extractProgramsForDisplay("A=1 B=2"), []);
  assert.deepEqual(extractProgramsForDisplay("A=1; echo hi"), ["echo"]);
});
test("comments are not listed as programs", () => {
  assert.deepEqual(extractProgramsForDisplay("# rm -rf /\necho hi"), ["echo"]);
});
test("command substitutions list their nested program before the outer one", () => {
  assert.deepEqual(extractProgramsForDisplay(`glab issue create -d "$(cat body)"`), ["cat", "glab"]);
});
test("heredoc bodies are not listed as programs", () => {
  assert.deepEqual(extractProgramsForDisplay("cat <<EOF\nrm -rf /\nEOF\necho hi"), ["cat", "echo"]);
});
test("background separators still separate apparent programs", () => {
  assert.deepEqual(extractProgramsForDisplay("sleep 1 & echo done"), ["sleep", "echo"]);
});
test("duplicate programs appear once, in first-seen order", () => {
  assert.deepEqual(extractProgramsForDisplay("echo a; echo b | cat; cat"), ["echo", "cat"]);
});
