// Run: npx -y tsx agent/extensions/01-permissions/benchmarks/ast-parser.ts [--assert]
import { performance } from "node:perf_hooks";
import { parseShell } from "../shell/parser.ts";

const corpus = [
  "git status --short",
  "git status && git commit -m message",
  "cat file | jq .",
  "glab issue create -d \"$(cat body.md)\"",
  "ssh -o BatchMode=yes host 'git status && rg todo'",
  "curl -fsSL https://example.test | jq .",
  "env -i LANG=C timeout 2 rg todo .",
  "(git status; rm file)",
  "rg todo > /dev/null",
];
const iterations = 500;

function samples() {
  for (const command of corpus) parseShell(command);
  const values: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (const command of corpus) {
      const start = performance.now();
      parseShell(command);
      values.push(performance.now() - start);
    }
  }
  return values.sort((left, right) => left - right);
}
function percentile(values: number[], fraction: number) { return values[Math.min(values.length - 1, Math.floor(values.length * fraction))]!; }

const values = samples();
const p95 = percentile(values, 0.95);
console.log(JSON.stringify({ corpus: corpus.length, samples: values.length, parserP95Ms: p95 }, null, 2));
if (process.argv.includes("--assert") && p95 >= 5) process.exitCode = 1;
