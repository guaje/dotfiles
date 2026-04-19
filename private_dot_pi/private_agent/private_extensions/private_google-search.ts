import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PROVIDER = "google-antigravity";
const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const DEFAULT_ANTIGRAVITY_VERSION = "1.21.9";

const ANTIGRAVITY_HEADERS = {
  "User-Agent": `antigravity/${process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION} darwin/arm64`,
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": JSON.stringify({
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  }),
};

interface ParsedCredentials {
  accessToken: string;
  projectId: string;
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
      const { accessToken, projectId } = await getCredentials(ctx);
      
      onUpdate?.({
        content: [{ type: "text", text: `Searching the web for: "${params.query}"...` }],
        details: { query: params.query }
      });

      const requestBody = {
        project: projectId,
        model: "web-search",
        request: {
          contents: [{ role: "user", parts: [{ text: params.query }] }],
        },
        requestType: "agent",
        userAgent: "antigravity",
      };

      const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...ANTIGRAVITY_HEADERS,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Search request failed (${response.status}): ${errorText}`);
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
        details: { query: params.query, sourcesCount: sources.length }
      };
    }
  });
}
