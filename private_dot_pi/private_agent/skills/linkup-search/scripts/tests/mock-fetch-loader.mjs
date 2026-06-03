import { writeFileSync } from 'node:fs';

const recordPath = process.env.LINKUP_MOCK_FETCH_RECORD;
const status = Number(process.env.LINKUP_MOCK_FETCH_STATUS || 200);
const body = process.env.LINKUP_MOCK_FETCH_BODY || '{"ok":true}';

globalThis.fetch = async (url, init = {}) => {
  if (recordPath) {
    writeFileSync(recordPath, JSON.stringify({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }, null, 2));
  }

  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
};
