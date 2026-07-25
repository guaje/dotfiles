// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/permissions.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canAutoAllowLocalFile } from "../access-policy.ts";
import { normalizeManagingStyle, nextManagingStyle } from "../management-style.ts";
import { injectPromptGuidance } from "../prompt-guidance.ts";
import { parseShell } from "../shell/parser.ts";
import { analyzeBash, decideBash } from "../shell/policy.ts";
import { renderShell } from "../shell/render.ts";

const execFile = promisify(execFileCallback);

test("two management styles normalize legacy Guidance without a third mode", () => {
  assert.equal(normalizeManagingStyle("Guidance"), "Empowerment");
  assert.equal(nextManagingStyle("Micromanagement"), "Empowerment");
  assert.equal(nextManagingStyle("Empowerment"), "Micromanagement");
});
test("parser authorizes fully classified read-only lists, pipelines, substitutions, and narrow wrappers", () => {
  const analysis = parseShell("git status --short && rg todo . | sort && cat $(realpath README.md)");
  assert.equal(analysis.complete, true); assert.equal(analysis.effect, "read-only"); assert.equal(analysis.containsReadOnly, true); assert.equal(analysis.containsNonReadOnly, false);
  for (const command of ["echo ok;", "printf '%s\\n' ok", "command ls", "command -v git", "timeout 2 rg todo .", "env -i LANG=C ls", "git -C . status --short"]) {
    assert.equal(parseShell(command).effect, "read-only", command);
  }
});
test("parser makes writes, dynamic syntax, interpreters, wrappers, and output redirects non-read-only", () => {
  assert.equal(parseShell("rg x > out.txt").effect, "mutating");
  assert.equal(parseShell("eval 'rm x'").effect, "unknown");
  assert.equal(parseShell("python3 script.py").effect, "unknown");
  assert.equal(parseShell("find . -exec rm {} \\;").effect, "unknown");
  assert.equal(parseShell("git add file").effect, "mutating");
  assert.deepEqual(parseShell("git commit -m message").reasons, ["git commit creates a commit and updates repository history"]);
  assert.deepEqual(parseShell("sudo ls").reasons, ["sudo runs with elevated privileges"]);
  assert.equal(parseShell("date --set now").effect, "mutating");
  assert.equal(parseShell("sort --output result.txt input.txt").effect, "mutating");
  assert.equal(parseShell("tree -o listing.txt").effect, "mutating");
  assert.equal(parseShell("LD_PRELOAD=./hook.dylib cat README.md").effect, "unknown");
  assert.equal(parseShell("fd --exec rm {} ").effect, "unknown");
  assert.equal(parseShell("fd -xrm {} ").effect, "unknown");
  assert.equal(parseShell("rg --pre ./filter pattern").effect, "unknown");
  assert.equal(parseShell("sort --compress-program=evil input").effect, "unknown");
  assert.equal(parseShell("git diff --output=patch.txt").effect, "mutating");
  assert.equal(parseShell("git cat-file --filters HEAD:file").effect, "unknown");
});
test("coupled command substitutions do not trigger split guidance for one mutating action", () => {
  const command = "glab issue create -t \"Analysis\" -d \"$(cat /tmp/issue_analysis.md)\" -l \"analysis,tech-debt,monitoring\" --linked-mr 19";
  const analysis = parseShell(command);
  assert.equal(analysis.effect, "mutating");
  assert.equal(analysis.containsReadOnly, false);
  assert.equal(analysis.containsNonReadOnly, true);
  assert.equal(analysis.commands.find((item) => item.name === "cat")?.coupledDependency, true);
  const glab = analysis.commands.find((item) => item.name === "glab");
  assert.equal(glab?.effect, "mutating");
  assert.equal(glab?.context.usesNetwork, true);
  assert.equal(glab?.reason, "glab issue create creates a remote issue");
  const decision = decideBash(command, "Empowerment");
  assert.equal(decision.allow, false);
  assert.equal(decision.needsApproval, true);
  assert.doesNotMatch(decision.reason ?? "", /Split read-only/);
  assert.match(decideBash("cat /tmp/issue_analysis.md && glab issue create -t Analysis", "Empowerment").reason ?? "", /Split read-only/);
});

