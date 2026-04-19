// Run with: npx -y tsx --test agent/extensions/tests/google-search.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/google-search.ts");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");

async function loadExtension() {
  const piPackageDir = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-coding-agent");
  mkdirSync(piPackageDir, { recursive: true });
  writeFileSync(resolve(piPackageDir, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(piPackageDir, "index.js"), [
    "export function getAgentDir() {",
    "  return '';",
    "}",
  ].join("\n"));

  const typeboxPackageDir = resolve(STUB_PACKAGE_DIR, "@sinclair/typebox");
  mkdirSync(typeboxPackageDir, { recursive: true });
  writeFileSync(resolve(typeboxPackageDir, "package.json"), JSON.stringify({
    name: "@sinclair/typebox",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(typeboxPackageDir, "index.js"), [
    "export const Type = {",
    "  Object(properties) { return { type: 'object', properties }; },",
    "  String(options = {}) { return { type: 'string', ...options }; },",
    "};",
  ].join("\n"));

  const patchedExtensionPath = resolve("agent/extensions/.google-search.testable.ts");
  writeFileSync(patchedExtensionPath, readFileSync(EXTENSION_PATH, "utf8"));

  const moduleUrl = `${pathToFileURL(patchedExtensionPath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return mod.default as (pi: { registerTool: (tool: any) => void }) => void;
}

function createPiHarness() {
  let registeredTool: any;
  return {
    pi: {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    },
    getTool() {
      assert.ok(registeredTool, "Expected extension to register a tool");
      return registeredTool;
    },
  };
}

function createSseResponse(...events: any[]) {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("") + "\n";
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("google_web_search streams search results, adds citations, and lists sources", async () => {
  const extension = await loadExtension();
  const { pi, getTool } = createPiHarness();
  extension(pi as any);
  const tool = getTool();

  assert.equal(tool.name, "google_web_search");
  assert.equal(tool.label, "Search");

  const updates: any[] = [];
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return createSseResponse({
      response: {
        candidates: [{
          content: { parts: [{ text: "Hello world" }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: "Example", uri: "https://example.com" } },
              { web: { title: "Docs", uri: "https://docs.example.com" } },
            ],
            groundingSupports: [
              {
                segment: { endIndex: 5 },
                groundingChunkIndices: [0, 1],
              },
            ],
          },
        }],
      },
    });
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      "tool-call-1",
      { query: "test query" },
      undefined,
      (update: any) => updates.push(update),
      {
        modelRegistry: {
          async getApiKeyForProvider(provider: string) {
            assert.equal(provider, "google-antigravity");
            return JSON.stringify({ token: "access-token", projectId: "project-123" });
          },
        },
      },
    );

    assert.equal(updates.length, 1);
    assert.equal(updates[0].content[0].text, 'Searching the web for: "test query"...');
    assert.deepEqual(updates[0].details, { query: "test query" });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.url, "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    assert.equal(fetchCalls[0]!.init?.method, "POST");
    assert.match(String(fetchCalls[0]!.init?.headers && (fetchCalls[0]!.init!.headers as Record<string, string>).Authorization), /^Bearer access-token$/);

    const requestBody = JSON.parse(String(fetchCalls[0]!.init?.body));
    assert.equal(requestBody.project, "project-123");
    assert.equal(requestBody.model, "web-search");
    assert.equal(requestBody.request.contents[0].parts[0].text, "test query");

    assert.deepEqual(result, {
      content: [{
        type: "text",
        text: [
          "Hello[1][2] world",
          "",
          "Sources:",
          "[1] Example (https://example.com)",
          "[2] Docs (https://docs.example.com)",
        ].join("\n"),
      }],
      details: { query: "test query", sourcesCount: 2 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true });
  rmSync(resolve("agent/extensions/.google-search.testable.ts"), { force: true });
});
