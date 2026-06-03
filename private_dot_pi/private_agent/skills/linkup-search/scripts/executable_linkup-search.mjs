#!/usr/bin/env node
import { csvEnv, jsonError, parseJsonEnv, postJson } from './linkup-common.mjs';

const query = process.env.LINKUP_QUERY || '';
if (!query) jsonError('Missing LINKUP_QUERY. Set it to the search query. Example: LINKUP_QUERY="latest AI news"', 2);

const depth = process.env.LINKUP_DEPTH || 'standard';
const validDepths = ['fast', 'standard', 'deep'];
if (!validDepths.includes(depth)) jsonError(`Invalid LINKUP_DEPTH "${depth}". Must be one of: ${validDepths.join(', ')}`, 2);

const outputType = process.env.LINKUP_OUTPUT_TYPE || 'searchResults';
const validOutputs = ['searchResults', 'sourcedAnswer', 'structured'];
if (!validOutputs.includes(outputType)) jsonError(`Invalid LINKUP_OUTPUT_TYPE "${outputType}". Must be one of: ${validOutputs.join(', ')}`, 2);

const body = { q: query, depth, outputType };
const includeDomains = csvEnv('LINKUP_INCLUDE_DOMAINS');
const excludeDomains = csvEnv('LINKUP_EXCLUDE_DOMAINS');
if (includeDomains) body.includeDomains = includeDomains;
if (excludeDomains) body.excludeDomains = excludeDomains;
if (process.env.LINKUP_FROM_DATE) body.fromDate = process.env.LINKUP_FROM_DATE;
if (process.env.LINKUP_TO_DATE) body.toDate = process.env.LINKUP_TO_DATE;
if (process.env.LINKUP_MAX_RESULTS) {
  const maxResults = Number(process.env.LINKUP_MAX_RESULTS);
  if (!Number.isInteger(maxResults) || maxResults <= 0) jsonError('Invalid LINKUP_MAX_RESULTS. Must be a positive integer.', 2);
  body.maxResults = maxResults;
}
if (process.env.LINKUP_INCLUDE_IMAGES) {
  const includeImages = process.env.LINKUP_INCLUDE_IMAGES.toLowerCase();
  if (!['true', 'false'].includes(includeImages)) jsonError('Invalid LINKUP_INCLUDE_IMAGES. Must be true or false.', 2);
  body.includeImages = includeImages === 'true';
}
const structuredOutputSchema = parseJsonEnv('LINKUP_STRUCTURED_OUTPUT_SCHEMA');
if (structuredOutputSchema) body.structuredOutputSchema = structuredOutputSchema;

await postJson('/v1/search', body);
