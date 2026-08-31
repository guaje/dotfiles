import type { AaArtifactChangeSummary, CatalogSyncReport } from "./sync.ts";
import type { CatalogState } from "./types.ts";

export interface CatalogOverview {
  text: string;
  level: "info" | "warning";
}

export function renderCatalogOverview(
  state: CatalogState | null,
  enabledIds: Iterable<string>,
  runtimeAvailableIds: Iterable<string>,
): CatalogOverview {
  if (!state) {
    return {
      text: "Catalog unavailable: no validated last-known-good state. Run /catalog refresh or /catalog sync.",
      level: "warning",
    };
  }

  const customModels = state.providers.flatMap((provider) => provider.models);
  const available = [
    ...customModels.filter((model) => model.available ?? model.active),
    ...state.nativeModels.filter((model) => model.active && model.available !== false),
  ];
  const active = available.filter((model) => model.active).length;
  const unknownCosts = available.filter((model) => !model.cost).length;
  const providerLabel = state.providers.length === 1 ? "provider" : "providers";
  const summary = `Catalog: ${available.length} available models (${active} scoped) across ${state.providers.length} ${providerLabel}; ${unknownCosts} costs unknown; updated ${new Date(state.updatedAt).toISOString()}.`;

  const runtimeAvailable = new Set(runtimeAvailableIds);
  const customProviders = new Set(state.providers.map((provider) => provider.id));
  const missingRegistrations = [...enabledIds]
    .filter((id) => customProviders.has(id.split("/", 1)[0] ?? "") && !runtimeAvailable.has(id))
    .sort();
  const unknownActiveCosts = [
    ...state.providers.flatMap((provider) => provider.models
      .filter((model) => model.active && !model.cost)
      .map((model) => `${provider.id}/${model.id}`)),
    ...state.nativeModels.filter((model) => model.active && !model.cost).map((model) => model.id),
  ].sort();
  const issues = [
    missingRegistrations.length ? `missing registrations: ${missingRegistrations.join(", ")}` : "",
    unknownActiveCosts.length ? `unknown active costs: ${unknownActiveCosts.join(", ")}` : "",
  ].filter(Boolean);
  const health = issues.length
    ? `Catalog health: ${issues.join("; ")}.`
    : "Catalog health: all enabled catalog-managed custom models are registered and all active costs are known.";

  return { text: `${summary}\n${health}`, level: issues.length ? "warning" : "info" };
}

export function renderCatalogSync(report: CatalogSyncReport, aaArtifacts?: AaArtifactChangeSummary): string {
  const lines = ["Catalog sync completed"];
  for (const model of report.models) {
    lines.push("", `${model.id} [${model.source}]`, `  availability: ${model.available ? "available" : "unavailable"}`, `  pricing: ${model.cost ? `${model.cost.input} input / ${model.cost.output} output USD per 1M (${model.costProvenance})` : model.costProvenance === "ollama-cloud:price-unpublished" ? "unpublished (Ollama Cloud did not publish explicit numeric token pricing)" : "unresolved"}`);
    if (model.aaVariants.length) {
      lines.push("  AA variants:");
      for (const variant of model.aaVariants) lines.push(`    ${variant.thinkingLevel ?? "generic"}: ${variant.qualifiedProfiles.length ? variant.qualifiedProfiles.join(", ") : "no benchmark-qualified profiles"}`);
    } else lines.push("  AA: unresolved — no exact reviewed mapping");
  }
  if (aaArtifacts?.changes.length) {
    lines.push("", "AA artifact changes to track (relative to configured snapshot root):");
    for (const change of aaArtifacts.changes) lines.push(`  ${change.kind} ${change.path}`);
    for (const warning of aaArtifacts.warnings) lines.push(`  ! ${warning}`);
    lines.push("", "Review with: chezmoi status");
  } else if (aaArtifacts?.warnings.length) {
    lines.push("", "AA artifact tracking warnings:");
    for (const warning of aaArtifacts.warnings) lines.push(`  ! ${warning}`);
  }
  lines.push("", "Next: run /model-health, then /reload (or start a new session).");
  return lines.join("\n");
}
