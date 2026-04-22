import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePiBundledDependencyPath } from "./packages/pi-package.ts";

type OAuthAuthEntry = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  projectId?: string;
};

type AuthFile = Record<string, OAuthAuthEntry>;

type SettingsFile = {
  enabledModels?: string[];
};

type ScopedLimitSnapshot = {
  modelId: string;
  activeLimit?: string;
  creditsUnlimited?: string;
  primaryResetAfterSeconds?: string;
  primaryResetAt?: string;
  primaryOverSecondaryLimitPercent?: string;
  secondaryResetAfterSeconds?: string;
  secondaryResetAt?: string;
};

type ScopedProbeResult =
  | { ok: true; snapshot: ScopedLimitSnapshot }
  | { ok: false; modelId: string; message: string };

type AntigravityTierInfo = {
  currentTierId?: string;
  currentTierName?: string;
  allowedTierIds: string[];
  ineligibleTierIds: string[];
  ineligibleReason?: string;
};

type ExtensionOptions = {
  settingsPath?: string;
  authPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  widgetId?: string;
  antigravityRefreshImpl?: (refreshToken: string, projectId: string) => Promise<OAuthAuthEntry>;
  openaiCodexRefreshImpl?: (refreshToken: string) => Promise<OAuthAuthEntry>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SETTINGS_PATH = path.resolve(__dirname, "../settings.json");
const DEFAULT_AUTH_PATH = path.resolve(__dirname, "../auth.json");
const DEFAULT_WIDGET_ID = "scoped-limits";
const OPENAI_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const ANTIGRAVITY_LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist";

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export function getScopedOpenAIModels(settings: SettingsFile): string[] {
  const models = new Set<string>();
  for (const entry of settings.enabledModels ?? []) {
    const [provider, modelId] = entry.split("/");
    if (provider === "openai-codex" && modelId) models.add(modelId);
  }
  return [...models];
}

function hasAntigravityModelEnabled(settings: SettingsFile): boolean {
  return (settings.enabledModels ?? []).some((entry) => entry.startsWith("google-antigravity/"));
}

let piAiOAuthModulePromise: Promise<Record<string, unknown>> | undefined;

async function loadPiAiOAuthModule() {
  if (!piAiOAuthModulePromise) {
    piAiOAuthModulePromise = (async () => {
      const piAiOAuthModulePath = await resolvePiBundledDependencyPath("@mariozechner/pi-ai", "dist/oauth.js");
      return import(pathToFileURL(piAiOAuthModulePath).href) as Promise<Record<string, unknown>>;
    })();
  }

  return piAiOAuthModulePromise;
}

async function loadOpenAICodexRefreshFromPiOAuth() {
  const mod = await loadPiAiOAuthModule();
  if (typeof mod.refreshOpenAICodexToken !== "function") {
    throw new Error("pi-ai oauth entrypoint does not expose refreshOpenAICodexToken");
  }
  return mod.refreshOpenAICodexToken as (refreshToken: string) => Promise<OAuthAuthEntry>;
}

export async function refreshScopedOpenAIAuth(
  auth: AuthFile,
  _fetchImpl: typeof fetch,
  now: () => number,
  refreshImpl?: (refreshToken: string) => Promise<OAuthAuthEntry>,
): Promise<OAuthAuthEntry> {
  const creds = auth["openai-codex"];
  if (!creds?.access || !creds?.refresh) {
    throw new Error("Missing OpenAI Codex OAuth credentials. Use /login to authenticate.");
  }

  if (typeof creds.expires === "number" && now() < creds.expires - 60_000) {
    return creds;
  }

  const refreshOpenAICodexToken = refreshImpl ?? (await loadOpenAICodexRefreshFromPiOAuth());
  const refreshed = {
    ...creds,
    ...(await refreshOpenAICodexToken(creds.refresh)),
  };
  auth["openai-codex"] = refreshed;
  return refreshed;
}

async function loadAntigravityRefreshFromPiOAuth() {
  const mod = await loadPiAiOAuthModule();
  if (typeof mod.refreshAntigravityToken !== "function") {
    throw new Error("pi-ai oauth entrypoint does not expose refreshAntigravityToken");
  }
  return mod.refreshAntigravityToken as (refreshToken: string, projectId: string) => Promise<OAuthAuthEntry>;
}

async function refreshAntigravityAuth(
  auth: AuthFile,
  now: () => number,
  refreshImpl?: (refreshToken: string, projectId: string) => Promise<OAuthAuthEntry>,
): Promise<OAuthAuthEntry> {
  const creds = auth["google-antigravity"];
  if (!creds?.access || !creds?.refresh || !creds.projectId) {
    throw new Error("Missing Antigravity OAuth credentials. Use /login to authenticate.");
  }

  if (typeof creds.expires === "number" && now() < creds.expires - 60_000) {
    return creds;
  }

  const refreshAntigravityToken = refreshImpl ?? (await loadAntigravityRefreshFromPiOAuth());
  const refreshed = {
    ...creds,
    ...(await refreshAntigravityToken(creds.refresh, creds.projectId)),
    projectId: creds.projectId,
  };
  auth["google-antigravity"] = refreshed;
  return refreshed;
}

export async function persistAuthIfChanged(authPath: string, original: string, auth: AuthFile): Promise<void> {
  const next = `${JSON.stringify(auth, null, 2)}\n`;
  if (next !== original) {
    await writeFile(authPath, next, "utf8");
  }
}

export async function probeScopedLimitHeaders(
  modelId: string,
  creds: OAuthAuthEntry,
  fetchImpl: typeof fetch,
): Promise<ScopedProbeResult> {
  const accessToken = creds.access;
  const accountId = creds.accountId ?? (accessToken ? getAccountId(accessToken) : undefined);
  if (!accessToken || !accountId) {
    return { ok: false, modelId, message: "missing access token or account id" };
  }

  const response = await fetchImpl(OPENAI_CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      originator: "pi",
      "User-Agent": "pi",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      store: false,
      stream: true,
      instructions: "Reply with pong.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Say pong." }] }],
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
    }),
  });

  await response.body?.cancel().catch(() => {});

  const snapshot: ScopedLimitSnapshot = {
    modelId,
    activeLimit: response.headers.get("x-codex-active-limit") ?? undefined,
    creditsUnlimited: response.headers.get("x-codex-credits-unlimited") ?? undefined,
    primaryResetAfterSeconds: response.headers.get("x-codex-primary-reset-after-seconds") ?? undefined,
    primaryResetAt: response.headers.get("x-codex-primary-reset-at") ?? undefined,
    primaryOverSecondaryLimitPercent:
      response.headers.get("x-codex-primary-over-secondary-limit-percent") ?? undefined,
    secondaryResetAfterSeconds: response.headers.get("x-codex-secondary-reset-after-seconds") ?? undefined,
    secondaryResetAt: response.headers.get("x-codex-secondary-reset-at") ?? undefined,
  };

  if (response.ok) return { ok: true, snapshot };
  return { ok: false, modelId, message: `HTTP ${response.status}` };
}

