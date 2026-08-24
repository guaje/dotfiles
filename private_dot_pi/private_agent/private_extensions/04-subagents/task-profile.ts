import type { RoutingProfile } from "./benchmark-types.ts";

const PROFILES = new Set<RoutingProfile>(["balanced", "coding", "agentic", "research", "planning", "review", "long-context"]);

/** Parse the closed, code-owned routing profile. Unknown and absent values are balanced. */
export function parseRoutingProfile(value: unknown): RoutingProfile {
	const profile = typeof value === "string" ? value.trim().toLowerCase() : "";
	return PROFILES.has(profile as RoutingProfile) ? (profile as RoutingProfile) : "balanced";
}
