import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile as execFileCallback, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { dirname, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NotificationTarget = "macos" | "termux" | "tasker" | "unsupported";

type ExecFileLike = typeof execFileCallback;
type NotificationCommand = { command: string; args: string[]; fallback?: { command: string; args: string[] }; expectsReply?: boolean };

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PI_ICON_PATHS = [
  resolve(EXTENSION_DIR, "assets/pi-logo.png"),
  resolve(EXTENSION_DIR, "assets/pi-logo.svg"),
];
const PI_NOTIFICATION_TITLE = "Pi Coding Agent";
const PI_NOTIFICATION_GROUP = "pi-native-notify";
const TERMUX_NOTIFICATION_ICON = "code";
const TASKER_NOTIFICATION_ACTION = "works.earendil.pi.NOTIFY";
const PI_NOTIFICATION_ICON_FILE = "pi-logo.png";
const PI_NOTIFICATION_STATUS_ICON_FILE = "pi-logo-status.png";
const PREVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

  if (isTermux) {
    if (env.PI_NATIVE_NOTIFY_BACKEND?.toLowerCase() === "tasker") return "tasker";
    return "termux";
  }
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
  return PI_ICON_PATHS.find((iconPath) => existsSync(iconPath));
}

function getTermuxNotificationBody(body: string, subtitle?: string): string {
  const trimmedSubtitle = subtitle?.trim();
  if (!trimmedSubtitle) return body;
  return `${trimmedSubtitle}\n${body}`;
}

function realpathIfExists(path: string): string {
  if (!existsSync(path)) return path;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function cleanupOldNotificationPreviews(previewDir: string, now = Date.now()): void {
  try {
    for (const entry of readdirSync(previewDir)) {
      if (!entry.endsWith(".pi-notify-preview.png")) continue;
      const path = resolve(previewDir, entry);
      const stats = statSync(path);
      if (now - stats.mtimeMs > PREVIEW_RETENTION_MS) rmSync(path, { force: true });
    }
  } catch {
    // Preview cleanup is best-effort only.
  }
}

function getNotificationPreviewImagePath(imagePath: string, target: NotificationTarget, maxSize = 512): string {
  if (target !== "termux" && target !== "tasker") return imagePath;

  try {
    const input = readFileSync(imagePath);
    if (!input.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return imagePath;

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatChunks: Buffer[] = [];

    while (offset + 8 <= input.length) {
      const length = input.readUInt32BE(offset);
      const type = input.subarray(offset + 4, offset + 8).toString("ascii");
      const data = input.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8] ?? 0;
        colorType = data[9] ?? 0;
      } else if (type === "IDAT") {
        idatChunks.push(data);
      } else if (type === "IEND") break;
    }

    if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType)) return imagePath;
    const scale = Math.min(1, maxSize / Math.max(width, height));
    if (scale >= 1) return imagePath;

    const channels = colorType === 6 ? 4 : 3;
    const rowLength = width * channels;
    const inflated = inflateSync(Buffer.concat(idatChunks));
    const rgba = Buffer.alloc(width * height * 4);
    let sourceOffset = 0;
    let previous = Buffer.alloc(rowLength);

    for (let y = 0; y < height; y++) {
      const filter = inflated[sourceOffset++];
      const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + rowLength));
      sourceOffset += rowLength;
      for (let x = 0; x < rowLength; x++) {
        const left = x >= channels ? row[x - channels]! : 0;
        const above = previous[x] ?? 0;
        const upperLeft = x >= channels ? previous[x - channels]! : 0;
        if (filter === 1) row[x] = (row[x]! + left) & 0xff;
        else if (filter === 2) row[x] = (row[x]! + above) & 0xff;
        else if (filter === 3) row[x] = (row[x]! + Math.floor((left + above) / 2)) & 0xff;
        else if (filter === 4) row[x] = (row[x]! + paethPredictor(left, above, upperLeft)) & 0xff;
      }
      for (let x = 0; x < width; x++) {
        const source = x * channels;
        const target = (y * width + x) * 4;
        rgba[target] = row[source]!;
        rgba[target + 1] = row[source + 1]!;
        rgba[target + 2] = row[source + 2]!;
        rgba[target + 3] = channels === 4 ? row[source + 3]! : 255;
      }
      previous = row;
    }

    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));
    const previewRows: Buffer[] = [];
    for (let y = 0; y < previewHeight; y++) {
      const row = Buffer.alloc(1 + previewWidth * 4);
      const sourceY = Math.min(height - 1, Math.floor(y / scale));
      for (let x = 0; x < previewWidth; x++) {
        const sourceX = Math.min(width - 1, Math.floor(x / scale));
        rgba.copy(row, 1 + x * 4, (sourceY * width + sourceX) * 4, (sourceY * width + sourceX) * 4 + 4);
      }
      previewRows.push(row);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(previewWidth, 0);
    header.writeUInt32BE(previewHeight, 4);
    header[8] = 8;
    header[9] = 6;
    const output = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.concat(previewRows), { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    const extension = extname(imagePath) || ".png";
    const previewFileName = `${basename(imagePath, extension)}.pi-notify-preview.png`;
    const previewDir = resolve(dirname(imagePath), "previews");
    const previewPath = resolve(previewDir, previewFileName);
    mkdirSync(previewDir, { recursive: true });
    cleanupOldNotificationPreviews(previewDir);
    writeFileSync(previewPath, output);
    return realpathIfExists(previewPath);
  } catch {
    return imagePath;
  }
}

