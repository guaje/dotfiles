import { execFile as execFileCallback } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mergeScriptPath = path.resolve(__dirname, "../scripts/merge-settings.sh");
const settingsConfigPath = path.resolve(__dirname, "../settings.config.json");

async function mergeSettings(ctx: any) {
  try {
    await execFile(mergeScriptPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to merge settings: ${message}`, "error");
  }
}

export default function (pi: { on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => void }) {
  let watcher: FSWatcher | undefined;
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleMerge = (ctx: any) => {
    if (mergeTimer) clearTimeout(mergeTimer);
    mergeTimer = setTimeout(() => {
      mergeTimer = undefined;
      void mergeSettings(ctx);
    }, 50);
  };

  pi.on("session_start", async (_event, ctx) => {
    await mergeSettings(ctx);

    watcher?.close();
    watcher = watch(settingsConfigPath, () => {
      scheduleMerge(ctx);
    });
  });

  pi.on("session_shutdown", () => {
    if (mergeTimer) {
      clearTimeout(mergeTimer);
      mergeTimer = undefined;
    }
    watcher?.close();
    watcher = undefined;
  });
}
