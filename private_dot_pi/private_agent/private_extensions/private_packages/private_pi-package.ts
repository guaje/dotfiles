import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const PI_PACKAGE_NAME = "@mariozechner/pi-coding-agent";

let piPackageRootPromise: Promise<string> | undefined;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function getPiPackageRoot(): Promise<string> {
  if (!piPackageRootPromise) {
    piPackageRootPromise = (async () => {
      const candidates: string[] = [];

      if (process.env.PI_CODING_AGENT_PACKAGE_ROOT) {
        candidates.push(process.env.PI_CODING_AGENT_PACKAGE_ROOT);
      }

      try {
        candidates.push(path.dirname(require.resolve(`${PI_PACKAGE_NAME}/package.json`)));
      } catch {
        // Ignore and continue through other candidates.
      }

      if (process.env.npm_config_prefix) {
        candidates.push(path.resolve(process.env.npm_config_prefix, "lib/node_modules", PI_PACKAGE_NAME));
      }

      try {
        const { stdout } = await execFile("npm", ["root", "-g"]);
        const globalNodeModules = stdout.trim();
        if (globalNodeModules) {
          candidates.push(path.resolve(globalNodeModules, PI_PACKAGE_NAME));
        }
      } catch {
        // Ignore and continue through other candidates.
      }

      for (const candidate of candidates) {
        if (await pathExists(path.resolve(candidate, "package.json"))) {
          return candidate;
        }
      }

      throw new Error(`Unable to resolve ${PI_PACKAGE_NAME} package root`);
    })();
  }

  return piPackageRootPromise;
}

export async function resolvePiPackagePath(relativePath = ""): Promise<string> {
  return path.resolve(await getPiPackageRoot(), relativePath);
}

export async function resolvePiBundledDependencyPath(packageName: string, relativePath = ""): Promise<string> {
  return path.resolve(await getPiPackageRoot(), "node_modules", packageName, relativePath);
}

export async function importPiModule(relativePath: string): Promise<any> {
  return import(pathToFileURL(await resolvePiPackagePath(relativePath)).href);
}
