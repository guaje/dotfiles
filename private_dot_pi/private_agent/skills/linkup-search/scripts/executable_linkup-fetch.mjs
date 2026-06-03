#!/usr/bin/env node
import { boolEnv, jsonError, postJson } from './linkup-common.mjs';

const url = process.env.LINKUP_URL || '';
if (!url) jsonError('Missing LINKUP_URL. Set it to the URL to fetch. Example: LINKUP_URL="https://example.com/article"', 2);

await postJson('/v1/fetch', {
  url,
  renderJs: boolEnv('LINKUP_RENDER_JS', true),
  includeRawHtml: boolEnv('LINKUP_INCLUDE_RAW_HTML', false),
  extractImages: boolEnv('LINKUP_EXTRACT_IMAGES', false),
});
