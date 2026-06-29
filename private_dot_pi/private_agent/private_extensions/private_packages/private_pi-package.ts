import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

let piPackageRootPromise: Promise<string> | undefined;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Distinguish the real installed package from a minimal test stub for the
 * require.resolve-discovered candidate. Extension tests materialise stub
 * packages into agent/extensions/node_modules/ (package.json with no
 * `version`) so bare specifiers resolve under tsx; jiti's createRequire-based
 * require.resolve can pick one up as the package root. A real npm install
 * always has a `version` field, so requiring it reliably filters stubs out
 * without depending on a specific install layout. Only the require.resolve
 * candidate is gated this way — env-var candidates (PI_PACKAGE_DIR,
 * PI_CODING_AGENT_PACKAGE_ROOT) are explicit intent and trusted as-is.
 */
async function isRealPackageRoot(dir: string): Promise<boolean> {
  const pkgJsonPath = path.resolve(dir, "package.json");
  if (!(await pathExists(pkgJsonPath))) return false;
  try {
    const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    return typeof pkg.version === "string" && pkg.version.length > 0;
  } catch {
    return false;
  }
}

export function getNpmGlobalPiPackageRoot(globalNodeModulesPath: string): string {
  return path.resolve(globalNodeModulesPath, PI_PACKAGE_NAME);
}

export function getPiPackageRootCandidatesFromExecutable(piExecutablePath: string): string[] {
  const installRoot = path.resolve(path.dirname(piExecutablePath), "..");
  return [
    path.resolve(installRoot, "libexec/lib/node_modules", PI_PACKAGE_NAME),
    path.resolve(installRoot, "lib/node_modules", PI_PACKAGE_NAME),
    path.resolve(installRoot, "node_modules", PI_PACKAGE_NAME),
    path.resolve(installRoot, PI_PACKAGE_NAME),
    installRoot,
  ];
}

export function getHomebrewPiPackageRootFromExecutable(piExecutablePath: string): string {
  return getPiPackageRootCandidatesFromExecutable(piExecutablePath)[0]!;
}

function addPiPackageRootCandidatesFromInstallRoot(candidates: string[], installRoot: string): void {
  candidates.push(
    path.resolve(installRoot, "libexec/lib/node_modules", PI_PACKAGE_NAME),
    path.resolve(installRoot, "lib/node_modules", PI_PACKAGE_NAME),
    path.resolve(installRoot, "node_modules", PI_PACKAGE_NAME),
    path.resolve(installRoot, PI_PACKAGE_NAME),
  );
}

export async function getPiPackageRoot(): Promise<string> {
  if (!piPackageRootPromise) {
    piPackageRootPromise = (async () => {
      const candidates: string[] = [];

      if (process.env.PI_PACKAGE_DIR) {
        candidates.push(process.env.PI_PACKAGE_DIR);
      }

      if (process.env.PI_CODING_AGENT_PACKAGE_ROOT) {
        candidates.push(process.env.PI_CODING_AGENT_PACKAGE_ROOT);
      }

      try {
        // require.resolve can land on a minimal test stub materialised
        // under agent/extensions/node_modules/ by extension tests (its
        // package.json has no `version`); skip those so we fall through to
        // the real install discovered via `which pi`/brew below.
        const resolved = path.dirname(require.resolve(`${PI_PACKAGE_NAME}/package.json`));
        if (await isRealPackageRoot(resolved)) {
          candidates.push(resolved);
        }
      } catch {
        // Ignore and continue through other candidates.
      }

      if (process.env.npm_config_prefix) {
        candidates.push(getNpmGlobalPiPackageRoot(path.resolve(process.env.npm_config_prefix, "lib/node_modules")));
      }

      try {
        const { stdout } = await execFile("npm", ["root", "-g"]);
        const globalNodeModules = stdout.trim();
        if (globalNodeModules) {
          candidates.push(getNpmGlobalPiPackageRoot(globalNodeModules));
        }
      } catch {
        // Ignore and continue through other candidates.
      }

      try {
        const { stdout } = await execFile("which", ["pi"]);
        const piExecutablePath = stdout.trim();
        if (piExecutablePath) {
          candidates.push(...getPiPackageRootCandidatesFromExecutable(await realpath(piExecutablePath)));
        }
      } catch {
        // Ignore and continue through other candidates.
      }

      try {
        const { stdout } = await execFile("brew", ["--prefix", "pi-coding-agent"]);
        const brewPackagePrefix = stdout.trim();
        if (brewPackagePrefix) {
          addPiPackageRootCandidatesFromInstallRoot(candidates, brewPackagePrefix);
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
