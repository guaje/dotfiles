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

const GET_RESEARCH = join(SCRIPTS_DIR, 'linkup-get-research.mjs');
const LIST_RESEARCH = join(SCRIPTS_DIR, 'linkup-list-research.mjs');
const GET_TASK = join(SCRIPTS_DIR, 'linkup-get-task.mjs');
const LIST_TASKS = join(SCRIPTS_DIR, 'linkup-list-tasks.mjs');

// Missing research id.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(GET_RESEARCH, { LINKUP_AGENT_DIR: dir });
  assert.ok(stderr, 'Expected error for missing research id');
  assertJsonError(stderr, 'LINKUP_RESEARCH_ID', 2);
  cleanupDir(dir);
}

// Missing task id.
{
  const dir = makeAgentDir();
  const stderr = runExpectError(GET_TASK, { LINKUP_AGENT_DIR: dir });
  assert.ok(stderr, 'Expected error for missing task id');
  assertJsonError(stderr, 'LINKUP_TASK_ID', 2);
  cleanupDir(dir);
}

// Get research by id.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  const stdout = runScript(GET_RESEARCH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_RESEARCH_ID: 'research 123',
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '{"id":"research 123","status":"completed"}',
  }, { mockFetch: true });

  assert.deepEqual(JSON.parse(stdout), { id: 'research 123', status: 'completed' });
  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/research/research%20123');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.body, undefined);
  cleanupDir(dir);
  cleanupDir(record.dir);
}

// List research tasks.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  runScript(LIST_RESEARCH, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '[]',
  }, { mockFetch: true });

  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/research');
  assert.equal(request.method, 'GET');
  assert.equal(request.body, undefined);
  cleanupDir(dir);
  cleanupDir(record.dir);
}

// Get task by id.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  runScript(GET_TASK, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_TASK_ID: 'task/abc',
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '{"id":"task/abc","status":"processing"}',
  }, { mockFetch: true });

  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/tasks/task%2Fabc');
  assert.equal(request.method, 'GET');
  assert.equal(request.body, undefined);
  cleanupDir(dir);
  cleanupDir(record.dir);
}

// List tasks.
{
  const dir = makeAgentDir();
  const record = makeRecordPath();
  runScript(LIST_TASKS, {
    LINKUP_AGENT_DIR: dir,
    LINKUP_MOCK_FETCH_RECORD: record.path,
    LINKUP_MOCK_FETCH_BODY: '[]',
  }, { mockFetch: true });

  const request = readRecord(record.path);
  assert.equal(request.url, 'https://api.linkup.so/v1/tasks');
  assert.equal(request.method, 'GET');
  assert.equal(request.body, undefined);
  cleanupDir(dir);
  cleanupDir(record.dir);
}

console.log('PASS linkup polling/listing script tests');
