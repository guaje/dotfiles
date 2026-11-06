import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCatalogRequestDelays } from "../catalog-settings.ts";

const settingsWith = async (catalog: unknown): Promise<{ root: string; settingsFile: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-catalog-settings-"));
  const settingsFile = path.join(root, "settings.config.json");
  await writeFile(settingsFile, JSON.stringify({ catalog }), { mode: 0o600 });
  return { root, settingsFile, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("per-source request delays come from catalog.artificialAnalysis and catalog.benchlm", async () => {
  const { settingsFile, cleanup } = await settingsWith({
    artificialAnalysis: { requestDelayMs: 250 },
    benchlm: { requestDelayMs: 400 },
  });
  try {
    assert.deepEqual(loadCatalogRequestDelays({}, settingsFile), { artificialAnalysis: 250, benchlm: 400 });
  } finally { await cleanup(); }
});

test("process env overrides requestDelayMs for an individual source", async () => {
  const { settingsFile, cleanup } = await settingsWith({
    artificialAnalysis: { requestDelayMs: 250 },
    benchlm: { requestDelayMs: 400 },
  });
  try {
    assert.deepEqual(
      loadCatalogRequestDelays({ PI_AA_PUBLIC_PAGE_DELAY: "750", PI_BENCHLM_PAGE_DELAY: "125" }, settingsFile),
      { artificialAnalysis: 750, benchlm: 125 },
    );
  } finally { await cleanup(); }
});

test("out-of-range requestDelayMs is rejected, not silently clamped", async () => {
  const { settingsFile, cleanup } = await settingsWith({
    artificialAnalysis: { requestDelayMs: 60_001 },
    benchlm: { requestDelayMs: 250 },
  });
  try {
    assert.throws(() => loadCatalogRequestDelays({}, settingsFile), /catalog\.artificialAnalysis\.requestDelayMs is outside the allowed range/);
  } finally { await cleanup(); }
});