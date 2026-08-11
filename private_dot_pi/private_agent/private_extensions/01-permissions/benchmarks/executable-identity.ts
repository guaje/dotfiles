// Run manually: npx -y tsx agent/extensions/01-permissions/benchmarks/executable-identity.ts --assert
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { verifyAutoAllowIdentity } from "../shell/executable-identity.ts";
import { parseShell } from "../shell/parser.ts";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "permissions-identity-benchmark-"));
  try {
    const cwd = join(root, "workspace");
    const bin = join(root, "bin");
    await mkdir(join(cwd, ".git"), { recursive: true });
    await mkdir(bin);
    const executable = join(bin, "nl");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    const analysis = parseShell("nl -ba fixture.txt");
    const dependencies = { env: { PATH: bin } };
    for (let index = 0; index < 10; index++) await verifyAutoAllowIdentity(analysis, cwd, dependencies);
    const samples: number[] = [];
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      const result = await verifyAutoAllowIdentity(analysis, cwd, dependencies);
      if (!result.ok) throw new Error(result.reason);
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.log(JSON.stringify({ samples: samples.length, p95Ms: Number(p95.toFixed(3)) }));
    if (process.argv.includes("--assert") && p95 > 25) throw new Error(`identity verification p95 ${p95.toFixed(3)}ms exceeds 25ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
