#!/usr/bin/env node
import { getJson, jsonError } from './linkup-common.mjs';

const id = process.env.LINKUP_TASK_ID || '';
if (!id) jsonError('Missing LINKUP_TASK_ID. Set it to the task id to poll.', 2);

await getJson(`/v1/tasks/${encodeURIComponent(id)}`);
