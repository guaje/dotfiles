import assert from "node:assert/strict";
import test from "node:test";
import { chooseWorkspace } from "../choose-workspace.ts";
import { TransportError } from "../errors.ts";
import { shellLiteral, shellTest } from "../transport.ts";

interface Scenario {
  home?: string;
  choices?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  listings?: Record<string, string>;
  validDirectories?: string[];
  listFailures?: string[];
  testFailures?: string[];
}

function pathAtEnd(script: string): string {
  const match = script.match(/'([^']*)'$/);
  assert.ok(match, `expected a quoted path in: ${script}`);
  return match[1];
}

function makeHarness(scenario: Scenario = {}) {
  const choices = [...(scenario.choices ?? [])];
  const inputs = [...(scenario.inputs ?? [])];
  const notifications: Array<{ message: string; tone?: string }> = [];
  const menus: Array<{ title: string; labels: string[] }> = [];
  const scripts: string[] = [];
  const home = scenario.home ?? "/home/user";
  const validDirectories = new Set(scenario.validDirectories ?? []);
  const listFailures = new Set(scenario.listFailures ?? []);
  const testFailures = new Set(scenario.testFailures ?? []);

  const ctx = {
    ui: {
      notify(message: string, tone?: string) { notifications.push({ message, tone }); },
      async input() { return inputs.shift(); },
    },
  };

  const deps = {
    shellLiteral,
    shellTest,
    async selectLabeledOption(
      _ctx: unknown,
      title: string,
      items: readonly { label: string; value: string }[],
    ) {
      menus.push({ title, labels: items.map((item) => item.label) });
      const choice = choices.shift();
      if (choice !== undefined) {
        assert.ok(items.some((item) => item.value === choice), `missing choice ${choice}`);
      }
      return choice;
    },
    async sshExec(_target: unknown, script: string) {
      scripts.push(script);
      if (script === 'printf %s "$HOME"') return { stdout: Buffer.from(home) };
      if (script.startsWith("LC_ALL=C ls -1Ap -- ")) {
        const path = pathAtEnd(script);
        if (listFailures.has(path)) throw new TransportError(`ls failed: ${path}`);
        return { stdout: Buffer.from(scenario.listings?.[path] ?? "") };
      }
      if (script.startsWith("test -d ")) {
        const path = pathAtEnd(script);
        if (testFailures.has(path) || !validDirectories.has(path)) {
          throw new TransportError(`test failed: ${path}`);
        }
        return { stdout: Buffer.alloc(0) };
      }
      throw new Error(`Unexpected SSH command: ${script}`);
    },
  };

  return { ctx, deps, notifications, menus, scripts };
}

test("browses remote directories and selects the current path", async () => {
  const harness = makeHarness({
    choices: ["Projects", "__select__"],
    listings: {
      "/home/user": "file.txt\r\n.Hidden/\r\nProjects/\r\n",
      "/home/user/Projects": "src/\n",
    },
    validDirectories: ["/home/user/Projects"],
  });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);

  assert.equal(result?.workspace, "/home/user/Projects");
  assert.ok(harness.menus[0]?.labels.includes(".Hidden/"));
  assert.ok(harness.menus[0]?.labels.includes("Projects/"));
  assert.ok(!harness.menus[0]?.labels.includes("file.txt"));
  assert.ok(harness.scripts.some((script) => script.startsWith("LC_ALL=C ls -1Ap -- ")));
});

test("navigates to the parent directory", async () => {
  const harness = makeHarness({
    choices: ["__up__", "__select__"],
    listings: { "/home/user": "Projects/\n", "/home": "user/\n" },
    validDirectories: ["/home"],
  });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);
  assert.equal(result?.workspace, "/home");
});

test("accepts a manually entered absolute directory", async () => {
  const harness = makeHarness({
    choices: ["__manual__"],
    inputs: ["/srv/project"],
    validDirectories: ["/srv/project"],
  });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);
  assert.equal(result?.workspace, "/srv/project");
  assert.deepEqual(harness.notifications, []);
});

test("returns to the browser when manual input is cancelled", async () => {
  const harness = makeHarness({ choices: ["__manual__", "__cancel__"], inputs: [undefined] });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);
  assert.equal(result, undefined);
  assert.deepEqual(harness.notifications, []);
  assert.equal(harness.menus.length, 2);
});

test("warns for a relative manual path and keeps browsing", async () => {
  const harness = makeHarness({ choices: ["__manual__", "__cancel__"], inputs: ["relative/path"] });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);
  assert.equal(result, undefined);
  assert.ok(harness.notifications.some(({ message, tone }) =>
    tone === "warning" && message.includes("Relative paths are not allowed")));
});

test("reports directory listing failures without closing the browser", async () => {
  const harness = makeHarness({ choices: ["__cancel__"], listFailures: ["/home/user"] });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);
  assert.equal(result, undefined);
  assert.ok(harness.notifications.some(({ message, tone }) =>
    tone === "warning" && message.includes("Could not list directory")));
});

test("reports invalid current and child directories and keeps browsing", async () => {
  const current = makeHarness({
    choices: ["__select__", "__cancel__"],
    testFailures: ["/home/user"],
  });
  assert.equal(await chooseWorkspace(current.ctx, { alias: "host" }, current.deps), undefined);
  assert.ok(current.notifications.some(({ message }) => message.includes("Could not select directory")));

  const child = makeHarness({
    choices: ["Projects", "__cancel__"],
    listings: { "/home/user": "Projects/\n" },
    testFailures: ["/home/user/Projects"],
  });
  assert.equal(await chooseWorkspace(child.ctx, { alias: "host" }, child.deps), undefined);
  assert.ok(child.notifications.some(({ message }) => message.includes("is not a directory")));
});

test("escape cancellation returns without another browser iteration", async () => {
  const harness = makeHarness({ choices: [undefined] });

  const result = await chooseWorkspace(harness.ctx, { alias: "host" }, harness.deps);
  assert.equal(result, undefined);
  assert.equal(harness.menus.length, 1);
});
