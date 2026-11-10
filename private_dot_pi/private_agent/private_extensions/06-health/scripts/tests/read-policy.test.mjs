import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const readPolicyPath = resolve(scriptDir, '../read-policy.mjs');

async function createFixture(t) {
  assert.ok(existsSync(readPolicyPath), 'read-policy.mjs must exist');

  const tmpRoot = await mkdtemp(join(tmpdir(), 'read-policy-test-'));
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const agentDir = join(tmpRoot, 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  const healthDir = join(extensionsDir, '06-health');
  const assetsDir = join(healthDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const policy = {
    cacheTtlMs: { default: 900000, minimum: 1000, maximum: 86400000 },
    probeConcurrency: { default: 3, minimum: 1, maximum: 8 },
    probeTimeoutMs: { default: 20000, minimum: 2000, maximum: 120000 },
    probeEscalation: { default: true },
  };
  await writeFile(join(assetsDir, 'policy.json'), JSON.stringify(policy, null, 2));

  return { agentDir, tmpRoot };
}

async function importReadPolicy() {
  const moduleUrl = `${pathToFileURL(readPolicyPath).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

test('readModelHealthSettings reads nested health.* keys', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({ health: { cacheTtlMs: 120000, probeConcurrency: 2, probeTimeoutMs: 30000 } }),
  );

  const mod = await importReadPolicy();
  const settings = mod.readModelHealthSettings(agentDir);
  assert.equal(settings.cacheTtlMs, 120000);
  assert.equal(settings.concurrency, 2);
  assert.equal(settings.probeTimeoutMs, 30000);
  assert.equal(settings.probeEscalation, true, 'policy default applies when the key is absent');
});

test('readModelHealthSettings falls back to flat legacy keys when nested absent', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({ modelHealthCacheTtlMs: 60000, modelHealthProbeConcurrency: 4, modelHealthProbeTimeoutMs: 45000 }),
  );

  const mod = await importReadPolicy();
  const settings = mod.readModelHealthSettings(agentDir);
  assert.equal(settings.cacheTtlMs, 60000);
  assert.equal(settings.concurrency, 4);
  assert.equal(settings.probeTimeoutMs, 45000, 'flat legacy key resolves the probe ceiling');
});

test('readModelHealthSettings prefers nested health.* over flat legacy keys', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({
      health: { cacheTtlMs: 180000, probeConcurrency: 1, probeTimeoutMs: 60000 },
      modelHealthCacheTtlMs: 30000,
      modelHealthProbeConcurrency: 5,
      modelHealthProbeTimeoutMs: 90000,
    }),
  );

  const mod = await importReadPolicy();
  const settings = mod.readModelHealthSettings(agentDir);
  assert.equal(settings.cacheTtlMs, 180000);
  assert.equal(settings.concurrency, 1);
  assert.equal(settings.probeTimeoutMs, 60000);
});

test('readModelHealthSettings falls back to flat legacy key when nested value is invalid', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({
      health: { cacheTtlMs: 'not-a-number', probeConcurrency: -5, probeTimeoutMs: 12.5 },
      modelHealthCacheTtlMs: 45000,
      modelHealthProbeConcurrency: 3,
    }),
  );

  const mod = await importReadPolicy();
  const settings = mod.readModelHealthSettings(agentDir);
  assert.equal(settings.cacheTtlMs, 45000);
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.probeTimeoutMs, 20000, 'a non-integer nested ceiling falls back to the policy default');
});

test('readModelHealthSettings uses defaults when both nested and flat values are absent', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({ otherSetting: true }),
  );

  const mod = await importReadPolicy();
  const settings = mod.readModelHealthSettings(agentDir);
  assert.equal(settings.cacheTtlMs, 900000);
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.probeTimeoutMs, 20000);
});

test('readModelHealthSettings resolves the probe escalation switch', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({
      health: { probeEscalation: false },
      modelHealthProbeEscalation: true,
    }),
  );

  const mod = await importReadPolicy();
  assert.equal(mod.readModelHealthSettings(agentDir).probeEscalation, false, 'nested false disables the extra probe');

  await writeFile(join(agentDir, 'settings.config.json'), JSON.stringify({ modelHealthProbeEscalation: false }));
  assert.equal(mod.readModelHealthSettings(agentDir).probeEscalation, false, 'flat legacy key still resolves');

  await writeFile(join(agentDir, 'settings.config.json'), JSON.stringify({ health: { probeEscalation: 'off' } }));
  assert.equal(mod.readModelHealthSettings(agentDir).probeEscalation, true, 'a non-boolean value cannot flip the switch');
});

test('readModelHealthSettings rejects out-of-range values and falls back to defaults', async (t) => {
  const { agentDir } = await createFixture(t);
  await writeFile(
    join(agentDir, 'settings.config.json'),
    JSON.stringify({
      health: { cacheTtlMs: 500, probeConcurrency: 100, probeTimeoutMs: 999 },
    }),
  );

  const mod = await importReadPolicy();
  const settings = mod.readModelHealthSettings(agentDir);
  assert.equal(settings.cacheTtlMs, 900000);
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.probeTimeoutMs, 20000, 'a ceiling below policy.probeTimeoutMs.minimum is rejected');
});
