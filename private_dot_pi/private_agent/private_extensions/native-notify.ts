import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile as execFileCallback, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NotificationTarget = "macos" | "termux" | "unsupported";

type ExecFileLike = typeof execFileCallback;
type NotificationCommand = { command: string; args: string[]; fallback?: { command: string; args: string[] }; expectsReply?: boolean };

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PI_ICON_PATH = resolve(EXTENSION_DIR, "assets/pi-logo.svg");
const PI_NOTIFICATION_TITLE = "Pi Coding Agent";
const PI_NOTIFICATION_GROUP = "pi-native-notify";

export interface EnvironmentLike {
  ANDROID_DATA?: string;
  ANDROID_ROOT?: string;
  PREFIX?: string;
  TERMUX_VERSION?: string;
  TMUX?: string;
  [key: string]: string | undefined;
}

export interface NotificationContextLike {
  cwd?: string;
  sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error" | "success") => void };
  sessionManager?: {
    getCwd?: () => string;
    getSessionName?: () => string | undefined;
    getEntries?: () => Array<{
      type?: string;
      message?: {
        role?: string;
        content?: unknown;
      };
    }>;
  };
}

export function detectNotificationTarget(env: EnvironmentLike = process.env, platform = process.platform): NotificationTarget {
  const prefix = env.PREFIX ?? "";
  const isTermux = Boolean(
    env.TERMUX_VERSION ||
    prefix.includes("/com.termux/") ||
    prefix.endsWith("/com.termux/files/usr") ||
    (env.ANDROID_ROOT && env.ANDROID_DATA && prefix.includes("termux")),
  );

  if (isTermux) return "termux";
  if (platform === "darwin") return "macos";
  return "unsupported";
}

export function isTmuxSession(env: EnvironmentLike = process.env): boolean {
  return Boolean(env.TMUX);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

function execFileOutput(execFile: ExecFileLike, command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(String(stdout ?? "").trim());
    });
  });
}

