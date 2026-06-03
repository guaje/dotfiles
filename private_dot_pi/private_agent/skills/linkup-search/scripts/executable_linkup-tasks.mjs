#!/usr/bin/env node
import { jsonError, parseJsonEnv, postJson } from './linkup-common.mjs';

const tasks = parseJsonEnv('LINKUP_TASKS_JSON');
if (!Array.isArray(tasks) || tasks.length === 0) {
  jsonError('Missing LINKUP_TASKS_JSON. Set it to a non-empty JSON array of {"type":"search|fetch|research","input":{...}} tasks.', 2);
}
if (tasks.length > 100) jsonError('LINKUP_TASKS_JSON may contain at most 100 tasks per submission.', 2);

for (const [index, task] of tasks.entries()) {
  if (!task || typeof task !== 'object') jsonError(`Task ${index} must be an object.`, 2);
  if (!['search', 'fetch', 'research'].includes(task.type)) jsonError(`Task ${index} has invalid type "${task.type}".`, 2);
  if (!task.input || typeof task.input !== 'object') jsonError(`Task ${index} must include an input object.`, 2);
}

await postJson('/v1/tasks', tasks);
