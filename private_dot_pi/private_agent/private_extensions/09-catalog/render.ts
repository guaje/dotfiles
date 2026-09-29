import path from "node:path";
import type { BenchmarkHealthState } from "../04-subagents/benchmark-types.ts";
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

const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

const MAX_RENDERED_POSIX_FRAGMENT = 48;

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Split a POSIX-quoted argument into short pieces. Adjacent quoted pieces are concatenated by the shell. */
function quotePosixShellArgumentFragments(value: string): string[] {
  const fragments: string[] = []; let current = "";
  for (const character of value) {
    const next = `${current}${character}`;
    if (current && quotePosixShellArgument(next).length > MAX_RENDERED_POSIX_FRAGMENT) {
      fragments.push(quotePosixShellArgument(current)); current = character;
    } else current = next;
  }
  if (current) fragments.push(quotePosixShellArgument(current));
  return fragments;
}

function appendPosixCommand(lines: string[], command: string, targetPaths: string[]): void {
  lines.push(`${command} -- \\`);
  for (const [targetIndex, targetPath] of targetPaths.entries()) {
    const fragments = quotePosixShellArgumentFragments(targetPath);
    for (const [fragmentIndex, fragment] of fragments.entries()) {
      const finalFragment = fragmentIndex === fragments.length - 1;
      // Continuation pieces must begin at column zero: indentation after a backslash-newline would become part of the argument.
      lines.push(`${fragmentIndex === 0 ? "  " : ""}${fragment}${finalFragment ? (targetIndex < targetPaths.length - 1 ? " \\" : "") : "\\"}`);
    }
  }
}

function isSafeArtifactTarget(targetPath: unknown): targetPath is string {
  return typeof targetPath === "string" && path.isAbsolute(targetPath) && !CONTROL_CHARACTER.test(targetPath);
}

export function renderCatalogSync(report: CatalogSyncReport, aaArtifacts?: AaArtifactChangeSummary, benchmarkHealth?: BenchmarkHealthState | null): string {
  const lines = ["Catalog sync completed"];
  for (const model of report.models) {
    lines.push("", `${model.id} [${model.source}]`, `  availability: ${model.available ? "available" : "unavailable"}`, `  pricing: ${model.cost ? `${model.cost.input} input / ${model.cost.output} output USD per 1M (${model.costProvenance})` : model.costProvenance === "ollama-cloud:price-unpublished" ? "unpublished (Ollama Cloud did not publish explicit numeric token pricing)" : "unresolved"}`);
    if (model.aaVariants.length) {
      lines.push("  AA variants:");
      for (const variant of model.aaVariants) lines.push(`    ${variant.thinkingLevel ?? "generic"}: ${variant.qualifiedProfiles.length ? variant.qualifiedProfiles.join(", ") : "no benchmark-qualified profiles"}${variant.substitutedProfiles?.length ? ` [fallback-substituted on AA data: ${variant.substitutedProfiles.join(", ")}]` : ""}`);
    } else lines.push("  AA: unresolved — no exact reviewed mapping");
  }
  if (report.missingAa.length) lines.push("", `AA mappings outstanding: ${report.missingAa.join(", ")} — /catalog sync offers interactive review for models with Artificial Analysis candidates.`);
  if (benchmarkHealth) {
    const concerns = Object.entries(benchmarkHealth.fields).filter(([, entry]) => entry && entry.status !== "active");
    if (concerns.length) {
      lines.push("", `AA benchmark coverage (assessed ${new Date(benchmarkHealth.generatedAt).toISOString().slice(0, 10)}):`);
      for (const [field, entry] of concerns) lines.push(`  ! ${field}: ${entry!.status} upstream (${entry!.scored}/${entry!.checked} recent releases scored${entry!.newestScoredRelease ? `, last ${entry!.newestScoredRelease}` : ""})`);
    }
  }
  if (aaArtifacts?.changes.length) {
    lines.push("", "AA artifact changes to track:");
    for (const change of aaArtifacts.changes) lines.push(`  ${change.kind} ${isSafeArtifactTarget(change.targetPath) && typeof change.path === "string" && !CONTROL_CHARACTER.test(change.path) ? change.path : "[unsafe path omitted]"}`);
    for (const warning of aaArtifacts.warnings) lines.push(`  ! ${CONTROL_CHARACTER.test(warning) ? "unsafe tracking warning omitted" : warning}`);

    const safeTargets = aaArtifacts.changes.every((change) => isSafeArtifactTarget(change.targetPath));
    if (safeTargets) {
      const additions = aaArtifacts.changes.filter((change) => change.kind !== "D").map((change) => change.targetPath);
      const deletions = aaArtifacts.changes.filter((change) => change.kind === "D").map((change) => change.targetPath);
      lines.push("");
      if ([...additions, ...deletions].some((targetPath) => quotePosixShellArgumentFragments(targetPath).length > 1)) lines.push("  Long artifact paths use shell-safe continuation fragments; copy the full command group unchanged.");
      if (deletions.length) lines.push("  `chezmoi forget` applies only to tracked deletions; use `chezmoi status` to filter it.");
      if (additions.length) appendPosixCommand(lines, "chezmoi add", additions);
      if (deletions.length) {
        if (additions.length) lines.push("");
        appendPosixCommand(lines, "chezmoi forget", deletions);
        lines.push("");
        appendPosixCommand(lines, "rm -f", deletions);
      }
    } else {
      lines.push("", "  ! Exact artifact commands omitted because a target path is unsafe or non-absolute.");
    }
    lines.push("", "Review with: chezmoi status");
  } else if (aaArtifacts?.warnings.length) {
    lines.push("", "AA artifact tracking warnings:");
    for (const warning of aaArtifacts.warnings) lines.push(`  ! ${warning}`);
  }
  lines.push("", "Next: run /model-health, then /reload (or start a new session).");
  return lines.join("\n");
}
