// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/security-acceptance.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createShellParser, parseShell } from "../shell/parser.ts";
import { SHELL_GRAPH_LIMITS } from "../shell/ast.ts";
import { analyzeBash, decideAnalysis, decideBash } from "../shell/policy.ts";
import type { ShellAnalysis } from "../types.ts";

const unknownUnit = (source: string) => ({ id: 0, effect: "unknown" as const, span: { start: 0, end: source.length } });

test("only direct outer sequence children receive split guidance for every sequence operator", () => {
  for (const operator of [";", "\n", "&&", "||"] as const) {
    const decision = decideBash(`git status ${operator} git add file`, "Empowerment");
    assert.equal(decision.allow, false, operator);
    assert.equal(decision.needsApproval, false, operator);
    assert.match(decision.reason ?? "", /Split read-only/, operator);
  }
});

test("pipelines, substitutions, wrappers, groups, redirections, and SSH payloads are coupled", () => {
  for (const command of [
    "cat file | tee out",
    "echo $(rm file)",
    "sudo git status",
    "(git status; rm file)",
    "cat < $(rm file)",
    "ssh host 'git status && rm file'",
  ]) {
    const decision = decideBash(command, "Empowerment");
    assert.equal(decision.needsApproval, true, command);
    assert.doesNotMatch(decision.reason ?? "", /Split read-only/, command);
    assert.equal(decision.analysis?.executionUnits.length, 1, command);
  }
});

test("authorization depends exclusively on mandatory execution units", () => {
  const analysis: ShellAnalysis = {
    source: "presentation only",
    complete: true,
    effect: "mutating",
    reasons: [],
    context: { location: "local", usesNetwork: false },
    executionUnits: [{ id: 0, effect: "read-only", span: { start: 0, end: 17 } }],
    commands: [{ name: "rm", argv: ["important"], effect: "mutating", span: { start: 0, end: 12 }, context: { location: "local", usesNetwork: false } }],
  };
  assert.equal(decideAnalysis(analysis, "Empowerment").allow, true);
  analysis.executionUnits = [unknownUnit("presentation only")];
  analysis.commands = [{ name: "git", argv: ["status"], effect: "read-only", span: { start: 0, end: 10 }, context: { location: "local", usesNetwork: false } }];
  assert.equal(decideAnalysis(analysis, "Empowerment").needsApproval, true);
});

test("parser exceptions, resource limits, and unsupported syntax fail closed with exactly one unknown unit", () => {
  const failed = createShellParser({
    parseShellAst() { throw new Error("fixture"); },
    analyzeShellGraph() { throw new Error("unreachable"); },
  })("git status");
  assert.equal(failed.complete, false);
  assert.equal(failed.effect, "unknown");
  assert.deepEqual(failed.executionUnits, [unknownUnit("git status")]);

  let nested = "true";
  for (let index = 0; index < SHELL_GRAPH_LIMITS.maxDepth + 2; index++) nested = `echo $(${nested})`;
  const cases = [
    "x".repeat(SHELL_GRAPH_LIMITS.maxSourceLength + 1),
    Array.from({ length: SHELL_GRAPH_LIMITS.maxNodes + 2 }, () => "true").join("; "),
    nested,
    "echo $((1 + 2))",
    "diff <(one) <(two)",
    "echo `date`",
    "echo \"unterminated",
    "sleep 1 &",
    "cat <<EOF\nbody\nEOF",
  ];
  for (const command of cases) {
    const analysis = analyzeBash(command);
    const decision = decideAnalysis(analysis, "Empowerment");
    assert.equal(analysis.complete, false, command.slice(0, 20));
    assert.equal(analysis.effect, "unknown", command.slice(0, 20));
    assert.deepEqual(analysis.executionUnits, [unknownUnit(command)], command.slice(0, 20));
    assert.equal(decision.allow, false, command.slice(0, 20));
    assert.equal(decision.needsApproval, true, command.slice(0, 20));
  }
});

test("SSH uses the AST payload, retaining local and remote substitution contexts", () => {
  const remote = parseShell("ssh host 'echo $(cat file)'");
  assert.equal(remote.complete, true);
  assert.equal(remote.effect, "read-only");
  assert.equal(remote.commands.find((command) => command.name === "cat")?.context.transport, "ssh");

  const local = parseShell('ssh host "echo $(cat file)"');
  assert.equal(local.effect, "unknown");
  assert.match(local.reasons.join("; "), /local command substitution/);
  assert.equal(local.commands.find((command) => command.name === "cat")?.context.location, "local");

  const nested = parseShell("ssh outer 'ssh inner \"git status\"'");
  assert.equal(nested.commands.find((command) => command.name === "git")?.context.target, "inner");
  assert.equal(nested.commands.at(-1)?.context.target, "outer");

  const deepPayload = `ssh host '${"echo $(".repeat(9)}true${")".repeat(9)}'`;
  assert.equal(parseShell(deepPayload).effect, "unknown");
});

test("handoff remains context metadata for ordinary and network commands", () => {
  const context = { location: "remote" as const, transport: "handoff" as const, target: "host:/repo", usesNetwork: true };
  for (const source of ["git status", "curl -I https://example.test"]) {
    const analysis = analyzeBash(source, context);
    assert.equal(analysis.effect, "read-only", source);
    assert.equal(analysis.context, context);
    assert.equal(analysis.commands[0]?.context.transport, "handoff", source);
    assert.equal(analysis.commands[0]?.context.target, "host:/repo", source);
  }
});