test("parser does not merge newline, background, or heredoc execution into a read-only command", () => {
  for (const command of ["git status\nrm file", "git status & rm file", "cat file&&rm file", "cat <<EOF\n$(rm file)\nEOF"]) {
    const decision = decideBash(command, "Empowerment");
    assert.equal(decision.allow, false, command);
  }
});
test("ssh retains remote metadata and distinguishes remote payload from local &&", () => {
  const remote = parseShell("ssh -o BatchMode=yes host 'git status'");
  assert.equal(remote.effect, "read-only"); assert.equal(remote.commands.some((command) => command.context.transport === "ssh"), true);
  assert.equal(parseShell("ssh host 'rm tmp'").effect, "mutating");
  assert.equal(parseShell("ssh host ls && rm local").effect, "mutating");
  assert.equal(parseShell("ssh -L 9999:x:9 host ls").effect, "unknown");
  assert.equal(parseShell("ssh -E ssh.log host 'git status'").effect, "unknown");
  assert.equal(parseShell("ssh -o RemoteCommand='rm file' host 'git status'").effect, "unknown");
  assert.equal(parseShell("ssh -O exit host ls").effect, "unknown");
  assert.equal(parseShell("ssh --unknown host ls").effect, "unknown");
  assert.equal(parseShell("ssh -p 22 host ls").effect, "read-only");
  assert.equal(parseShell("ssh -G host").effect, "read-only");
  assert.equal(parseShell("ssh -V").effect, "read-only");
  assert.equal(parseShell("GIT_SSH_COMMAND=evil ssh host 'git status'").effect, "unknown");
});
test("chezmoi inspection commands are read-only while mutations and helper overrides require approval", () => {
  for (const command of [
    "chezmoi status --verbose",
    "chezmoi diff -- install-pi-notification-icons.sh",
    "chezmoi --verbose managed",
    "chezmoi --color auto --log-level info status",
    "chezmoi --refresh-externals=never --skip-secrets diff -- file",
    "chezmoi verify",
    "chezmoi cat agent/settings.config.json",
    "chezmoi source-path agent/settings.config.json",
  ]) assert.equal(parseShell(command).effect, "read-only", command);
  for (const command of ["chezmoi add file", "chezmoi apply", "chezmoi edit file", "chezmoi forget file", "chezmoi update"]) {
    assert.equal(parseShell(command).effect, "mutating", command);
  }
  assert.equal(parseShell("chezmoi diff --output report.patch").effect, "mutating");
  assert.equal(parseShell("chezmoi status --refresh-externals=always").effect, "mutating");
  assert.equal(parseShell("chezmoi diff --pager=custom-pager").effect, "unknown");
  assert.equal(parseShell("chezmoi --config other.toml status").effect, "unknown");
  assert.equal(parseShell("chezmoi execute-template '{{ output \"cmd\" }}'").effect, "unknown");
});

