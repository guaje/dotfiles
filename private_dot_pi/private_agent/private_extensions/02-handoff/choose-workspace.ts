import { TransportError } from "./errors.ts";
import type { RemoteTarget } from "./types.ts";

export interface ChooseWorkspaceDeps {
  sshExec: (target: Omit<RemoteTarget, "workspace">, script: string) => Promise<{ stdout: Buffer }>;
  selectLabeledOption: (ctx: any, title: string, items: readonly { label: string; value: string }[]) => Promise<string | undefined>;
  shellLiteral: (value: string) => string;
  shellTest: (operator: "-d" | "-e" | "-r", value: string) => string;
}

export async function chooseWorkspace(
  ctx: any,
  target: Omit<RemoteTarget, "workspace">,
  deps: ChooseWorkspaceDeps,
): Promise<RemoteTarget | undefined> {
  const { sshExec, selectLabeledOption, shellLiteral, shellTest } = deps;

  const home = (await sshExec(target, 'printf %s "$HOME"')).stdout.toString().trim();
  let currentPath = home;

  while (true) {
    let entries: string[] = [];
    try {
      const result = await sshExec(target, `LC_ALL=C ls -1Ap -- ${shellLiteral(currentPath)}`);
      entries = result.stdout.toString().split(/\r?\n/).filter((entry) => entry.endsWith("/"));
    } catch (error) {
      const message = error instanceof TransportError ? error.message : String(error);
      ctx.ui?.notify?.(`Could not list directory: ${message}`, "warning");
    }

    const options = [
      { label: `Select current: ${currentPath}`, value: "__select__" },
      ...entries.map((e) => ({ label: e, value: e.endsWith("/") ? e.slice(0, -1) : e })),
      { label: "Go up", value: "__up__" },
      { label: "Enter a path…", value: "__manual__" },
      { label: "Cancel", value: "__cancel__" },
    ];

    const choice = await selectLabeledOption(ctx, `Remote workspace (browsing ${currentPath})`, options);
    if (!choice) return undefined;

    if (choice === "__select__") {
      if (!currentPath.startsWith("/") || currentPath.includes("\0")) {
        ctx.ui?.notify?.("Relative paths are not allowed. Please provide an absolute path.", "warning");
        continue;
      }
      try {
        await sshExec(target, shellTest("-d", currentPath));
        return { ...target, workspace: currentPath };
      } catch (error) {
        const message = error instanceof TransportError ? error.message : String(error);
        ctx.ui?.notify?.(`Could not select directory: ${message}`, "warning");
        continue;
      }
    }
    if (choice === "__cancel__") return undefined;
    if (choice === "__manual__") {
      const workspace = await ctx.ui.input("Remote workspace", currentPath);
      if (workspace === undefined) continue;
      if (!workspace || !workspace.startsWith("/") || workspace.includes("\0")) {
        ctx.ui?.notify?.("Relative paths are not allowed. Please provide an absolute path.", "warning");
        continue;
      }
      try {
        await sshExec(target, shellTest("-d", workspace));
        return { ...target, workspace };
      } catch {
        ctx.ui?.notify?.("Invalid remote directory path", "error");
        continue;
      }
    }
    if (choice === "__up__") {
      if (currentPath === "/") continue;
      const parts = currentPath.split("/").filter(Boolean);
      parts.pop();
      currentPath = "/" + parts.join("/");
      continue;
    }

    const fullPath = currentPath === "/" ? `/${choice}` : `${currentPath}/${choice}`;
    try {
      await sshExec(target, shellTest("-d", fullPath));
      currentPath = fullPath;
    } catch {
      ctx.ui?.notify?.(`'${choice}' is not a directory`, "warning");
    }
  }
}
