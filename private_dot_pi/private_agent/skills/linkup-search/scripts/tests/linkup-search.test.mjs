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

const SCRIPT_PATH = join(SCRIPTS_DIR, 'linkup-search.mjs');

// Missing query.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir });
  assert.ok(stderr, 'Expected error for missing query');
  assertJsonError(stderr, 'LINKUP_QUERY', 2);
  cleanupDir(dir);
}

// Missing API key.
{
  const dir = makeAgentDir({});
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test' });
  assert.ok(stderr, 'Expected error for missing key');
  assertJsonError(stderr, 'linkupAPIKey', 2);
  cleanupDir(dir);
}

// Invalid depth.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_DEPTH: 'bogus' });
  assert.ok(stderr, 'Expected error for invalid depth');
  assertJsonError(stderr, 'LINKUP_DEPTH', 2);
  cleanupDir(dir);
}

// Invalid output type.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_OUTPUT_TYPE: 'bogus' });
  assert.ok(stderr, 'Expected error for invalid output type');
  assertJsonError(stderr, 'LINKUP_OUTPUT_TYPE', 2);
  cleanupDir(dir);
}

// $ENV_VAR resolution with empty value.
{
  const dir = makeAgentDir({ linkupAPIKey: '$LINKUP_TEST_KEY' });
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_TEST_KEY: '' });
  assert.ok(stderr, 'Expected error for empty env-resolved key');
  assertJsonError(stderr, 'linkupAPIKey', 2);
  cleanupDir(dir);
}

// Invalid maxResults.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_MAX_RESULTS: '0' });
  assert.ok(stderr, 'Expected error for invalid max results');
  assertJsonError(stderr, 'LINKUP_MAX_RESULTS', 2);
  cleanupDir(dir);
}

// Invalid includeImages.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_INCLUDE_IMAGES: 'yes' });
  assert.ok(stderr, 'Expected error for invalid include images');
  assertJsonError(stderr, 'LINKUP_INCLUDE_IMAGES', 2);
  cleanupDir(dir);
}

// Successful request payload includes search parameters, filters, schema, maxResults, includeImages, and bearer auth.
{
  const dir = makeAgentDir({ linkupAPIKey: '$LINKUP_TEST_KEY' });
  const record = makeRecordPath();
  const stdout = runScript(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_TEST_KEY: 'resolved-key',
    LINKUP_QUERY: 'Find Microsoft 2024 revenue',
    LINKUP_DEPTH: 'deep',
    LINKUP_OUTPUT_TYPE: 'structured',
    LINKUP_STRUCTURED_OUTPUT_SCHEMA: '{"type":"object","properties":{"revenue":{"type":"string"}},"required":["revenue"]}',
    LINKUP_FROM_DATE: '2025-01-01',
    LINKUP_TO_DATE: '2025-12-31',
    LINKUP_INCLUDE_DOMAINS: 'microsoft.com, sec.gov',
    LINKUP_EXCLUDE_DOMAINS: 'wikipedia.org',
    LINKUP_MAX_RESULTS: '7',
    LINKUP_INCLUDE_IMAGES: 'true',
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '{"answer":{"revenue":"example"}}',
  }, { mockFetch: true });

  assert.deepEqual(JSON.parse(stdout), { answer: { revenue: 'example' } });
  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/search');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer resolved-key');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, {
    q: 'Find Microsoft 2024 revenue',
    depth: 'deep',
    outputType: 'structured',
    includeDomains: ['microsoft.com', 'sec.gov'],
    excludeDomains: ['wikipedia.org'],
    fromDate: '2025-01-01',
    toDate: '2025-12-31',
    maxResults: 7,
    includeImages: true,
    structuredOutputSchema: {
      type: 'object',
      properties: { revenue: { type: 'string' } },
      required: ['revenue'],
    },
  });
  cleanupDir(dir);
  cleanupDir(record.dir);
}

// API errors are surfaced as JSON errors with exit code 1.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_QUERY: 'test',
    LINKUP_MOCK_FETCH_STATUS: '400',
    LINKUP_MOCK_FETCH_BODY: '{"error":{"message":"bad request"}}',
  }, { mockFetch: true });
  assert.ok(stderr, 'Expected API error');
  assertJsonError(stderr, 'bad request', 1);
  cleanupDir(dir);
}

console.log('PASS linkup-search script tests');
