import { GoogleGenAI } from "@google/genai";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PROVIDER = "google-antigravity";
const GOOGLE_PROVIDER = "google";
const DEFAULT_GOOGLE_GENAI_MODEL = "gemini-2.5-flash";
const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  DEFAULT_ENDPOINT,
] as const;
const DEFAULT_ANTIGRAVITY_VERSION = "1.21.9";

function getRuntimePlatformDescriptor(): string {
  const platform = typeof process !== "undefined" ? process.platform : undefined;
  const arch = typeof process !== "undefined" ? process.arch : undefined;
  return `${platform || "unknown"}/${arch || "unknown"}`;
}

function getRuntimeNodeClientDescriptor(): string {
  const nodeVersion = typeof process !== "undefined" ? process.versions?.node : undefined;
  return `gl-node/${nodeVersion || "unknown"}`;
}

function getAntigravityHeaders() {
  return {
    "User-Agent": `antigravity/${process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION} ${getRuntimePlatformDescriptor()}`,
    "X-Goog-Api-Client": getRuntimeNodeClientDescriptor(),
    "Client-Metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };
}

interface ParsedCredentials {
  accessToken: string;
  projectId: string;
}

interface GoogleGenAIConfig {
  apiKey?: string;
  vertexai?: true;
  project?: string;
  location?: string;
  apiVersion?: string;
}

interface ApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      metadata?: Record<string, string>;
    }>;
  };
}

function parseOAuthCredentials(raw: string): ParsedCredentials {
  let parsed: { token?: string; projectId?: string };
  try {
    parsed = JSON.parse(raw) as { token?: string; projectId?: string };
  } catch {
    throw new Error("Invalid Google OAuth credentials. Run /login to re-authenticate.");
  }
  if (!parsed.token || !parsed.projectId) {
    throw new Error("Missing token or projectId in Google OAuth credentials. Run /login.");
  }
  return { accessToken: parsed.token, projectId: parsed.projectId };
}

async function getCredentials(ctx: any): Promise<ParsedCredentials> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
  if (!apiKey) {
    throw new Error("Missing Google Antigravity OAuth credentials. Run /login for google-antigravity.");
  }
  return parseOAuthCredentials(apiKey);
}

async function getGoogleGenAIConfig(ctx: any): Promise<GoogleGenAIConfig | undefined> {
  const configuredApiKey = await ctx.modelRegistry.getApiKeyForProvider?.(GOOGLE_PROVIDER);
  const apiKey = configuredApiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  const apiVersion = process.env.GOOGLE_GENAI_API_VERSION;

  if (apiKey) {
    return {
      apiKey,
      ...(apiVersion ? { apiVersion } : {}),
    };
  }

  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION;
    if (project && location) {
      return {
        vertexai: true,
        project,
        location,
        ...(apiVersion ? { apiVersion } : {}),
      };
    }
  }

  return undefined;
}

function parseApiErrorBody(raw: string): ApiErrorBody | undefined {
  try {
    return JSON.parse(raw) as ApiErrorBody;
  } catch {
    return undefined;
  }
}

function extractServiceDisabledHint(raw: string) {
  const parsed = parseApiErrorBody(raw);
  const details = parsed?.error?.details || [];

  for (const detail of details) {
    const metadata = detail.metadata;
    if (metadata?.service && metadata?.activationUrl) {
      return `Service ${metadata.service} appears disabled for project ${metadata.containerInfo || metadata.consumer || "unknown"}. Enable it at ${metadata.activationUrl}`;
    }
  }

  return undefined;
}

function buildSearchError(status: number, raw: string) {
  const parsed = parseApiErrorBody(raw);
  const message = parsed?.error?.message?.trim();
  const errorStatus = parsed?.error?.status?.trim();
  const serviceHint = extractServiceDisabledHint(raw);

  if (status === 401) {
    return new Error(
      message
        ? `Google web search authentication failed: ${message} Run /login for google-antigravity.`
        : "Google web search authentication failed. Run /login for google-antigravity.",
    );
  }

  if (status === 403) {
    if (message?.includes("restricted from using Gemini Code Assist for individuals in your organization")) {
      return new Error(
        "Google web search is blocked for this Google account or organization. Use /login for google-antigravity with an account that has Gemini Code Assist access.",
      );
    }

    if (serviceHint) {
      return new Error(`Google web search permission denied: ${message || "required Google API is disabled."} ${serviceHint}`);
    }

    return new Error(
      message
        ? `Google web search permission denied: ${message}`
        : "Google web search permission denied for the current account.",
    );
  }

  if (message) {
    return new Error(`Search request failed (${status}${errorStatus ? ` ${errorStatus}` : ""}): ${message}`);
  }

  return new Error(`Search request failed (${status}): ${raw}`);
}

