// Run: npx -y tsx agent/extensions/01-permissions/benchmarks/session-approval-templates.ts [--assert]
import { execFile as execFileCallback } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { approvalCandidate } from "../shell/session-approval-candidate.ts";
import { inspectBash } from "../shell/policy.ts";

const execFile = promisify(execFileCallback);

async function main() {
  const iterations = 40;
  const root = await mkdtemp(join(tmpdir(), "permissions-template-benchmark-"));
  try {
    await execFile("git", ["init", "-q", root]);
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "one.test.ts"), "export {};\n");
    await writeFile(join(root, "file.txt"), "fixture\n");
    const corpus = [
      "git add file.txt",
      "git commit -m message",
      "npx -y tsx --test --test-concurrency=1 tests/*.test.ts",
      "rm file.txt",
      "touch new-file",
      "git frobnicate ./file.txt",
      "ssh -p 22 host 'rm file'",
    ];
    const values: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const command of corpus) {
        const inspection = inspectBash(command);
        const start = performance.now();
        await approvalCandidate(inspection, root);
        values.push(performance.now() - start);
      }
    }
    values.sort((left, right) => left - right);
    const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!;
    console.log(JSON.stringify({ corpus: corpus.length, samples: values.length, candidateP95Ms: p95 }, null, 2));
    if (process.argv.includes("--assert") && p95 >= 20) process.exitCode = 1;
  }
  finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
