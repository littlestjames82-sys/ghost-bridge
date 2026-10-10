// Local dev/test server for the Ghost Bridge Relay (in-memory store).
// Also the Docker entrypoint — set HOST=0.0.0.0 to expose it beyond localhost.
// Usage: BRIDGE_SETUP_SECRET=<secret> node local-server.mjs [port]
// Optional: GHOST_BRIDGE_WEBHOOK_URL=https://example.test/hook
//
// Adds one thing core.mjs can't do transport-agnostically: true SSE streaming
// on GET /api/events/stream (x-bridge-key header or ?key=). It long-polls the
// core events endpoint internally and forwards each event as it lands.
// On Netlify Functions (which can't hold a stream open) use the JSON
// long-poll instead: GET /api/events?since=<seq>&wait=20.
import http from 'node:http';
import fs from 'node:fs';
import { createHandler } from './core.mjs';

// Store: in-memory by default. Set GHOST_BRIDGE_STORE_FILE=/path/store.json
// for a file-backed store that survives restarts (what Docker compose uses).
const storeFile = process.env.GHOST_BRIDGE_STORE_FILE || '';
const mem = new Map();
if (storeFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) mem.set(k, v);
    console.error(`ghost-bridge-relay: loaded store from ${storeFile}`);
  } catch { /* first boot — file appears on first write */ }
}
let saveTimer = null;
function persist() {
  if (!storeFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(storeFile, JSON.stringify(Object.fromEntries(mem))); } catch (e) { console.error('store persist failed:', e.message); }
  }, 200);
}
const store = {
  get: async k => (mem.has(k) ? mem.get(k) : null),
  set: async (k, v) => { mem.set(k, v); persist(); },
  del: async k => { mem.delete(k); persist(); }
};
const handler = createHandler(store, process.env);
const port = parseInt(process.argv[2], 10) || 8877;
const host = process.env.HOST || '127.0.0.1';

function collect(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function handleSse(req, res, url) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  if (url.searchParams.get('key') && !headers['x-bridge-key']) headers['x-bridge-key'] = url.searchParams.get('key');
  // Auth check via a cheap authed endpoint.
  const probe = await handler({ method: 'GET', path: '/api/meta', query: {}, headers, bodyText: '' });
  if (probe.status !== 200) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing or wrong bridge key' }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': ghost-bridge events stream open\n\n');
  let lastSeq = parseInt(url.searchParams.get('since'), 10) || 0;
  let closed = false;
  // NOTE: watch the RESPONSE for close — in modern Node the request stream
  // emits 'close' as soon as its (empty) body is consumed, which would kill
  // the stream instantly; res 'close' fires when the client actually leaves.
  res.on('close', () => { closed = true; });
  const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
  while (!closed) {
    const out = await handler({ method: 'GET', path: '/api/events', query: { since: String(lastSeq), wait: '20' }, headers, bodyText: '' });
    const data = typeof out.body === 'string' ? JSON.parse(out.body) : out.body;
    for (const e of data.events || []) {
      lastSeq = Math.max(lastSeq, e.seq);
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    }
  }
  clearInterval(heartbeat);
  res.end();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/events/stream') return handleSse(req, res, url);
  const body = await collect(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  const out = await handler({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, bodyText: body });
  res.writeHead(out.status, { 'Content-Type': out.contentType || 'application/json', ...(out.headers || {}) });
  res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
}).listen(port, host, () => console.error(`ghost-bridge-relay (local) on http://${host}:${port}`));