function appendGoogleGenAISetupHint(message: string, hasGoogleGenAIConfig: boolean) {
  if (hasGoogleGenAIConfig) return message;
  return `${message}\n\nYou can also configure a standard Google GenAI backend with one of: provider \"google\", GOOGLE_API_KEY, GEMINI_API_KEY, or Vertex AI env vars (GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION).`;
}

function appendUrlCitations(text: string, annotations: any[] | undefined) {
  if (!annotations || annotations.length === 0) {
    return { text, sources: [] as string[] };
  }

  const sources: string[] = [];
  const sourceNumbers = new Map<string, number>();
  const insertions: Array<{ index: number; marker: string }> = [];

  for (const annotation of annotations) {
    if (annotation?.type !== "url_citation" || !annotation.url) continue;
    const key = annotation.url;
    let number = sourceNumbers.get(key);
    if (!number) {
      number = sourceNumbers.size + 1;
      sourceNumbers.set(key, number);
      sources.push(`[${number}] ${annotation.title || annotation.url} (${annotation.url})`);
    }
    if (typeof annotation.end_index === "number") {
      insertions.push({ index: annotation.end_index, marker: `[${number}]` });
    }
  }

  if (insertions.length === 0) {
    return { text, sources };
  }

  insertions.sort((a, b) => b.index - a.index);
  let nextText = text;
  for (const insertion of insertions) {
    const pos = Math.max(0, Math.min(insertion.index, nextText.length));
    nextText = `${nextText.slice(0, pos)}${insertion.marker}${nextText.slice(pos)}`;
  }

  return { text: nextText, sources };
}

async function searchWithGoogleGenAI(config: GoogleGenAIConfig, query: string, onUpdate?: Function) {
  onUpdate?.({
    content: [{ type: "text", text: `Searching the web with Google GenAI for: "${query}"...` }],
    details: { query, backend: "google-genai" }
  });

  const ai = new GoogleGenAI(config);
  const interaction = await ai.interactions.create({
    model: process.env.PI_GOOGLE_WEB_SEARCH_MODEL || DEFAULT_GOOGLE_GENAI_MODEL,
    input: query,
    tools: [{ type: "google_search" }],
  } as any);

  const textBlocks = (interaction?.outputs || []).filter((output: any) => output?.type === "text" && output?.text);
  const fullText = textBlocks.map((output: any) => output.text).join("\n\n").trim();
  const sourcesMap = new Map<string, string>();
  const parts: string[] = [];

  for (const block of textBlocks) {
    const { text, sources } = appendUrlCitations(block.text, block.annotations);
    if (text.trim()) parts.push(text);
    for (const source of sources) {
      const match = source.match(/^\[(\d+)\]\s+(.*)$/);
      if (match) {
        const key = match[2]!;
        if (!sourcesMap.has(key)) sourcesMap.set(key, source);
      } else if (!sourcesMap.has(source)) {
        sourcesMap.set(source, source);
      }
    }
  }

  let resultText = parts.join("\n\n").trim() || fullText || "No results found.";
  const sources = [...sourcesMap.values()];
  if (sources.length > 0) {
    resultText += "\n\nSources:\n" + sources.join("\n");
  }

  return {
    content: [{ type: "text", text: resultText }],
    details: { query, sourcesCount: sources.length, backend: "google-genai" }
  };
}

async function fetchSearchResponse(accessToken: string, requestBody: unknown, signal?: AbortSignal) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...getAntigravityHeaders(),
  };
  const body = JSON.stringify(requestBody);

  let lastResponse: Response | undefined;
  let lastErrorText = "";
  const failures: Array<{ url: string; status: number; body: string }> = [];

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal,
    });

    if (response.ok) {
      return response;
    }

    const errorText = await response.text();
    failures.push({ url, status: response.status, body: errorText });
    lastResponse = response;
    lastErrorText = errorText;

    if (response.status === 403 || response.status === 404) {
      continue;
    }

    throw buildSearchError(response.status, errorText);
  }

  if (!lastResponse) {
    throw new Error("Search request failed before a response was received.");
  }

  const orgRestriction = failures.find((failure) =>
    parseApiErrorBody(failure.body)?.error?.message?.includes("restricted from using Gemini Code Assist for individuals in your organization"),
  );
  const serviceDisabled = failures.find((failure) => extractServiceDisabledHint(failure.body));

  if (orgRestriction || serviceDisabled) {
    const notes: string[] = [];
    if (orgRestriction) {
      notes.push("Google web search is blocked for this Google account or organization. Use /login for google-antigravity with an account that has Gemini Code Assist access.");
    }
    if (serviceDisabled) {
      const hint = extractServiceDisabledHint(serviceDisabled.body);
      if (hint) notes.push(hint);
    }
    throw new Error(notes.join("\n"));
  }

  throw buildSearchError(lastResponse.status, lastErrorText);
}