function getSharedStorageIconPath(fileName: string, env: EnvironmentLike = process.env): string | undefined {
  const home = env.HOME ?? process.env.HOME;
  if (!home) return undefined;

  const iconPath = resolve(home, "storage/shared/Pictures/pi", fileName);
  if (!existsSync(iconPath)) return undefined;
  return realpathIfExists(iconPath);
}

function getTaskerLargeIconPath(env: EnvironmentLike = process.env, fallbackIconPath = getPiIconPath()): string | undefined {
  return env.PI_NATIVE_NOTIFY_ICON_PATH
    || env.PI_NATIVE_NOTIFY_LARGE_ICON_PATH
    || getSharedStorageIconPath(PI_NOTIFICATION_ICON_FILE, env)
    || fallbackIconPath;
}

function getTaskerStatusIconPath(env: EnvironmentLike = process.env, fallbackIconPath = getTaskerLargeIconPath(env)): string | undefined {
  return env.PI_NATIVE_NOTIFY_STATUS_ICON_PATH
    || getSharedStorageIconPath(PI_NOTIFICATION_STATUS_ICON_FILE, env)
    || fallbackIconPath;
}

function getNativeNotificationIconPaths(
  target: NotificationTarget,
  env: EnvironmentLike = process.env,
  overrideIconPath?: string,
): { iconPath?: string; statusIconPath?: string } {
  if (target !== "tasker" && target !== "termux") return { iconPath: overrideIconPath ?? getPiIconPath() };
  const iconPath = overrideIconPath ?? getTaskerLargeIconPath(env);
  return { iconPath, statusIconPath: getTaskerStatusIconPath(env, iconPath) };
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

function getGeneratedImageNotificationId(imagePath: string): string {
  return `${PI_NOTIFICATION_GROUP}-image-${crc32(Buffer.from(imagePath)).toString(16)}`;
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
  if (target === "tasker") return getTaskerNotificationWarning();
  return undefined;
}

function getTermuxNotificationWarning(): string | undefined {
  if (detectNotificationTarget() !== "termux") return undefined;
  if (commandExists("am") || commandExists("termux-notification")) return undefined;
  return "Termux notifications require Tasker/AutoNotification via Android's am command, or the Termux:API fallback. Install Termux:API CLI tools with: pkg install termux-api";
}

function getTaskerNotificationWarning(): string | undefined {
  if (!commandExists("am")) return "Tasker notifications require Android's am command to broadcast intents.";
  return undefined;
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
  statusIconPath = iconPath,
  picturePath = "",
  generatedImagePath = picturePath,
  notificationId = PI_NOTIFICATION_GROUP,
): NotificationCommand | null {
  if (target === "termux" || target === "tasker") {
    const termuxArgs = [
      "-t", title,
      "-c", getTermuxNotificationBody(body, subtitle),
      "--group", PI_NOTIFICATION_GROUP,
      "--icon", TERMUX_NOTIFICATION_ICON,
    ];
    if (iconPath) termuxArgs.push("--image-path", iconPath);

    const taskerArgs = [
      "broadcast",
      "--user", "current",
      "-a", TASKER_NOTIFICATION_ACTION,
      "--es", "title", title,
      "--es", "subtitle", subtitle,
      "--es", "body", body,
      "--es", "content", getTermuxNotificationBody(body, subtitle),
      "--es", "group", PI_NOTIFICATION_GROUP,
      "--es", "notification_id", notificationId,
      "--es", "icon", iconPath ?? "",
      "--es", "status_icon", statusIconPath ?? "",
      "--es", "large_icon", iconPath ?? "",
      "--es", "image_path", iconPath ?? "",
    ];
    if (picturePath) {
      taskerArgs.push(
        "--es", "picture", picturePath,
        "--es", "pi_picture", picturePath,
        "--es", "generated_image_path", generatedImagePath,
      );
    }

    return {
      command: "am",
      args: taskerArgs,
      fallback: { command: "termux-notification", args: termuxArgs },
    };
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
    if (!terminalEntry) return undefined;
    if (!/"auth" => 0\b/.test(terminalEntry[0])) return undefined;
  } catch {
    return undefined;
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
  statusIconPath = iconPath,
  picturePath = "",
  generatedImagePath = picturePath,
  notificationId = PI_NOTIFICATION_GROUP,
): Promise<void> {
  const notificationCommand = getNotificationCommand(title, body, target, iconPath, subtitle, replyPlaceholder, statusIconPath, picturePath, generatedImagePath, notificationId);
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

  const notificationTimeout = notificationCommand.command === "am" ? 5000 : 1500;
  const result = await execFileQuiet(execFile, notificationCommand.command, notificationCommand.args, notificationTimeout);
  if (!result.error) {
    if (notificationCommand.expectsReply && onReply) {
      const reply = parseAlerterReply(result.stdout);
      if (reply) onReply(reply);
    }
    return;
  }

  if (notificationCommand.fallback) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const shouldUseFallback = notificationCommand.command !== "am"
      || errorCode === "ENOENT"
      || errorCode === "EACCES";
    if (shouldUseFallback) {
      await execFileQuiet(execFile, notificationCommand.fallback.command, notificationCommand.fallback.args);
    }
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
    const generatedImagePath = realpathIfExists(imagePath);
    await notifyPiWaitingForUser(options.body ?? `Image generated: ${imagePath}`, ctx, {
      ...options,
      picturePath: getNotificationPreviewImagePath(generatedImagePath, target),
      generatedImagePath,
      notificationId: getGeneratedImageNotificationId(generatedImagePath),
    });
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
    picturePath?: string;
    generatedImagePath?: string;
    notificationId?: string;
  } = {},
): Promise<void> {
  const execFile = options.execFile ?? execFileCallback;
  const subtitle = await getNotificationTitle({
    ctx,
    env: options.env,
    execFile,
    fallbackTitle: "Pi",
  });
  const { iconPath, statusIconPath } = getNativeNotificationIconPaths(
    options.target ?? detectNotificationTarget(options.env),
    options.env,
    options.iconPath,
  );
  await sendNativeNotification(
    options.title ?? PI_NOTIFICATION_TITLE,
    body,
    execFile,
    options.target ?? detectNotificationTarget(options.env),
    iconPath,
    subtitle,
    body === "Ready for input" ? "Type a follow-up…" : undefined,
    options.onReply,
    statusIconPath,
    options.picturePath,
    options.generatedImagePath ?? options.picturePath,
    options.notificationId,
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
