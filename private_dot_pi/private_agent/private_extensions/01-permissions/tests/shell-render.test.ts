// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/shell-render.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { renderShell } from "../shell/render.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
  italic: (text: string) => `<i>${text}</i>`,
};

test("ordinary shell syntax uses a restrained normal-weight hierarchy", () => {
  const rendered = renderShell("VAR=value ls -la 'some path'", theme);
  assert.match(rendered, /<muted>1<\/muted> <dim>│<\/dim>/);
  assert.match(rendered, /<mdLink>VAR<\/mdLink><accent>=<\/accent><text>value<\/text>/);
  assert.match(rendered, /<syntaxFunction>ls<\/syntaxFunction>/);
  assert.match(rendered, /<toolTitle>-la<\/toolTitle>/);
  assert.match(rendered, /<syntaxString>'some path'<\/syntaxString>/);
  assert.doesNotMatch(rendered, /<b>/);
});

test("severity colors are reserved for elevated, destructive, and mutating HTTP tokens", () => {
  assert.match(renderShell("sudo ls", theme), /<warning>sudo<\/warning> <syntaxFunction>ls<\/syntaxFunction>/);
  assert.match(renderShell("sudo -u root rm file", theme), /<warning>sudo<\/warning> <toolTitle>-u<\/toolTitle> <text>root<\/text> <error>rm<\/error>/);
  assert.match(renderShell("rm file", theme), /<error>rm<\/error>/);
  const curl = renderShell("curl -X POST --data x https://example.test", theme);
  assert.match(curl, /<syntaxFunction>curl<\/syntaxFunction>/);
  assert.match(curl, /<warning>-X<\/warning>/);
  assert.match(curl, /<error>--data<\/error>/);
  assert.match(curl, /<mdLink>https:\/\/example\.test<\/mdLink>/);
  assert.doesNotMatch(curl, /<b>/);
});

test("SSH presentation keeps quiet structure and blue normal-weight nested commands", () => {
  const rendered = renderShell("ssh host 'git status'", theme);
  assert.match(rendered, /<syntaxFunction>ssh<\/syntaxFunction>/);
  assert.match(rendered, /<muted>remote shell \(host\): <\/muted>/);
  assert.match(rendered, /<syntaxFunction>git<\/syntaxFunction>/);
  assert.match(renderShell("ssh -p 22 host ls", theme), /<toolTitle>-p<\/toolTitle> <syntaxNumber>22<\/syntaxNumber>/);
  assert.doesNotMatch(rendered, /<b>/);
});
