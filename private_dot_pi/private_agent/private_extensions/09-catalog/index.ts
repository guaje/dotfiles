import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { persistReviewedReasoning, refreshCatalog, restoreCatalog } from "./catalog.ts";
import { renderCatalogOverview, renderCatalogSync } from "./render.ts";
import { loadCatalogSettings, loadEnabledModels } from "./provider-settings.ts";
import { loadCatalogState } from "./state.ts";
import { aaReviewThinkingLevelOptions, captureAaArtifactState, finalizeAaSync, hasGenericAaMapping, isCompleteAaCandidateReview, prepareAaCandidateReview, publishReviewedAaVariants, syncEnabledModels, type AaCandidate, type ReviewedAaVariant } from "./sync.ts";
import type { CatalogResult } from "./aa/client.ts";
import type { BenchmarkThinkingLevel } from "../04-subagents/benchmark-types.ts";

/** Runtime-only custom provider catalog. It never changes enabledModels or Pi-native providers. */
export default async function catalogExtension(pi: ExtensionAPI) {
  // Restore first for offline startup, then refresh stale or migration-era state
  // inside the awaited factory so discovery is visible to /model,
  // /scoped-models, and --list-models before Pi resolves the session scope.
  try {
    const [restored, settings] = await Promise.all([restoreCatalog(pi), loadCatalogSettings()]);
    if (!restored || Date.now() - restored.updatedAt >= settings.refreshTtlMs) await refreshCatalog(pi);
  } catch { /* A validated last-known-good catalog remains registered. */ }

  // A long-running startup may cross the refresh TTL after extension loading.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    try {
      const [state, settings] = await Promise.all([loadCatalogState(), loadCatalogSettings()]);
      if (state && Date.now() - state.updatedAt < settings.refreshTtlMs) return;
      await refreshCatalog(pi, ctx.signal);
    } catch { /* last known good remains published */ }
  });

  pi.registerCommand("catalog", {
    description: "Show catalog overview, refresh discovery, or sync enabled-model metadata",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action) {
        const [state, enabled] = await Promise.all([loadCatalogState(), loadEnabledModels()]);
        const runtimeAvailable = ctx.modelRegistry.getAvailable().map((model: any) => `${model.provider}/${model.id}`);
        const overview = renderCatalogOverview(state, enabled, runtimeAvailable);
        ctx.ui.notify(overview.text, overview.level);
        return;
      }
      if (action === "refresh") {
        try {
          const state = await refreshCatalog(pi, ctx.signal);
          const enabled = await loadEnabledModels();
          const runtimeAvailable = ctx.modelRegistry.getAvailable().map((model: any) => `${model.provider}/${model.id}`);
          const overview = renderCatalogOverview(state, enabled, runtimeAvailable);
          ctx.ui.notify(overview.text, overview.level);
        } catch (error) {
          // The persisted state is deliberately not changed by a failed refresh.
          ctx.ui.notify(`Catalog refresh failed; retained last-known-good state: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "sync") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/catalog sync requires interactive mode for reviewed Artificial Analysis mappings.", "error");
          return;
        }
        try {
          const aaWarnings: string[] = []; let aaBefore: Awaited<ReturnType<typeof captureAaArtifactState>> | null = null;
          try { aaBefore = await captureAaArtifactState(); }
          catch { aaWarnings.push("AA artifact state capture was unavailable"); ctx.ui.notify("AA artifact state capture was unavailable; AA net changes may not be listed.", "warning"); }
          let report = await syncEnabledModels(pi, ctx as never);
          let publishedAaSucceeded = false; let changedAaGeneration = false;
          const reviewable = report.models.filter((model) => model.aaMissing || model.variantCapable);
          let suggestions = new Map<string, AaCandidate[]>();
          let reviewedCatalog: CatalogResult | undefined;
          try { ({ suggestions, catalog: reviewedCatalog } = await prepareAaCandidateReview(reviewable.map((model) => model.id), ctx.signal)); }
          catch (error) { ctx.ui.notify(`AA discovery unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
          for (const modelReport of reviewable) {
            const modelId = modelReport.id;
            const known = new Set(modelReport.aaVariants.map((variant) => variant.aaModelId));
            const candidates = (suggestions.get(modelId) ?? []).filter((candidate) => !known.has(candidate.aaModelId));
            if (!candidates.length) continue;
            if (hasGenericAaMapping(modelReport.aaVariants)) {
              ctx.ui.notify(`${modelId} has an existing generic AA mapping, which is preserved. Converting it to specific variants requires a separately reviewed canonical-mappings.json change.`, "warning");
              continue;
            }
            if (!await ctx.ui.confirm("Artificial Analysis mapping", `Review ${candidates.length} additional AA candidate(s) and map every exact thinking variant for ${modelId}?`)) continue;
            const remaining = [...candidates];
            const reviewed: ReviewedAaVariant[] = [];
            while (remaining.length) {
              const labels = remaining.map((candidate) => `${candidate.name} — ${candidate.slug} — ${candidate.aaModelId}`);
              const choice = await ctx.ui.select(`Select an AA variant for ${modelId} (Cancel review aborts this model; every exact variant must be reviewed to publish)`, [...labels, "Cancel review"]);
              if (!choice || choice === "Cancel review") break;
              const at = labels.indexOf(choice);
              if (at < 0) break;
              const candidate = remaining[at]!;
              const variantCapable = report.models.find((model) => model.id === modelId)?.variantCapable === true;
              const levelLabel = await ctx.ui.select(`Thinking level for ${candidate.name}`, aaReviewThinkingLevelOptions(variantCapable));
              if (!levelLabel) continue;
              remaining.splice(at, 1);
              const thinkingLevel = (levelLabel === "generic" ? null : levelLabel) as BenchmarkThinkingLevel;
              reviewed.push({ ...candidate, thinkingLevel });
              if (thinkingLevel === null) break;
            }
            if (!reviewed.length) continue;
            if (!isCompleteAaCandidateReview(candidates, reviewed)) {
              ctx.ui.notify(`Skipped ${modelId}: every displayed AA candidate must be reviewed before publication.`, "warning");
              continue;
            }
            const existingReviewed: ReviewedAaVariant[] = modelReport.aaVariants.map((variant) => ({ aaModelId: variant.aaModelId, thinkingLevel: variant.thinkingLevel, slug: "reviewed-existing", name: "Reviewed existing variant" }));
            const completeReviewed = [...existingReviewed, ...reviewed];
            const levelSet = new Set(completeReviewed.map((entry) => entry.thinkingLevel ?? "generic"));
            if (levelSet.has("generic") && levelSet.size > 1) {
              ctx.ui.notify(`Skipped ${modelId}: generic and thinking-specific AA mappings cannot coexist.`, "error");
              continue;
            }
            const canonicalId = report.models.find((model) => model.id === modelId)?.canonicalId ?? modelId;
            if (!await ctx.ui.confirm("Publish reviewed AA batch", `Publish the complete ${completeReviewed.length}-variant reviewed AA set for ${modelId}?`)) continue;
            try {
              const publication = await publishReviewedAaVariants(modelId, canonicalId, completeReviewed, ctx.signal, undefined, reviewedCatalog);
              publishedAaSucceeded = true; changedAaGeneration ||= publication.changed; aaWarnings.push(...publication.warnings);
              if (modelReport.source === "custom" && completeReviewed.every((variant) => variant.thinkingLevel !== null)) {
                try {
                  if (await persistReviewedReasoning(modelId, completeReviewed.map((variant) => variant.thinkingLevel))) await restoreCatalog(pi);
                } catch (error) { ctx.ui.notify(`AA mapping published for ${modelId}, but reasoning metadata was not persisted: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
              }
            } catch (error) {
              ctx.ui.notify(`AA publication failed for ${modelId}; previous mappings remain valid: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          }
          const finalized = await finalizeAaSync(
            report, publishedAaSucceeded, changedAaGeneration, aaBefore, aaWarnings, ctx.signal,
            () => syncEnabledModels(pi, ctx as never),
          );
          report = finalized.report;
          ctx.ui.notify(renderCatalogSync(report, finalized.aaArtifacts), report.unresolvedCosts.length || report.missingAa.length || !!finalized.aaArtifacts?.warnings.length ? "warning" : "info");
        } catch (error) {
          ctx.ui.notify(`Catalog sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      ctx.ui.notify("Usage: /catalog [refresh|sync]", "error");
    },
  });
}

export * from "./catalog.ts";
export * from "./cost-sources.ts";
export * from "./provider-settings.ts";
export * from "./state.ts";
export * from "./sync.ts";
export * from "./types.ts";
