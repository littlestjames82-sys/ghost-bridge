#!/usr/bin/env node
/**
 * ghost-bridge watch — tail relay events as they happen.
 *
 *   GHOST_RELAY_URL=https://YOUR-RELAY.example.com \
 *   GHOST_BRIDGE_KEY=<your key>  node scripts/watch.mjs
 *
 * The key also falls back to ~/.ghost-bridge/credentials (written by setup).
 * Default mode long-polls GET /api/events (works everywhere, including
 * Netlify). --stream uses the SSE endpoint instead (local/Docker relays).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = (process.env.GHOST_RELAY_URL || 'http://127.0.0.1:8877').replace(/\/$/, '');
let key = process.env.GHOST_BRIDGE_KEY || '';
if (!key) {
  try { key = fs.readFileSync(process.env.GHOST_KEY_FILE || path.join(os.homedir(), '.ghost-bridge', 'credentials'), 'utf8').trim().split(/\s+/)[0] || ''; } catch { /* none */ }
}
if (!key) { console.error('No bridge key — set GHOST_BRIDGE_KEY or run setup first.'); process.exit(1); }

const printEvent = e => console.log(`${e.at}  ${e.type}${e.taskId ? `  task #${e.taskId}` : ''}${e.title ? `  ${e.title}` : ''}${e.status ? `  → ${e.status}` : ''}`);

if (process.argv.includes('--stream')) {
  console.log(`Watching ${url} via SSE (Ctrl-C to stop)…`);
  const res = await fetch(url + '/api/events/stream', { headers: { 'x-bridge-key': key } });
  if (!res.ok) { console.error('SSE failed:', res.status, '— is this a local/Docker relay? Netlify relays use the default long-poll mode.'); process.exit(1); }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
      if (dataLine) { try { printEvent(JSON.parse(dataLine.slice(6))); } catch { /* heartbeat etc. */ } }
    }
  }
} else {
  console.log(`Watching ${url} via long-poll (Ctrl-C to stop)…`);
  let since = '0';
  const meta = await (await fetch(url + '/api/events?since=0', { headers: { 'x-bridge-key': key } })).json().catch(() => null);
  if (meta) since = String(meta.lastSeq || 0);
  for (;;) {
    try {
      const res = await fetch(`${url}/api/events?since=${since}&wait=20`, { headers: { 'x-bridge-key': key } });
      if (!res.ok) { console.error('relay returned', res.status); await new Promise(r => setTimeout(r, 3000)); continue; }
      const data = await res.json();
      for (const e of data.events || []) { printEvent(e); since = String(Math.max(Number(since) || 0, e.seq)); }
    } catch (e) {
      console.error('connection hiccup:', e.message, '— retrying…');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
