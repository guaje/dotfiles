// Run with: npx -y tsx --test agent/extensions/tests/stats.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/stats.ts");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const PI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@earendil-works/pi-coding-agent");
const PI_TUI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@earendil-works/pi-tui");

async function loadExtension() {
  mkdirSync(PI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_PACKAGE_DIR, "index.js"), "");

  mkdirSync(PI_TUI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_TUI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_TUI_PACKAGE_DIR, "index.js"), [
    "export const Key = { escape: 'escape', up: 'up', down: 'down', pageUp: 'pageUp', pageDown: 'pageDown', home: 'home', end: 'end', space: 'space', ctrl: (k) => `ctrl+${k}` };",
    "export function matchesKey(data, key) { return data === key || (key === 'escape' && data === '\\x1b') || (key === 'ctrl+c' && data === '\\x03'); }",
    "export function truncateToWidth(text, width) { return String(text).slice(0, Math.max(0, width)); }",
  ].join("\n"));

  const moduleUrl = `${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

test.after(() => {
  rmSync(PI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_TUI_PACKAGE_DIR, { recursive: true, force: true });
});

test("calculateUsageCost uses Pi's USD-per-1M-token formula including 1h cache writes", async () => {
  const mod = await loadExtension();
  const cost = mod.calculateUsageCost({
    input: 1_000_000,
    output: 500_000,
    cacheRead: 250_000,
    cacheWrite: 100_000,
    cacheWrite1h: 25_000,
  }, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 3 });
  // input 2 + output 3 + cacheRead 0.125 + cacheWrite short(75k*3/1M=.225) + long(25k*2*2/1M=.1)
  assert.equal(Number(cost.toFixed(3)), 5.45);
});

test("extractStats buckets assistant messages and recomputes notional cost from current model rates", async () => {
  const mod = await loadExtension();
  const rates = new Map([["prov/model-a", { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }]]);
  const entries = [
    { type: "message", message: { role: "assistant", provider: "prov", model: "model-a", usage: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 0, cost: { total: 0 } } } },
    { type: "message", message: { role: "assistant", provider: "prov", model: "model-a", usage: { input: 2_000, output: 250, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
  ];
  const summary = mod.extractStats(entries, rates);
  assert.equal(summary.main.length, 1);
  assert.equal(summary.main[0].model, "prov/model-a");
  assert.equal(summary.main[0].turns, 2);
  assert.equal(summary.main[0].input, 3_000);
  assert.equal(summary.main[0].output, 750);
  assert.ok(summary.main[0].cost > 0, "current rates should reprice zero-cost persisted usage");
  assert.equal(summary.hasCost, true);
  assert.equal(summary.hasNotionalCost, true);
});

test("extractStats collects subagent details, default model fallback, and failed rows", async () => {
  const mod = await loadExtension();
  const rates = new Map([["prov/child", { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 }]]);
  const entries = [
    { type: "model_change", provider: "prov", modelId: "parent", timestamp: "now" },
    { type: "message", message: { role: "toolResult", toolName: "other", details: { results: [{ agent: "ignored" }] } } },
    { type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [
      { agent: "scout", task: "look", model: "prov/child", modelSelector: "heuristic", thinkingLevel: "medium", exitCode: 0, usage: { input: 2_000, output: 1_000, cacheRead: 300, cacheWrite: 200, turns: 2, cost: 0 } },
      { agent: "worker", task: "do", exitCode: 1, stopReason: "error", usage: { input: 0, output: 0, turns: 0, cost: 0 } },
    ] } } },
  ];
  const summary = mod.extractStats(entries, rates);
  assert.equal(summary.modelChanges.length, 1);
  assert.equal(summary.subagents.length, 2);
  assert.equal(summary.subagents[0].model, "(default)", "subagents are sorted by model first");
  const scout = summary.subagents.find((row: any) => row.agent === "scout")!;
  const worker = summary.subagents.find((row: any) => row.agent === "worker")!;
  assert.equal(scout.model, "prov/child");
  assert.equal(scout.modelSelector, "heuristic");
  assert.equal(scout.thinkingLevel, "medium");
  assert.equal(scout.cacheRead + scout.cacheWrite, 500);
  assert.ok(scout.cost > 0);
  assert.equal(worker.model, "(default)");
  assert.equal(worker.failed, true);
});

test("formatStatsTable renders cost columns, notional footnote, and failed subagent marker", async () => {
  const mod = await loadExtension();
  const lines = mod.formatStatsTable({
    main: [{ model: "prov/model-a", turns: 1, input: 12_400, output: 2_100, cacheRead: 400, cacheWrite: 0, cost: 0.0123 }],
    subagents: [
      { agent: "planner", task: "plan", model: "prov/model-b", modelSelector: "heuristic", thinkingLevel: "medium", input: 1_000, output: 500, cacheRead: 100, cacheWrite: 25, turns: 1, cost: 0.01, failed: false },
      { agent: "reviewer", task: "review", model: "prov/model-b", modelSelector: "llm", thinkingLevel: "high", input: 6_200, output: 1_500, cacheRead: 200, cacheWrite: 75, turns: 3, cost: 0.03, failed: true },
      { agent: "scout", task: "scout", model: "prov/model-c", modelSelector: "explicit", thinkingLevel: "low", input: 2_000, output: 700, cacheRead: 0, cacheWrite: 0, turns: 2, cost: 0.02, failed: false },
    ],
    modelChanges: [],
    hasCost: true,
    hasNotionalCost: true,
  }, { fg: (_c: string, t: string) => t, bold: (t: string) => t });
  const table = lines.join("\n");
  assert.match(table, /Session stats/);
  assert.match(table, /Main session/);
  assert.match(table, /Subagents/);
  assert.match(table, /Cost/);
  assert.match(table, /Model\s+Agent\s+Think\s+Selector/, "subagent table puts Model first");
  assert.match(table, /Cache/, "subagent tables include cache tokens in rows and totals");
  assert.match(table, /12\.4K/);
  assert.match(table, /reviewer/);
  assert.match(table, /↳ prov\/model-b\s+Subtotal/);
  assert.match(table, /Subagents total/);
  assert.match(table, /Main \+ Subagents total/);
  assert.match(table, /✗/);
  assert.match(table, /notional commercial-equivalent/);
});

test("formatStatsTable uses distinct colors for title, subtotals, and totals", async () => {
  const mod = await loadExtension();
  const lines = mod.formatStatsTable({
    main: [{ model: "prov/model-a", turns: 1, input: 1_000, output: 500, cacheRead: 100, cacheWrite: 0, cost: 0.01 }],
    subagents: [
      { agent: "planner", task: "plan", model: "prov/model-b", modelSelector: "heuristic", thinkingLevel: "medium", input: 1_000, output: 500, cacheRead: 100, cacheWrite: 25, turns: 1, cost: 0.01, failed: false },
    ],
    modelChanges: [],
    hasCost: true,
    hasNotionalCost: true,
  }, {
    fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
    bold: (t: string) => `**${t}**`,
  });
  const table = lines.join("\n");
  assert.match(table, /<mdLink>\*\*Session stats\*\*<\/mdLink>/, "big title stays blue");
  assert.match(table, /<mdHeading>\*\*Main session\*\*<\/mdHeading>/, "section headings use a warm heading color");
  assert.match(table, /<muted>↳ prov\/model-b\s+Subtotal/, "per-model subagent subtotal stays darker/muted");
  assert.match(table, /<accent>\*\*Main session total/, "main total uses the same accent style as subagents total");
  assert.match(table, /<accent>\*\*Subagents total/, "subagents total uses the accent color");
  assert.match(table, /<accent>\*\*Main \+ Subagents total/, "final combined total uses the same accent total style");
  assert.match(table, /<thinkingText>medium\s+<\/thinkingText>/, "thinking column uses the same row style as neighboring label columns");
  assert.match(table, /<thinkingText>heuristic\s*<\/thinkingText>/, "selector column uses the same row style as neighboring label columns");
});

test("formatStatsTable omits cost when all costs are zero and renders empty state", async () => {
  const mod = await loadExtension();
  const table = mod.formatStatsTable({
    main: [{ model: "prov/model-a", turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 }],
    subagents: [],
    modelChanges: [],
    hasCost: false,
    hasNotionalCost: false,
  }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }).join("\n");
  assert.doesNotMatch(table, /Cost/);

  const empty = mod.formatStatsTable({ main: [], subagents: [], modelChanges: [], hasCost: false, hasNotionalCost: false }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }).join("\n");
  assert.match(empty, /No usage data available/);
});

test("StatsTableView clips long tables, scrolls, and closes with close keys", async () => {
  const mod = await loadExtension();
  const summary = {
    main: Array.from({ length: 30 }, (_v, i) => ({ model: `prov/model-${String(i).padStart(2, "0")}`, turns: 1, input: i, output: i, cacheRead: 0, cacheWrite: 0, cost: 0 })),
    subagents: [],
    modelChanges: [],
    hasCost: false,
    hasNotionalCost: false,
  };
  let closed = false;
  let renderRequests = 0;
  const view = new mod.StatsTableView(
    summary,
    { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    () => { closed = true; },
    () => { renderRequests += 1; },
  );

  const fullTable = mod.formatStatsTable(summary, { fg: (_c: string, t: string) => t, bold: (t: string) => t });
  const firstPage = view.render(80);
  assert.ok(firstPage.length < fullTable.length, "custom view clips long stats tables");
  assert.ok(firstPage.every((line: string) => line.length <= 80), "rendered lines are clipped to the view width");
  assert.match(firstPage.join("\n"), /q\/esc\/ctrl\+c close/);
  assert.doesNotMatch(firstPage.join("\n"), /model-29/);

  view.handleInput("end");
  const lastPage = view.render(80).join("\n");
  assert.equal(renderRequests, 1);
  assert.match(lastPage, /model-29/);

  view.handleInput("q");
  assert.equal(closed, true);
});

test("renderStatsTable uses notify fallback outside tui mode", async () => {
  const mod = await loadExtension();
  const notifications: Array<{ message: string; type?: string }> = [];
  await mod.renderStatsTable(
    { main: [], subagents: [], modelChanges: [], hasCost: false, hasNotionalCost: false },
    {
      mode: "print",
      ui: {
        notify: (message: string, type?: string) => notifications.push({ message, type }),
        custom: async () => { throw new Error("custom view should not be used outside tui mode"); },
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      },
    },
    {},
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "info");
  assert.match(notifications[0].message, /No usage data available/);
});

test("extension registers /stats and opens a stats custom view in tui mode without a message renderer", async () => {
  const mod = await loadExtension();
  const commands = new Map<string, any>();
  let registeredRenderer = false;
  let component: any;
  const pi: any = {
    registerMessageRenderer() { registeredRenderer = true; },
    registerCommand(name: string, spec: any) { commands.set(name, spec); },
    sendMessage: async () => { throw new Error("sendMessage should not be used for stats tui rendering"); },
  };
  mod.default(pi);
  assert.equal(registeredRenderer, false);
  assert.ok(commands.has("stats"));
  await commands.get("stats").handler("", {
    mode: "tui",
    ui: {
      notify: () => { throw new Error("notify should not be used in tui mode"); },
      custom: async (factory: any) => {
        component = await factory({ requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => {});
      },
    },
    sessionManager: { getBranch: () => [] },
  });
  assert.ok(component, "custom view component was created");
  assert.match(component.render(80).join("\n"), /No usage data available/);
});
