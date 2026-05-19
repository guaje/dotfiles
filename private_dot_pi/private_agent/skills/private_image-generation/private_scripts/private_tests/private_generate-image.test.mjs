import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptFile = resolve(scriptDir, '../generate-image.mjs');
const stubPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAACAAHiIbwzAAAAAElFTkSuQmCC';

test('generate-image.mjs writes a PNG and returns expected metadata', async (t) => {
  assert.ok(existsSync(scriptFile), 'generate-image.mjs must exist');

  const tmpRoot = await mkdtemp(join(tmpdir(), 'generate-image-script-test-'));
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization || '';
    if (!String(auth).startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing auth' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: stubPngBase64 }] }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));

  const { port } = server.address();
  const agentDir = join(tmpRoot, 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  const outDir = join(tmpRoot, 'out');
  await mkdir(extensionsDir, { recursive: true });

  await writeFile(join(agentDir, 'model-health-cache.json'), JSON.stringify({
    checkedAt: Date.now(),
    results: [
      { id: 'test-provider/test-image-model', status: 'ok', name: 'test-image-model', service: 'imageGeneration' },
    ],
  }));
  await writeFile(join(extensionsDir, 'model-health-check.ts'), 'export const MODEL_HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;\n');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'test-provider': {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-api-key-fixture',
        models: [],
      },
    },
  }));
  await writeFile(join(agentDir, 'settings.config.json'), JSON.stringify({
    imageGenerationProviders: {
      'test-provider': {
        models: [{ id: 'test-image-model', name: 'test-image-model' }],
      },
    },
  }));

  const { stdout } = await execFileAsync('node', [scriptFile], {
    env: {
      ...process.env,
      IMAGE_AGENT_DIR: agentDir,
      IMAGE_PROMPT: 'script test prompt',
      IMAGE_SIZE: '256x256',
      IMAGE_OUT_DIR: outDir,
      TERMUX_VERSION: '',
      PREFIX: '',
    },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.provider, 'test-provider');
  assert.equal(result.model, 'test-image-model');
  assert.equal(result.size, '256x256');
  assert.match(result.display, /Use pi inline terminal image rendering/);
  assert.ok(existsSync(result.path), `expected generated image at ${result.path}`);

  const imageBytes = await readFile(result.path);
  assert.deepEqual([...imageBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].prompt, 'script test prompt');
  assert.equal(requests[0].response_format, 'b64_json');
  assert.equal(requests[0].model, 'test-image-model');
});