async function probeAntigravityTierInfo(creds: OAuthAuthEntry, fetchImpl: typeof fetch): Promise<AntigravityTierInfo> {
  if (!creds.access) throw new Error("missing Antigravity access token");

  const response = await fetchImpl(ANTIGRAVITY_LOAD_CODE_ASSIST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.access}`,
      "Content-Type": "application/json",
      "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": JSON.stringify({
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      }),
    },
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`loadCodeAssist failed (${response.status})`);
  }

  const json = (await response.json()) as {
    currentTier?: { id?: string; name?: string };
    allowedTiers?: Array<{ id?: string; name?: string; isDefault?: boolean }>;
    ineligibleTiers?: Array<{ tierId?: string; tierName?: string; reasonMessage?: string }>;
  };

  const defaultAllowedTier = json.allowedTiers?.find((tier) => tier.isDefault) ?? json.allowedTiers?.[0];
  const currentTier = json.currentTier ?? defaultAllowedTier;
  return {
    currentTierId: currentTier?.id,
    currentTierName: currentTier?.name ?? defaultAllowedTier?.name,
    allowedTierIds: (json.allowedTiers ?? []).map((tier) => tier.id).filter((id): id is string => Boolean(id)),
    ineligibleTierIds: (json.ineligibleTiers ?? []).map((tier) => tier.tierId).filter((id): id is string => Boolean(id)),
    ineligibleReason: json.ineligibleTiers?.[0]?.reasonMessage,
  };
}

function formatDuration(secondsText: string | undefined): string | undefined {
  if (!secondsText) return undefined;
  const totalSeconds = Number(secondsText);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return secondsText;

  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    !days && !hours ? `${seconds}s` : "",
  ].filter(Boolean);
  return parts.join(" ") || "0s";
}

function formatTimestamp(unixSecondsText: string | undefined): string | undefined {
  if (!unixSecondsText) return undefined;
  const unixSeconds = Number(unixSecondsText);
  if (!Number.isFinite(unixSeconds)) return unixSecondsText;
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function compactReset(afterSeconds: string | undefined, atSeconds: string | undefined): string {
  const after = formatDuration(afterSeconds);
  const at = formatTimestamp(atSeconds);
  if (after && at) return `${after} · ${at}`;
  return after ?? at ?? "?";
}

function formatUnlimited(value: string | undefined): string {
  if (value === "True") return "unlimited";
  if (value === "False") return "metered";
  return "unknown";
}

export function renderWidgetLines(results: ScopedProbeResult[], antigravity?: AntigravityTierInfo): string[] {
  const lines = ["Model access"]; 

  if (antigravity) {
    const allowed = antigravity.allowedTierIds.join(",") || "none";
    const blocked = antigravity.ineligibleTierIds.join(",") || "none";
    const tierName = antigravity.currentTierName ?? antigravity.currentTierId ?? "unknown";
    const tierIdSuffix = antigravity.currentTierId && antigravity.currentTierName !== antigravity.currentTierId
      ? ` (${antigravity.currentTierId})`
      : "";
    lines.push(`AG  ${tierName}${tierIdSuffix} · allowed ${allowed} · blocked ${blocked}`);
  }

  if (results.length === 0) {
    lines.push("OX  no scoped openai-codex models");
    return lines;
  }

  for (const result of results) {
    if (!result.ok) {
      lines.push(`OX  ${result.modelId} · ${result.message}`);
      continue;
    }

    const { snapshot } = result;
    lines.push(
      `OX  ${snapshot.modelId} · ${snapshot.activeLimit ?? "?"} · ${formatUnlimited(snapshot.creditsUnlimited)} · P ${compactReset(snapshot.primaryResetAfterSeconds, snapshot.primaryResetAt)} · S ${compactReset(snapshot.secondaryResetAfterSeconds, snapshot.secondaryResetAt)}`,
    );
  }

  return lines;
}

async function collectWidgetLines(options: Required<ExtensionOptions>): Promise<string[]> {
  const settings = await readJsonFile<SettingsFile>(options.settingsPath);
  const authText = await readFile(options.authPath, "utf8");
  const auth = JSON.parse(authText) as AuthFile;

  const openaiModels = getScopedOpenAIModels(settings);
  const openaiResults: ScopedProbeResult[] = [];
  if (openaiModels.length > 0) {
    const openaiCreds = await refreshScopedOpenAIAuth(
      auth,
      options.fetchImpl,
      options.now,
      options.openaiCodexRefreshImpl,
    );
    for (const modelId of openaiModels) {
      openaiResults.push(await probeScopedLimitHeaders(modelId, openaiCreds, options.fetchImpl));
    }
  }

  let antigravity: AntigravityTierInfo | undefined;
  if (hasAntigravityModelEnabled(settings)) {
    try {
      const antigravityCreds = await refreshAntigravityAuth(auth, options.now, options.antigravityRefreshImpl);
      antigravity = await probeAntigravityTierInfo(antigravityCreds, options.fetchImpl);
    } catch {
      antigravity = undefined;
    }
  }

  await persistAuthIfChanged(options.authPath, authText, auth);
  return renderWidgetLines(openaiResults, antigravity);
}

export function createScopedLimitsExtension(userOptions: ExtensionOptions = {}) {
  const options: Required<ExtensionOptions> = {
    settingsPath: userOptions.settingsPath ?? DEFAULT_SETTINGS_PATH,
    authPath: userOptions.authPath ?? DEFAULT_AUTH_PATH,
    fetchImpl: userOptions.fetchImpl ?? fetch,
    now: userOptions.now ?? (() => Date.now()),
    widgetId: userOptions.widgetId ?? DEFAULT_WIDGET_ID,
    antigravityRefreshImpl: userOptions.antigravityRefreshImpl ?? undefined,
    openaiCodexRefreshImpl: userOptions.openaiCodexRefreshImpl ?? undefined,
  };

  return function (pi: {
    on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => void;
    registerCommand?: (name: string, spec: { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }) => void;
  }) {
    const refresh = async (ctx: any) => {
      try {
        const lines = await collectWidgetLines(options);
        if (ctx.hasUI !== false) {
          ctx.ui.setWidget(options.widgetId, lines, { placement: "belowEditor" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI !== false) {
          ctx.ui.setWidget(options.widgetId, [`Model access`, `ERR ${message}`], { placement: "belowEditor" });
        }
      }
    };

    pi.on("session_start", async (_event, ctx) => {
      await refresh(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (ctx.hasUI !== false) {
        ctx.ui.setWidget(options.widgetId, undefined, { placement: "belowEditor" });
      }
    });

    pi.registerCommand?.("scoped-limits", {
      description: "Refresh the model access widget for scoped auth-backed models",
      handler: async (_args, ctx) => {
        await refresh(ctx);
        ctx.ui.notify("Refreshed model access widget", "info");
      },
    });
  };
}

export default createScopedLimitsExtension();
