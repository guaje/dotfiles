#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  SCRIPTS_DIR,
  assertJsonError,
  cleanupDir,
  makeAgentDir,
  makeRecordPath,
  readRecord,
  runExpectError,
  runScript,
} from './test-utils.mjs';

const SCRIPT_PATH = join(SCRIPTS_DIR, 'linkup-fetch.mjs');

// Missing URL.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir });
  assert.ok(stderr, 'Expected error for missing URL');
  assertJsonError(stderr, 'LINKUP_URL', 2);
  cleanupDir(dir);
}

// Missing API key after URL validation.
{
  const dir = makeAgentDir({});
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_URL: 'https://example.com' });
  assert.ok(stderr, 'Expected error for missing key');
  assertJsonError(stderr, 'linkupAPIKey', 2);
  cleanupDir(dir);
}

// Successful request payload includes fetch parameters and bearer auth.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  const stdout = runScript(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_URL: 'https://docs.linkup.so',
    LINKUP_RENDER_JS: 'false',
    LINKUP_INCLUDE_RAW_HTML: 'true',
    LINKUP_EXTRACT_IMAGES: 'true',
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '{"markdown":"ok","rawHtml":"<p>ok</p>","images":[]}',
  }, { mockFetch: true });

  assert.deepEqual(JSON.parse(stdout), { markdown: 'ok', rawHtml: '<p>ok</p>', images: [] });
  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/fetch');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.deepEqual(request.body, {
    url: 'https://docs.linkup.so',
    renderJs: false,
    includeRawHtml: true,
    extractImages: true,
  });
  cleanupDir(dir);
  cleanupDir(record.dir);
}

// Defaults renderJs/includeRawHtml/extractImages correctly.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  runScript(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_URL: 'https://example.com',
    LINKUP_MOCK_FETCH_RECORD: record.path,
  }, { mockFetch: true });

  const request = readRecord(record.path);
  assert.deepEqual(request.body, {
    url: 'https://example.com',
    renderJs: true,
    includeRawHtml: false,
    extractImages: false,
  });
  cleanupDir(dir);
  cleanupDir(record.dir);
}

console.log('PASS linkup-fetch script tests');
