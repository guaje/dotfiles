#!/usr/bin/env node
import { getJson, jsonError } from './linkup-common.mjs';

const id = process.env.LINKUP_RESEARCH_ID || '';
if (!id) jsonError('Missing LINKUP_RESEARCH_ID. Set it to the research task id to poll.', 2);

await getJson(`/v1/research/${encodeURIComponent(id)}`);
