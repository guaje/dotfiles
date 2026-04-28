// Run with: npx -y tsx --test agent/extensions/tests/scoped-limits.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/scoped-limits.ts");

async function loadModule() {
  const moduleUrl = `${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

function createTempFiles() {
  const dir = mkdtempSync(join(tmpdir(), "codex-limits-"));
  const settingsPath = join(dir, "settings.json");
  const authPath = join(dir, "auth.json");
  return { dir, settingsPath, authPath };
}

function createHarness() {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const widgets: Array<{ id: string; lines: string[] | undefined; options?: any }> = [];
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    pi: {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      registerCommand(name: string, spec: any) {
        commands.set(name, spec);
      },
    },
    ctx: {
      hasUI: true,
      ui: {
        setWidget(id: string, lines: string[] | undefined, options?: any) {
          widgets.push({ id, lines, options });
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
    getHandler(name: string) {
      assert.ok(handlers.has(name), `Expected handler for ${name}`);
      return handlers.get(name);
    },
    getCommand(name: string) {
      assert.ok(commands.has(name), `Expected command for ${name}`);
      return commands.get(name);
    },
    widgets,
    notifications,
  };
}

test("renders a compact widget with Antigravity tier info and Codex model resets", async () => {
  const mod = await loadModule();
  const { createScopedLimitsExtension } = mod;
  const { dir, settingsPath, authPath } = createTempFiles();

  writeFileSync(settingsPath, JSON.stringify({
    enabledModels: [
      "openai-codex/test-metered-model",
      "test-provider/non-scoped-model",
      "google-antigravity/test-antigravity-model",
      "openai-codex/test-unlimited-model",
    ],
  }, null, 2));
  writeFileSync(authPath, JSON.stringify({
    "openai-codex": {
      access: "header.payload.sig",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "acct_123",
    },
    "google-antigravity": {
      access: "ag-token",
      refresh: "ag-refresh",
      expires: Date.now() + 3_600_000,
      projectId: "proj-123",
    },
  }, null, 2));

  const fetchCalls: string[] = [];
  const fetchImpl = async (input: string | URL, init?: any) => {
    const url = String(input);
    fetchCalls.push(url);

    if (url.includes("loadCodeAssist")) {
      return new Response(JSON.stringify({
        allowedTiers: [{ id: "standard-tier", name: "Gemini Code Assist", isDefault: true }],
        ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "restricted" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const body = JSON.parse(String(init?.body));
    const model = body.model;
    const headers = new Headers({
      "x-codex-active-limit": "codex",
      "x-codex-credits-unlimited": model === "test-metered-model" ? "False" : "True",
      "x-codex-primary-reset-after-seconds": model === "test-metered-model" ? "120" : "7200",
      "x-codex-primary-reset-at": "1776732663",
      "x-codex-secondary-reset-after-seconds": "86400",
      "x-codex-secondary-reset-at": "1776959568",
    });
    return new Response("", { status: 200, headers });
  };

  const extension = createScopedLimitsExtension({ settingsPath, authPath, fetchImpl: fetchImpl as any });
  const harness = createHarness();
  extension(harness.pi as any);

  await harness.getHandler("session_start")({}, harness.ctx as any);

  assert.equal(harness.widgets.length, 1);
  const lines = harness.widgets[0]?.lines ?? [];
  assert.deepEqual(harness.widgets[0]?.options, { placement: "belowEditor" });
  assert.equal(harness.widgets[0]?.id, "scoped-limits");
  assert.equal(lines[0], "Model access");
  assert.match(lines[1] ?? "", /^AG  Gemini Code Assist \(standard-tier\) · allowed standard-tier · blocked free-tier$/);
  assert.match(lines[2] ?? "", /^OX  test-metered-model · codex · metered · P /);
  assert.match(lines[3] ?? "", /^OX  test-unlimited-model · codex · unlimited · P /);
  assert.doesNotMatch(lines.join("\n"), /test-provider/);

  assert.equal(fetchCalls.filter((url) => url.includes("codex/responses")).length, 2);
  assert.equal(fetchCalls.filter((url) => url.includes("loadCodeAssist")).length, 1);

  rmSync(dir, { recursive: true, force: true });
});

test("refreshes expired tokens and persists updated auth file", async () => {
  const mod = await loadModule();
  const { createScopedLimitsExtension } = mod;
  const { dir, settingsPath, authPath } = createTempFiles();

  writeFileSync(settingsPath, JSON.stringify({
    enabledModels: ["openai-codex/test-model", "google-antigravity/test-antigravity-model"],
  }, null, 2));
  writeFileSync(authPath, JSON.stringify({
    "openai-codex": {
      access: "old.payload.sig",
      refresh: "refresh-token",
      expires: 0,
    },
    "google-antigravity": {
      access: "old-ag-token",
      refresh: "ag-refresh-token",
      expires: 0,
      projectId: "proj-123",
    },
  }, null, 2));

  const base64url = (value: string) => Buffer.from(value).toString("base64url");
  const refreshedAccess = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_refreshed" } })),
    "sig",
  ].join(".");

  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    if (url.includes("loadCodeAssist")) {
      return new Response(JSON.stringify({
        allowedTiers: [{ id: "standard-tier", name: "Gemini Code Assist", isDefault: true }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response("", {
      status: 200,
      headers: {
        "x-codex-active-limit": "codex",
        "x-codex-credits-unlimited": "False",
      },
    });
  };

  const extension = createScopedLimitsExtension({
    settingsPath,
    authPath,
    fetchImpl: fetchImpl as any,
    now: () => 1000,
    openaiCodexRefreshImpl: async () => ({
      access: refreshedAccess,
      refresh: "refresh-token-2",
      expires: 1000 + 3600 * 1000,
      accountId: "acct_refreshed",
    }),
    antigravityRefreshImpl: async () => ({
      access: "ag-new-token",
      refresh: "ag-refresh-token-2",
      expires: 1000 + 3600 * 1000,
      projectId: "proj-123",
    }),
  });
  const harness = createHarness();
  extension(harness.pi as any);

  await harness.getHandler("session_start")({}, harness.ctx as any);

  const updatedAuth = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(updatedAuth["openai-codex"].access, refreshedAccess);
  assert.equal(updatedAuth["openai-codex"].refresh, "refresh-token-2");
  assert.equal(updatedAuth["openai-codex"].accountId, "acct_refreshed");
  assert.equal(updatedAuth["google-antigravity"].access, "ag-new-token");
  assert.equal(updatedAuth["google-antigravity"].refresh, "ag-refresh-token-2");

  rmSync(dir, { recursive: true, force: true });
});

test("registers refresh command and clears widget on shutdown", async () => {
  const mod = await loadModule();
  const { createScopedLimitsExtension } = mod;
  const { dir, settingsPath, authPath } = createTempFiles();

  writeFileSync(settingsPath, JSON.stringify({ enabledModels: [] }, null, 2));
  writeFileSync(authPath, JSON.stringify({}, null, 2));

  const extension = createScopedLimitsExtension({ settingsPath, authPath, fetchImpl: (globalThis.fetch as any) });
  const harness = createHarness();
  extension(harness.pi as any);

  await harness.getCommand("scoped-limits").handler("", harness.ctx as any);
  assert.deepEqual(harness.notifications, [{ message: "Refreshed model access widget", level: "info" }]);
  assert.deepEqual(harness.widgets[0]?.lines, ["Model access", "OX  no scoped openai-codex models"]);

  await harness.getHandler("session_shutdown")({}, harness.ctx as any);
  assert.deepEqual(harness.widgets.at(-1), {
    id: "scoped-limits",
    lines: undefined,
    options: { placement: "belowEditor" },
  });

  rmSync(dir, { recursive: true, force: true });
});