test("curl classifies request and local output effects without treating networking as a verdict", () => {
  assert.equal(parseShell("curl -I https://example.test | jq .").effect, "read-only");
  assert.equal(parseShell("curl -X POST --data x https://example.test").effect, "mutating");
  assert.equal(parseShell("curl -o result https://example.test").effect, "mutating");
  assert.equal(parseShell("curl --config config https://example.test").effect, "unknown");
  assert.equal(parseShell("curl -Kconfig https://example.test").effect, "unknown");
  assert.equal(parseShell("curl --data-binary @payload https://example.test").effect, "mutating");
  assert.equal(parseShell("curl -dpayload https://example.test").effect, "mutating");
  assert.equal(parseShell("curl -D headers.txt https://example.test").effect, "mutating");
  assert.equal(parseShell("curl -sS -H 'Accept: application/json' https://example.test").effect, "read-only");
  assert.equal(parseShell("curl --get --data q=test https://example.test").effect, "read-only");
  assert.equal(parseShell("curl --etag-save etag.txt https://example.test").effect, "mutating");
  assert.equal(parseShell("curl --quote 'DELE file' ftp://example.test").effect, "mutating");
  assert.equal(parseShell("curl --write-out '%{http_code}' https://example.test").effect, "unknown");
  assert.equal(parseShell("curl --version").effect, "read-only");
});
test("Handoff transport remains metadata and does not change a read-only verdict", () => {
  const analysis = analyzeBash("ls", { location: "remote", transport: "handoff", target: "host:/repo", usesNetwork: true });
  assert.equal(analysis.effect, "read-only");
  assert.equal(analysis.context.transport, "handoff");
  assert.equal(analysis.commands[0]?.context.target, "host:/repo");
});

test("Empowerment blocks mixed commands immediately and Micromanagement approves every Bash call", () => {
  const mixed = decideBash("git status && rm file", "Empowerment");
  assert.equal(mixed.allow, false); assert.equal(mixed.needsApproval, false); assert.match(mixed.reason!, /Split read-only/);
  const micro = decideBash("git status", "Micromanagement"); assert.equal(micro.needsApproval, true);
  assert.equal(decideBash("ssh host 'git status'", "Empowerment").allow, true);
});
test("prompt guidance is injected exactly once", () => { const once = injectPromptGuidance("base"); assert.equal(injectPromptGuidance(once), once); });
test("canonical local roots reject prefix and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-test-"));
  try {
    const cwd = join(root, "repo"); const outside = join(root, "repo-other"); await mkdir(cwd); await mkdir(outside); await symlink(outside, join(cwd, "escape"));
    assert.equal(await canAutoAllowLocalFile("new.txt", cwd, []), true);
    assert.equal(await canAutoAllowLocalFile("../repo-other/no.txt", cwd, []), false);
    assert.equal(await canAutoAllowLocalFile("escape/no.txt", cwd, []), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("local policy allows only its private disposable temp root", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-cwd-"));
  try {
    const privateTemp = join(tmpdir(), `pi-permissions-${process.getuid?.() ?? "user"}`, "new.txt");
    assert.equal(await canAutoAllowLocalFile(privateTemp, root), true);
    assert.equal(await canAutoAllowLocalFile(join(tmpdir(), "unrelated-permissions-file"), root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local policy discovers linked worktrees through local Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "permissions-worktree-"));
  try {
    const main = join(root, "main"); const linked = join(root, "linked");
    await mkdir(main);
    await execFile("git", ["init", "-q", main]);
    await execFile("git", ["-C", main, "config", "user.email", "test@example.invalid"]);
    await execFile("git", ["-C", main, "config", "user.name", "Test User"]);
    await writeFile(join(main, "README.md"), "test\n");
    await execFile("git", ["-C", main, "add", "README.md"]);
    await execFile("git", ["-C", main, "commit", "-qm", "fixture"]);
    await execFile("git", ["-C", main, "worktree", "add", "-qb", "fixture-linked", linked]);
    assert.equal(await canAutoAllowLocalFile(join(linked, "new.txt"), main, []), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("renderer separates nested ssh payloads and preserves local suffixes", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<b>${text}</b>` };
  const quoted = renderShell("ssh -o BatchMode=yes host 'git status && rg todo'", theme);
  assert.match(quoted, /BatchMode/);
  assert.match(quoted, /remote shell \(host\):/);
  assert.match(quoted, /<syntaxFunction>git<\/syntaxFunction>/);
  assert.doesNotMatch(quoted, /<b>git<\/b>/);
  const localSuffix = renderShell("ssh host git status && rg local", theme);
  assert.match(localSuffix, /local shell:/);
  assert.match(renderShell("curl -I https://example.test", theme), /<mdLink>https:\/\/example\.test<\/mdLink>/);
});
