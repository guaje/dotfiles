/* Manual benchmark: never invoke from CI. */
import { loadConfig } from "../config.ts";
import { retrieve } from "../router.ts";

async function main(): Promise<void> {
	if (process.env.CI) throw new Error("This credential-gated benchmark must not run in CI.");

	const config = await loadConfig();
	if (!config.providers.linkup?.apiKey || !config.providers.tavily?.apiKey) {
		throw new Error("Configure resolved Linkup and Tavily API keys in assets/web-retrieval.json or environment overrides to run the benchmark.");
	}
	const cases = [
		{ operation: "search" as const, query: "current official Node.js release", mode: "standard" as const },
		{ operation: "fetch" as const, url: "https://nodejs.org/en/about" },
		{ operation: "fetch" as const, url: "http://127.0.0.1/private" },
	];
	const measurements = [];
	for (const input of cases) for (const provider of ["linkup", "tavily"] as const) {
		const started = performance.now();
		try {
			const result = await retrieve({ ...input, provider } as any, config);
			measurements.push({ provider, operation: input.operation, latencyMs: Math.round(performance.now() - started), sources: result.sources.length, evidence: result.evidence.length, freshness: result.sources.filter((source) => source.publishedAt).length, bytes: JSON.stringify(result).length, degraded: result.degraded, failure: null });
		} catch (error) {
			measurements.push({ provider, operation: input.operation, latencyMs: Math.round(performance.now() - started), failure: error instanceof Error ? error.message : String(error) });
		}
	}
	console.log(JSON.stringify({ measuredAt: new Date().toISOString(), measurements }, null, 2));
}

void main();
