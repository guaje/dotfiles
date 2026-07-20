import { RetrievalError } from "./errors.ts";

function isPrivateIpv4(host: string): boolean {
	const parts = host.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0);
}

function isPrivateIpv6(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.") || normalized.startsWith("::ffff:169.254.");
}

/** Validate URLs before handing them to a retrieval provider. The Pi process never fetches this URL itself. */
export function assertSafeRemoteUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new RetrievalError("Fetch URL must be a valid absolute HTTPS URL.", "validation");
	}
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new RetrievalError("Fetch URL must use http or https.", "validation");
	if (url.username || url.password) throw new RetrievalError("Fetch URL must not contain credentials.", "validation");
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal" || host.endsWith(".metadata.google.internal") || isPrivateIpv4(host) || isPrivateIpv6(host)) {
		throw new RetrievalError("Fetch URL must target a public remote host.", "validation");
	}
	return url;
}

export function assertBoundedString(value: unknown, name: string, maximum: number): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new RetrievalError(`${name} is required.`, "validation");
	if (value.length > maximum) throw new RetrievalError(`${name} exceeds the ${maximum}-character limit.`, "validation");
}

export function assertStructuredSchema(value: unknown): asserts value is Record<string, unknown> | undefined {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 10_000) throw new RetrievalError("structuredOutputSchema must be an object no larger than 10,000 characters.", "validation");
}

export function assertDomainList(value: unknown, name: string): asserts value is string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 20 || value.some((entry) => typeof entry !== "string" || !/^[a-z0-9.-]+$/i.test(entry) || entry.length > 253)) {
		throw new RetrievalError(`${name} must contain at most 20 domain names.`, "validation");
	}
}
