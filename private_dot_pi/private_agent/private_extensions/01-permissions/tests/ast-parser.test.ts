// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/ast-parser.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseShellAst } from "../shell/ast-parser.ts";
import { SHELL_GRAPH_LIMITS } from "../shell/ast.ts";

function nestedSubstitutions(depth: number) { let value = "echo ok"; for (let index = 0; index < depth; index++) value = `echo $(${value})`; return value; }

test("AST preserves sequence, pipeline, group, substitution, source, and spans", () => {
  const source = "git status && (cat $(realpath file) | jq .)";
  const graph = parseShellAst(source);
  assert.equal(graph.complete, true);
  assert.equal(graph.source, source);
  assert.equal(graph.root.kind, "sequence");
  assert.deepEqual(graph.root.span, { start: 0, end: source.length });
  if (graph.root.kind !== "sequence") return;
  assert.equal(graph.root.units[0]?.operatorAfter, "&&");
  const group = graph.root.units[1]?.node;
  assert.equal(group?.kind, "group");
  if (group?.kind !== "group") return;
  assert.equal(group.body.kind, "pipeline");
  if (group.body.kind !== "pipeline") return;
  const cat = group.body.stages[0];
  assert.equal(cat?.kind, "command");
  if (cat?.kind !== "command") return;
  assert.equal(cat.words[1]?.substitutions[0]?.root.kind, "command");
});

test("AST represents wrappers and literal SSH payloads structurally", () => {
  const wrapper = parseShellAst("sudo -u root rm file");
  assert.equal(wrapper.root.kind, "wrapper");
  if (wrapper.root.kind === "wrapper") {
    assert.equal(wrapper.root.name, "sudo");
    assert.equal(wrapper.root.command.words[3]?.value, "rm");
  }
  const ssh = parseShellAst("ssh host 'git status && rm file'");
  assert.equal(ssh.root.kind, "ssh");
  if (ssh.root.kind === "ssh") {
    assert.equal(ssh.root.target, "host");
    assert.equal(ssh.root.payload?.root.kind, "sequence");
  }
});

test("AST binds redirections and keeps heredoc semantics fail-closed", () => {
  const output = parseShellAst("rg todo > report.txt");
  assert.equal(output.complete, true);
  assert.equal(output.root.kind, "command");
  if (output.root.kind === "command") {
    assert.equal(output.root.redirections[0]?.operator, ">");
    assert.equal(output.root.redirections[0]?.target?.value, "report.txt");
  }
  const heredoc = parseShellAst("cat <<EOF\nbody\nEOF");
  assert.equal(heredoc.complete, false);
  assert.match(heredoc.errors.join("; "), /heredoc/);
});

test("unsupported shell syntax and malformed input fail closed", () => {
  for (const [source, reason] of [
    ["sleep 1 &", /background/],
    ["echo $((1 + 2))", /arithmetic/],
    ["diff <(one) <(two)", /process substitution/],
    ["echo `date`", /backtick/],
    ["echo \"unterminated", /unterminated quote/],
  ] as const) {
    const graph = parseShellAst(source);
    assert.equal(graph.complete, false, source);
    assert.match(graph.errors.join("; "), reason, source);
  }
});

test("deterministic generated supported fragments always parse or fail closed without throwing", () => {
  const commands = ["ls -la", "git status", "cat file", "rg todo .", "echo 'value'", "curl -I https://example.test"];
  const operators = [";", "&&", "||", "|"];
  for (const left of commands) for (const operator of operators) for (const right of commands) {
    const graph = parseShellAst(`${left} ${operator} ${right}`);
    assert.ok(graph.root);
    assert.ok(graph.nodeCount <= SHELL_GRAPH_LIMITS.maxNodes);
    if (!graph.complete) assert.equal(graph.root.kind === "unsupported" || graph.errors.length > 0, true);
  }
});

test("source, depth, and node limits fail closed", () => {
  const oversized = parseShellAst("x".repeat(SHELL_GRAPH_LIMITS.maxSourceLength + 1));
  assert.equal(oversized.complete, false);
  assert.match(oversized.errors[0]!, /source length limit/);
  const deep = parseShellAst(nestedSubstitutions(SHELL_GRAPH_LIMITS.maxDepth + 2));
  assert.equal(deep.complete, false);
  assert.match(deep.errors.join("; "), /depth limit/);
  const many = parseShellAst(Array.from({ length: SHELL_GRAPH_LIMITS.maxNodes + 2 }, () => "true").join("; "));
  assert.equal(many.complete, false);
  assert.match(many.errors.join("; "), /node limit/);
});
