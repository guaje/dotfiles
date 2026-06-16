#!/usr/bin/env node
import { getJson } from './linkup-common.mjs';

await getJson('/v1/research');
