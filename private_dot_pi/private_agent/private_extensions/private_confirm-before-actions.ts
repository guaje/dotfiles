import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

function summarizeWrite(content: string | undefined) {
  if (!content) return "";
  const lines = content.split("\n").length;
  const chars = content.length;
  return `\n\nNew content: ${lines} line${lines === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        "Allow bash command?",
        `Command:\n\n${event.input.command}`,
      );

      if (!ok) return { block: true, reason: "Bash command blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("write", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "File write blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        "Allow file write?",
        `Path:\n\n${event.input.path}${summarizeWrite(event.input.content)}`,
      );

      if (!ok) return { block: true, reason: "File write blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("edit", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "File edit blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        "Allow file edit?",
        `Path:\n\n${event.input.path}`,
      );

      if (!ok) return { block: true, reason: "File edit blocked by user" };
      return undefined;
    }

    return undefined;
  });
}