export default function googleSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "google_web_search",
    label: "Search",
    description: "Performs a grounded Google Search to find information across the internet. Returns a synthesized answer with citations (e.g., [1]) and source URIs. Best for finding up-to-date documentation, troubleshooting obscure errors, or broad research.",
    parameters: Type.Object({
      query: Type.String({
        description: "The search query. Supports natural language questions (e.g., 'Latest breaking changes in React 19') or specific technical queries."
      })
    }),
    async execute(_toolCallId, params: { query: string }, signal, onUpdate, ctx) {
      const googleGenAIConfig = await getGoogleGenAIConfig(ctx);
      if (googleGenAIConfig) {
        try {
          return await searchWithGoogleGenAI(googleGenAIConfig, params.query, onUpdate);
        } catch {
          // Fall back to antigravity below.
        }
      }

      const { accessToken, projectId } = await getCredentials(ctx);
      
      onUpdate?.({
        content: [{ type: "text", text: `Searching the web for: "${params.query}"...` }],
        details: { query: params.query, backend: "google-antigravity" }
      });

      const requestBody = {
        project: projectId,
        model: "web-search",
        request: {
          contents: [{ role: "user", parts: [{ text: params.query }] }],
        },
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      };

      let response: Response;
      try {
        response = await fetchSearchResponse(accessToken, requestBody, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(appendGoogleGenAISetupHint(message, Boolean(googleGenAIConfig)));
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let groundingMetadata: any = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const chunk = JSON.parse(jsonStr);
              const candidate = chunk.response?.candidates?.[0];
              if (candidate) {
                const parts = candidate.content?.parts;
                if (parts) {
                  for (const part of parts) {
                    if (part.text) fullText += part.text;
                  }
                }
                if (candidate.groundingMetadata) {
                  groundingMetadata = candidate.groundingMetadata;
                }
              }
            } catch (e) {
              continue;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      let resultText = fullText;
      const sources: string[] = [];

      if (groundingMetadata) {
        const chunks = groundingMetadata.groundingChunks || [];
        const supports = groundingMetadata.groundingSupports || [];

        chunks.forEach((chunk: any, i: number) => {
          if (chunk.web) {
            sources.push(`[${i + 1}] ${chunk.web.title} (${chunk.web.uri})`);
          }
        });

        if (supports.length > 0) {
          const insertions: Array<{ index: number; marker: string }> = [];
          supports.forEach((support: any) => {
            if (support.segment && support.groundingChunkIndices) {
              const citationMarker = support.groundingChunkIndices
                .map((chunkIndex: number) => `[${chunkIndex + 1}]`)
                .join("");
              insertions.push({
                index: support.segment.endIndex,
                marker: citationMarker,
              });
            }
          });

          insertions.sort((a, b) => b.index - a.index);

          const encoder = new TextEncoder();
          const responseBytes = encoder.encode(resultText);
          const parts: Uint8Array[] = [];
          let lastIndex = responseBytes.length;
          
          for (const ins of insertions) {
            const pos = Math.min(ins.index, lastIndex);
            parts.unshift(responseBytes.subarray(pos, lastIndex));
            parts.unshift(encoder.encode(ins.marker));
            lastIndex = pos;
          }
          parts.unshift(responseBytes.subarray(0, lastIndex));

          const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
          const finalBytes = new Uint8Array(totalLength);
          let offset = 0;
          for (const part of parts) {
            finalBytes.set(part, offset);
            offset += part.length;
          }
          resultText = new TextDecoder().decode(finalBytes);
        }

        if (sources.length > 0) {
          resultText += "\n\nSources:\n" + sources.join("\n");
        }
      }

      if (!resultText.trim()) {
        resultText = "No results found.";
      }

      return {
        content: [{ type: "text", text: resultText }],
        details: { query: params.query, sourcesCount: sources.length, backend: "google-antigravity" }
      };
    }
  });
}
