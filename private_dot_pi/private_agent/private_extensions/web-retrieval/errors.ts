export type RetrievalErrorKind = "validation" | "config" | "auth" | "quota" | "rate-limit" | "network" | "timeout" | "transient" | "request" | "forbidden" | "cancelled" | "unknown";

export class RetrievalError extends Error {
	constructor(
		message: string,
		public readonly kind: RetrievalErrorKind,
		public readonly status?: number,
		public readonly provider?: string,
	) {
		super(message);
		this.name = "RetrievalError";
	}
}

export function isFallbackEligible(error: unknown): boolean {
	return error instanceof RetrievalError && ["quota", "rate-limit", "network", "timeout", "transient"].includes(error.kind);
}

export function redact(value: string, secrets: string[] = []): string {
	let output = value.replace(/(Bearer|api[_-]?key|token)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
	for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[REDACTED]");
	return output.replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function classifyHttpError(status: number, message: string, provider?: string): RetrievalError {
	if (status === 401) return new RetrievalError(message, "auth", status, provider);
	if (status === 429) return new RetrievalError(message, "rate-limit", status, provider);
	if (status === 402) return new RetrievalError(message, "quota", status, provider);
	if (status >= 500) return new RetrievalError(message, "transient", status, provider);
	if (status === 403) return new RetrievalError(message, "forbidden", status, provider);
	return new RetrievalError(message, "request", status, provider);
}
