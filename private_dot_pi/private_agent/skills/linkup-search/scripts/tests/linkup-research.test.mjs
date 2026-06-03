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

const SCRIPT_PATH = join(SCRIPTS_DIR, 'linkup-research.mjs');

// Missing query.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir });
  assert.ok(stderr, 'Expected error for missing query');
  assertJsonError(stderr, 'LINKUP_QUERY', 2);
  cleanupDir(dir);
}

// Invalid output type.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_OUTPUT_TYPE: 'searchResults' });
  assert.ok(stderr, 'Expected error for invalid output type');
  assertJsonError(stderr, 'LINKUP_OUTPUT_TYPE', 2);
  cleanupDir(dir);
}

// Invalid research mode.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_RESEARCH_MODE: 'deep' });
  assert.ok(stderr, 'Expected error for invalid research mode');
  assertJsonError(stderr, 'LINKUP_RESEARCH_MODE', 2);
  cleanupDir(dir);
}

// Invalid reasoning depth.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_QUERY: 'test', LINKUP_REASONING_DEPTH: 'XXL' });
  assert.ok(stderr, 'Expected error for invalid reasoning depth');
  assertJsonError(stderr, 'LINKUP_REASONING_DEPTH', 2);
  cleanupDir(dir);
}

// Successful request payload includes research parameters, filters, schema, and bearer auth.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  const stdout = runScript(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_QUERY: 'Research semiconductor market',
    LINKUP_OUTPUT_TYPE: 'structured',
    LINKUP_RESEARCH_MODE: 'research',
    LINKUP_REASONING_DEPTH: 'XL',
    LINKUP_STRUCTURED_OUTPUT_SCHEMA: '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}',
    LINKUP_INCLUDE_DOMAINS: 'sec.gov, bloomberg.com',
    LINKUP_EXCLUDE_DOMAINS: 'wikipedia.org',
    LINKUP_FROM_DATE: '2025-01-01',
    LINKUP_TO_DATE: '2026-01-01',
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '{"id":"research-1","status":"pending"}',
  }, { mockFetch: true });

  assert.deepEqual(JSON.parse(stdout), { id: 'research-1', status: 'pending' });
  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/research');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.deepEqual(request.body, {
    q: 'Research semiconductor market',
    outputType: 'structured',
    mode: 'research',
    reasoningDepth: 'XL',
    includeDomains: ['sec.gov', 'bloomberg.com'],
    excludeDomains: ['wikipedia.org'],
    fromDate: '2025-01-01',
    toDate: '2026-01-01',
    structuredOutputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  });
  cleanupDir(dir);
  cleanupDir(record.dir);
}

console.log('PASS linkup-research script tests');
