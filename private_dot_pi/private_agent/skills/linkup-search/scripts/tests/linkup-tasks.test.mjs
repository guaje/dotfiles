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

const SCRIPT_PATH = join(SCRIPTS_DIR, 'linkup-tasks.mjs');

// Missing tasks JSON.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir });
  assert.ok(stderr, 'Expected error for missing LINKUP_TASKS_JSON');
  assertJsonError(stderr, 'LINKUP_TASKS_JSON', 2);
  cleanupDir(dir);
}

// Invalid JSON.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_TASKS_JSON: '[' });
  assert.ok(stderr, 'Expected error for invalid JSON');
  assertJsonError(stderr, 'Invalid JSON', 2);
  cleanupDir(dir);
}

// Empty array.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, { LINKUP_AGENT_DIR: dir, LINKUP_TASKS_JSON: '[]' });
  assert.ok(stderr, 'Expected error for empty tasks');
  assertJsonError(stderr, 'non-empty JSON array', 2);
  cleanupDir(dir);
}

// Invalid task type.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_TASKS_JSON: '[{"type":"unknown","input":{}}]',
  });
  assert.ok(stderr, 'Expected error for invalid task type');
  assertJsonError(stderr, 'invalid type', 2);
  cleanupDir(dir);
}

// Missing input object.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_TASKS_JSON: '[{"type":"search"}]',
  });
  assert.ok(stderr, 'Expected error for missing input object');
  assertJsonError(stderr, 'input object', 2);
  cleanupDir(dir);
}

// Successful request payload includes batch tasks and bearer auth.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  const tasks = [
    { type: 'search', input: { q: 'What is Microsoft 2024 revenue?', depth: 'standard', outputType: 'sourcedAnswer' } },
    { type: 'fetch', input: { url: 'https://docs.linkup.so', renderJs: false, includeRawHtml: true } },
    { type: 'research', input: { q: 'Research semiconductor market', outputType: 'sourcedAnswer', reasoningDepth: 'L' } },
  ];
  const stdout = runScript(SCRIPT_PATH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_TASKS_JSON: JSON.stringify(tasks),
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '[{"id":"task-1","status":"pending"}]',
  }, { mockFetch: true });

  assert.deepEqual(JSON.parse(stdout), [{ id: 'task-1', status: 'pending' }]);
  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/tasks');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.deepEqual(request.body, tasks);
  cleanupDir(dir);
  cleanupDir(record.dir);
}

console.log('PASS linkup-tasks script tests');