export async function getTmuxSessionName(
  env: EnvironmentLike = process.env,
  execFile: ExecFileLike = execFileCallback,
): Promise<string | undefined> {
  if (!isTmuxSession(env)) return undefined;
  const sessionName = await execFileOutput(execFile, "tmux", ["display-message", "-p", "#S"]);
  return sessionName || undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function normalizeDescriptionText(text: string): string {
  return text
    .replace(/[`*_#>\[\](){}]/g, "")
    .replace(/\b(please|can you|could you|would you|let'?s)\b/gi, "")
    .replace(/\b(the|a|an|this|that|these|those|with|from|into|onto|about|when|then|than|and|or|but|for|to|of|in|on|at|by|is|are|was|were|be|been|being)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseWord(word: string): string {
  return word.replace(/^([a-z])/, (letter) => letter.toUpperCase());
}

function toTitleCase(text: string): string {
  return text
    .split(" ")
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

function compactDescription(text: string, maxLength = 34): string {
  const normalized = normalizeDescriptionText(text);
  if (!normalized) return "Pi";

  const words = normalized.split(" ").map(titleCaseWord);
  const selected: string[] = [];
  for (const word of words) {
    const next = [...selected, word].join(" ");
    if (selected.length > 0 && next.length > maxLength) break;
    selected.push(word);
    if (selected.length >= 6) break;
  }
  const phrase = selected.join(" ") || words[0] || "Pi";
  if (phrase.length <= maxLength) return phrase;
  return `${phrase.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function getUserMessageTexts(ctx?: NotificationContextLike): string[] {
  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  return entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
    .map((entry) => textFromContent(entry.message?.content))
    .map((text) => text.trim())
    .filter(Boolean);
}

function summarizeSessionTitle(ctx?: NotificationContextLike): string {
  const userMessages = getUserMessageTexts(ctx);
  if (userMessages.length === 0) return "";

  const recentMessages = userMessages.slice(-6);
  const scoredWords = new Map<string, { word: string; score: number; firstIndex: number }>();
  const stopWords = new Set(["trigger", "test", "command", "fix", "make", "get", "use", "using", "need", "needs", "every", "time", "again", "now", "last", "recently"]);
  let index = 0;

  for (const [messageIndex, message] of recentMessages.entries()) {
    const recency = messageIndex + 1;
    for (const rawWord of normalizeDescriptionText(message).split(" ")) {
      const word = rawWord.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if (word.length < 4 || stopWords.has(word)) continue;
      const key = word.endsWith("s") ? word.slice(0, -1) : word;
      const existing = scoredWords.get(key);
      const score = recency + Math.min(4, Math.floor(word.length / 3));
      if (existing) existing.score += score;
      else scoredWords.set(key, { word: rawWord, score, firstIndex: index });
      index++;
    }
  }

  const summaryWords = [...scoredWords.values()]
    .sort((a, b) => b.score - a.score || a.firstIndex - b.firstIndex)
    .slice(0, 4)
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ word }) => word);

  return toTitleCase(summaryWords.join(" "));
}

export function getSessionDescription(ctx?: NotificationContextLike): string {
  const sessionName = ctx?.sessionManager?.getSessionName?.()?.trim();
  if (sessionName) return compactDescription(sessionName);

  const sessionSummary = summarizeSessionTitle(ctx);
  if (sessionSummary) return compactDescription(sessionSummary);

  const cwd = ctx?.cwd || ctx?.sessionManager?.getCwd?.();
  if (cwd) return compactDescription(basename(cwd));

  return "Pi";
}

function isGenericTitle(title: string): boolean {
  return /^(pi|default|main|shell|terminal|term|tmux)$/i.test(title.trim());
}

export async function getNotificationTitle(options: {
  ctx?: NotificationContextLike;
  env?: EnvironmentLike;
  execFile?: ExecFileLike;
  fallbackTitle?: string;
} = {}): Promise<string> {
  const tmuxSessionName = await getTmuxSessionName(options.env, options.execFile);
  if (tmuxSessionName) {
    const tmuxTitle = compactDescription(tmuxSessionName);
    if (!isGenericTitle(tmuxTitle)) return tmuxTitle;
  }

  const description = getSessionDescription(options.ctx);
  if (description !== "Pi") return description;
  return tmuxSessionName || options.fallbackTitle || "Pi";
}

export function getPiIconPath(): string | undefined {
  return existsSync(PI_ICON_PATH) ? PI_ICON_PATH : undefined;
}

function commandExists(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
      stdio: "ignore",
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

function getMacOsAlerterInstallWarning(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  if (!commandExists("alerter")) return "alerter is not installed. Install it with: brew install vjeantet/tap/alerter";
  return undefined;
}

let didCheckNotificationReadiness = false;

export function checkNativeNotificationReadiness(
  target = detectNotificationTarget(),
): string | undefined {
  if (didCheckNotificationReadiness) return undefined;
  didCheckNotificationReadiness = true;

  if (target === "macos") {
    const installWarning = getMacOsAlerterInstallWarning();
    if (installWarning) return installWarning;
    return getMacOsTerminalNotificationWarning();
  }

  if (target === "termux") return getTermuxNotificationWarning();
  return undefined;
}

function getTermuxNotificationWarning(): string | undefined {
  if (detectNotificationTarget() !== "termux") return undefined;
  if (commandExists("termux-notification")) return undefined;
  return "Termux notifications require the Termux:API app and CLI tools. Install the app, then run: pkg install termux-api";
}

function getMacOsOsaScriptCommand(title: string, body: string, subtitle?: string) {
  const subtitleClause = subtitle ? ` subtitle ${appleScriptString(subtitle)}` : "";
  return {
    command: "osascript",
    args: ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}${subtitleClause}`],
  };
}

export function getNotificationCommand(
  title: string,
  body: string,
  target = detectNotificationTarget(),
  iconPath = getPiIconPath(),
  subtitle = "Pi",
  replyPlaceholder?: string,
): NotificationCommand | null {
  if (target === "termux") {
    const args = ["-t", title, "-c", body];
    if (iconPath) args.push("--image-path", iconPath);
    return { command: "termux-notification", args };
  }

  if (target === "macos") {
    const osascriptCommand = getMacOsOsaScriptCommand(title, body, subtitle);

    if (iconPath || replyPlaceholder) {
      const args = [
        "--title", title,
        "--subtitle", subtitle,
        "--message", body,
        ...(replyPlaceholder ? ["--reply", replyPlaceholder, "--json"] : []),
      ];
      if (iconPath) args.push("--app-icon", iconPath);
      args.push(
        "--group", PI_NOTIFICATION_GROUP,
        "--ignore-dnd",
      );

      return {
        command: "alerter",
        args,
        fallback: osascriptCommand,
        expectsReply: Boolean(replyPlaceholder),
      };
    }

    return osascriptCommand;
  }

  return null;
}

export function getMacOsTerminalNotificationWarning(): string | undefined {
  if (process.platform !== "darwin") return undefined;

  try {
    const output = execFileSync("plutil", ["-p", resolve(process.env.HOME ?? "", "Library/Preferences/com.apple.ncprefs.plist")], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const terminalEntry = output.match(/\{[^{}]*"bundle-id" => "com\.apple\.Terminal"[^{}]*\}/s);
    if (terminalEntry && !/"auth" => 0\b/.test(terminalEntry[0])) return undefined;
  } catch {
    // If settings cannot be read, fall through to a best-effort warning.
  }

  return "macOS notifications for Terminal are not enabled. Enable Settings > Notifications > Terminal for alerter notifications.";
}

function execFileQuiet(execFile: ExecFileLike, command: string, args: string[], timeout = 1500): Promise<{ error?: Error; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout }, (error, stdout) => {
      resolve({ error: error ?? undefined, stdout: String(stdout ?? "") });
    });
  });
}

function parseAlerterReply(stdout: string): string | undefined {
  const value = stdout.trim();
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as { activationValue?: unknown; activationType?: unknown };
    if (!String(parsed.activationType ?? "").toLowerCase().includes("repl")) return undefined;
    const reply = String(parsed.activationValue ?? "").trim();
    return reply || undefined;
  } catch {
    // Plain text mode fallback.
  }

  return value === "@closed" ? undefined : value;
}

export async function sendNativeNotification(
  title: string,
  body: string,
  execFile: ExecFileLike = execFileCallback,
  target = detectNotificationTarget(),
  iconPath = getPiIconPath(),
  subtitle = "Pi",
  replyPlaceholder?: string,
  onReply?: (reply: string) => void,
): Promise<void> {
  const notificationCommand = getNotificationCommand(title, body, target, iconPath, subtitle, replyPlaceholder);
  if (!notificationCommand) return;

  if (notificationCommand.command === "alerter" && execFile === execFileCallback) {
    const installWarning = getMacOsAlerterInstallWarning();
    if (installWarning) {
      if (notificationCommand.fallback) {
        await execFileQuiet(execFile, notificationCommand.fallback.command, notificationCommand.fallback.args);
      }
      return;
    }

    if (notificationCommand.expectsReply && onReply) {
      const child = spawn(notificationCommand.command, notificationCommand.args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      child.unref();
      child.stdout?.unref?.();
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.once("error", () => {
        if (notificationCommand.fallback) {
          execFileCallback(notificationCommand.fallback.command, notificationCommand.fallback.args, { windowsHide: true }, () => {});
        }
      });
      child.once("close", () => {
        const reply = parseAlerterReply(stdout);
        if (reply) onReply(reply);
      });
      return;
    }

    const child = spawn(notificationCommand.command, notificationCommand.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {
      if (notificationCommand.fallback) {
        execFileCallback(notificationCommand.fallback.command, notificationCommand.fallback.args, { windowsHide: true }, () => {});
      }
    });
    child.unref();
    return;
  }

  const result = await execFileQuiet(execFile, notificationCommand.command, notificationCommand.args);
  if (!result.error) {
    if (notificationCommand.expectsReply && onReply) {
      const reply = parseAlerterReply(result.stdout);
      if (reply) onReply(reply);
    }
    return;
  }

  if (notificationCommand.fallback) {
    await execFileQuiet(execFile, notificationCommand.fallback.command, notificationCommand.fallback.args);
  }
  // Ignore notification failures. Pi should never fail a turn because the OS notification API is unavailable.
}

export async function notifyGeneratedImage(
  imagePath: string,
  ctx?: NotificationContextLike,
  options: {
    body?: string;
    execFile?: ExecFileLike;
    target?: NotificationTarget;
    env?: EnvironmentLike;
    iconPath?: string;
  } = {},
): Promise<void> {
  const target = options.target ?? detectNotificationTarget(options.env);
  if (target !== "macos") {
    await notifyPiWaitingForUser(options.body ?? `Image generated: ${imagePath}`, ctx, options);
    return;
  }

  const execFile = options.execFile ?? execFileCallback;
  const subtitle = await getNotificationTitle({
    ctx,
    env: options.env,
    execFile,
    fallbackTitle: "Pi",
  });
  const iconPath = options.iconPath ?? getPiIconPath();
  const osascriptCommand = getMacOsOsaScriptCommand(PI_NOTIFICATION_TITLE, options.body ?? `Image generated: ${imagePath}`, subtitle);
  const args = [
    "--title", PI_NOTIFICATION_TITLE,
    "--subtitle", subtitle,
    "--message", options.body ?? "Image generated",
    "--content-image", imagePath,
    "--group", PI_NOTIFICATION_GROUP,
    "--ignore-dnd",
  ];
  if (iconPath) args.push("--app-icon", iconPath);

  if (execFile === execFileCallback) {
    const installWarning = getMacOsAlerterInstallWarning();
    if (installWarning) {
      await execFileQuiet(execFile, osascriptCommand.command, osascriptCommand.args);
      return;
    }

    const child = spawn("alerter", args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {
      execFileCallback(osascriptCommand.command, osascriptCommand.args, { windowsHide: true }, () => {});
    });
    child.unref();
    return;
  }

  const result = await execFileQuiet(execFile, "alerter", args);
  if (result.error) await execFileQuiet(execFile, osascriptCommand.command, osascriptCommand.args);
}

export async function notifyPiWaitingForUser(
  body = "Ready for input",
  ctx?: NotificationContextLike,
  options: {
    title?: string;
    execFile?: ExecFileLike;
    target?: NotificationTarget;
    env?: EnvironmentLike;
    iconPath?: string;
    onReply?: (reply: string) => void;
  } = {},
): Promise<void> {
  const execFile = options.execFile ?? execFileCallback;
  const subtitle = await getNotificationTitle({
    ctx,
    env: options.env,
    execFile,
    fallbackTitle: "Pi",
  });
  const iconPath = options.iconPath ?? getPiIconPath();
  await sendNativeNotification(
    options.title ?? PI_NOTIFICATION_TITLE,
    body,
    execFile,
    options.target ?? detectNotificationTarget(options.env),
    iconPath,
    subtitle,
    body === "Ready for input" ? "Type a follow-up…" : undefined,
    options.onReply,
  );
}

export function createNativeNotifyExtension(options: {
  execFile?: ExecFileLike;
  target?: NotificationTarget;
  title?: string;
  body?: string;
  env?: EnvironmentLike;
  iconPath?: string;
} = {}) {
  return function nativeNotifyExtension(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
      const warning = checkNativeNotificationReadiness(options.target ?? detectNotificationTarget(options.env));
      if (warning) ctx.ui?.notify?.(`Native notifications: ${warning}`, "warning");
    });

    pi.on("agent_end", (_event, ctx) => {
      void notifyPiWaitingForUser(options.body ?? "Ready for input", ctx, {
        ...options,
        onReply: (reply) => pi.sendUserMessage(reply, { deliverAs: "followUp" }),
      }).catch((error) => {
        console.warn(`native-notify: failed to send ready notification: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  };
}

export default createNativeNotifyExtension();
