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
  writeFileSync(resolve(piPackageDir, "index.js"), "");

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

  const genaiPackageDir = resolve(STUB_PACKAGE_DIR, "@google/genai");
  mkdirSync(genaiPackageDir, { recursive: true });
  writeFileSync(resolve(genaiPackageDir, "package.json"), JSON.stringify({
    name: "@google/genai",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(genaiPackageDir, "index.js"), [
    "export class GoogleGenAI {",
    "  constructor(options) {",
    "    globalThis.__googleGenAIConstructorCalls ??= [];",
    "    globalThis.__googleGenAIConstructorCalls.push(options);",
    "    this.interactions = {",
    "      create: async (request) => {",
    "        if (typeof globalThis.__googleGenAICreate !== 'function') throw new Error('Missing __googleGenAICreate mock');",
    "        return globalThis.__googleGenAICreate(request, options);",
    "      },",
    "    };",
    "  }",
    "}",
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
  const originalAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
  const originalPackageVersion = process.env.npm_package_version;
  delete process.env.PI_AI_ANTIGRAVITY_VERSION;
  delete process.env.npm_package_version;

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
            if (provider === "google") return undefined;
            assert.equal(provider, "google-antigravity");
            return JSON.stringify({ token: "access-token", projectId: "project-123" });
          },
        },
      },
    );

    assert.equal(updates.length, 1);
    assert.equal(updates[0].content[0].text, 'Searching the web for: "test query"...');
    assert.deepEqual(updates[0].details, { query: "test query", backend: "google-antigravity" });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.url, "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    assert.equal(fetchCalls[0]!.init?.method, "POST");
    assert.match(String(fetchCalls[0]!.init?.headers && (fetchCalls[0]!.init!.headers as Record<string, string>).Authorization), /^Bearer access-token$/);
    assert.equal((fetchCalls[0]!.init!.headers as Record<string, string>)["X-Goog-Api-Client"], `gl-node/${process.versions.node}`);
    assert.equal(
      (fetchCalls[0]!.init!.headers as Record<string, string>)["User-Agent"],
      `antigravity/unknown ${process.platform}/${process.arch}`,
    );

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
      details: { query: "test query", sourcesCount: 2, backend: "google-antigravity" },
    });
  } finally {
    if (originalAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
    else process.env.PI_AI_ANTIGRAVITY_VERSION = originalAntigravityVersion;
    if (originalPackageVersion === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = originalPackageVersion;
    globalThis.fetch = originalFetch;
  }
});

test("google_web_search uses Google GenAI when standard Google credentials are configured", async () => {
  const extension = await loadExtension();
  const { pi, getTool } = createPiHarness();
  extension(pi as any);
  const tool = getTool();

  const originalFetch = globalThis.fetch;
  const constructorCalls: any[] = [];
  (globalThis as any).__googleGenAIConstructorCalls = constructorCalls;
  (globalThis as any).__googleGenAICreate = async (request: any, options: any) => {
    assert.equal(options.apiKey, "google-api-key");
    assert.equal(request.model, "test-google-model");
    assert.equal(request.input, "test query");
    assert.deepEqual(request.tools, [{ type: "google_search" }]);
    return {
      outputs: [{
        type: "text",
        text: "Gemini says hi",
        annotations: [{
          type: "url_citation",
          end_index: 6,
          title: "Example",
          url: "https://example.com",
        }],
      }],
    };
  };
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called for Google GenAI path");
  }) as typeof fetch;

  try {
    const updates: any[] = [];
    const result = await tool.execute(
      "tool-call-genai",
      { query: "test query" },
      undefined,
      (update: any) => updates.push(update),
      {
        model: { provider: "google", id: "test-google-model" },
        modelRegistry: {
          async getApiKeyForProvider(provider: string) {
            if (provider === "google") return "google-api-key";
            if (provider === "google-antigravity") return JSON.stringify({ token: "access-token", projectId: "project-123" });
            return undefined;
          },
        },
      },
    );

    assert.deepEqual(constructorCalls, [{ apiKey: "google-api-key" }]);
    assert.deepEqual(updates[0].details, { query: "test query", backend: "google-genai" });
    assert.deepEqual(result, {
      content: [{
        type: "text",
        text: [
          "Gemini[1] says hi",
          "",
          "Sources:",
          "[1] Example (https://example.com)",
        ].join("\n"),
      }],
      details: { query: "test query", sourcesCount: 1, backend: "google-genai" },
    });
  } finally {
    delete (globalThis as any).__googleGenAICreate;
    delete (globalThis as any).__googleGenAIConstructorCalls;
    globalThis.fetch = originalFetch;
  }
});

test("google_web_search falls back to alternate endpoints after a 403", async () => {
  const extension = await loadExtension();
  const { pi, getTool } = createPiHarness();
  extension(pi as any);
  const tool = getTool();

  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    if (fetchCalls.length < 3) {
      return new Response(JSON.stringify({
        error: {
          code: 403,
          message: "temporary permission issue on this endpoint",
          status: "PERMISSION_DENIED",
        },
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    return createSseResponse({
      response: {
        candidates: [{
          content: { parts: [{ text: "Fallback success" }] },
        }],
      },
    });
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      "tool-call-fallback",
      { query: "fallback query" },
      undefined,
      undefined,
      {
        modelRegistry: {
          async getApiKeyForProvider() {
            return JSON.stringify({ token: "access-token", projectId: "project-123" });
          },
        },
      },
    );

    assert.deepEqual(fetchCalls, [
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    ]);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "Fallback success" }],
      details: { query: "fallback query", sourcesCount: 0, backend: "google-antigravity" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("google_web_search shows an aggregated actionable message after fallback failures", async () => {
  const extension = await loadExtension();
  const { pi, getTool } = createPiHarness();
  extension(pi as any);
  const tool = getTool();

  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    if (fetchCalls.length === 2) {
      return new Response(JSON.stringify({
        error: {
          code: 403,
          message: "Gemini for Google Cloud API (Staging) has not been used in project rising-fact-p41fc before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [
            {
              metadata: {
                containerInfo: "rising-fact-p41fc",
                activationUrl: "https://console.developers.google.com/apis/api/staging-cloudaicompanion.sandbox.googleapis.com/overview?project=rising-fact-p41fc",
                service: "staging-cloudaicompanion.sandbox.googleapis.com",
              },
            },
          ],
        },
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      error: {
        code: 403,
        message: "You're restricted from using Gemini Code Assist for individuals in your organization. For more information, contact your administrator.",
        status: "PERMISSION_DENIED",
      },
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      tool.execute(
        "tool-call-2",
        { query: "blocked query" },
        undefined,
        undefined,
        {
          modelRegistry: {
            async getApiKeyForProvider() {
              return JSON.stringify({ token: "access-token", projectId: "project-123" });
            },
          },
        },
      ),
      /Google web search is blocked for this Google account or organization\. Use \/login for google-antigravity with an account that has Gemini Code Assist access\.[\s\S]*Service staging-cloudaicompanion\.sandbox\.googleapis\.com appears disabled for project rising-fact-p41fc\. Enable it at https:\/\/console\.developers\.google\.com\/apis\/api\/staging-cloudaicompanion\.sandbox\.googleapis\.com\/overview\?project=rising-fact-p41fc/,
    );
    assert.deepEqual(fetchCalls, [
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  delete (globalThis as any).__googleGenAICreate;
  delete (globalThis as any).__googleGenAIConstructorCalls;
  rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true });
  rmSync(resolve("agent/extensions/.google-search.testable.ts"), { force: true });
});
