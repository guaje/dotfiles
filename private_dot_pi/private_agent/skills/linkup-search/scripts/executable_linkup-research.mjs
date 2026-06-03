#!/usr/bin/env node
import { csvEnv, jsonError, parseJsonEnv, postJson } from './linkup-common.mjs';

const query = process.env.LINKUP_QUERY || '';
if (!query) jsonError('Missing LINKUP_QUERY. Set it to the research question.', 2);

const outputType = process.env.LINKUP_OUTPUT_TYPE || 'sourcedAnswer';
const validOutputs = ['sourcedAnswer', 'structured'];
if (!validOutputs.includes(outputType)) jsonError(`Invalid LINKUP_OUTPUT_TYPE "${outputType}". Must be one of: ${validOutputs.join(', ')}`, 2);

const body = { q: query, outputType };
const mode = process.env.LINKUP_RESEARCH_MODE || '';
const validModes = ['answer', 'auto', 'investigate', 'research'];
if (mode) {
  if (!validModes.includes(mode)) jsonError(`Invalid LINKUP_RESEARCH_MODE "${mode}". Must be one of: ${validModes.join(', ')}`, 2);
  body.mode = mode;
}

const reasoningDepth = process.env.LINKUP_REASONING_DEPTH || '';
const validReasoningDepths = ['S', 'M', 'L', 'XL'];
if (reasoningDepth) {
  if (!validReasoningDepths.includes(reasoningDepth)) jsonError(`Invalid LINKUP_REASONING_DEPTH "${reasoningDepth}". Must be one of: ${validReasoningDepths.join(', ')}`, 2);
  body.reasoningDepth = reasoningDepth;
}

const includeDomains = csvEnv('LINKUP_INCLUDE_DOMAINS');
const excludeDomains = csvEnv('LINKUP_EXCLUDE_DOMAINS');
if (includeDomains) body.includeDomains = includeDomains;
if (excludeDomains) body.excludeDomains = excludeDomains;
if (process.env.LINKUP_FROM_DATE) body.fromDate = process.env.LINKUP_FROM_DATE;
if (process.env.LINKUP_TO_DATE) body.toDate = process.env.LINKUP_TO_DATE;
const structuredOutputSchema = parseJsonEnv('LINKUP_STRUCTURED_OUTPUT_SCHEMA');
if (structuredOutputSchema) body.structuredOutputSchema = structuredOutputSchema;

await postJson('/v1/research', body);
