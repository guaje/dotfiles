import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = join(TEST_DIR, '..');
export const MOCK_FETCH_LOADER = join(TEST_DIR, 'mock-fetch-loader.mjs');

export function makeAgentDir(settings = { linkupAPIKey: 'test-key' }) {
  const dir = mkdtempSync(join(tmpdir(), 'linkup-script-test-'));
  writeFileSync(join(dir, 'settings.config.json'), JSON.stringify(settings));
  return dir;
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function runScript(scriptPath, env = {}, options = {}) {
  const args = options.mockFetch ? ['--import', MOCK_FETCH_LOADER, scriptPath] : [scriptPath];
  return execFileSync(process.execPath, args, {
    env: { ...process.env, LINKUP_API_KEY: '', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runExpectError(scriptPath, env = {}, options = {}) {
  try {
    runScript(scriptPath, env, options);
    return null;
  } catch (error) {
    return error.stderr || error.stdout || error.message;
  }
}

export function assertJsonError(stderr, contains, exitCode) {
  const json = JSON.parse(stderr);
  assert.ok(json.error?.includes(contains), `Expected error containing "${contains}", got: ${json.error}`);
  assert.equal(json.exitCode, exitCode);
}

export function makeRecordPath() {
  const dir = mkdtempSync(join(tmpdir(), 'linkup-fetch-record-'));
  return { dir, path: join(dir, 'record.json') };
}

export function readRecord(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
