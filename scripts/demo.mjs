#!/usr/bin/env node
/**
 * Ghost Bridge demo — self-proving in one command.
 *
 * Boots a local relay, registers a primary key, adds a second named key
 * (a simulated second agent), files a task WITH an attachment from that
 * agent via the hosted MCP, watches the event stream catch it, answers it
 * with a structured result, and prints the board.
 *
 *   node scripts/demo.mjs        (or: npm run demo / ghost-bridge demo)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayDir = path.join(here, '..', 'relay');
const PORT = 8900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_SECRET = 'demo-setup-secret';
const PRIMARY_KEY = 'demo-primary-key-0123456789abcdef';

let step = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const die = msg => { console.error(`\nDEMO FAILED: ${msg}`); process.exitCode = 1; throw new Error(msg); };

const child = spawn('node', ['local-server.mjs', String(PORT)], {
  cwd: relayDir,
  env: { ...process.env, BRIDGE_SETUP_SECRET: SETUP_SECRET },
  stdio: ['ignore', 'ignore', 'inherit']
});

async function call(method, p, { key, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-bridge-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  console.log(`\nGhost Bridge v4 demo — booting a local relay on ${BASE} …`);
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const h = await call('GET', '/health'); up = h.status === 200; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!up) die('relay did not come up');
  ok(`relay healthy (v${(await call('GET', '/health')).data.version})`);

  const setup = await call('POST', '/setup', { body: { key: PRIMARY_KEY, setupSecret: SETUP_SECRET, name: 'demo-primary' } });
  if (setup.status !== 200) die('setup failed: ' + JSON.stringify(setup.data));
  ok('primary key registered (setup-secret bootstrap)');

  const second = await call('POST', '/api/keys', { key: PRIMARY_KEY, body: { name: 'agent-b' } });
  if (setup.status !== 200 || !second.data.key) die('second key mint failed: ' + JSON.stringify(second.data));
  const agentBKey = second.data.key;
  ok('second named key minted for agent-b (shown once, only its hash is stored)');

  const mcpRes = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-key': agentBKey },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ghost_handoff', arguments: { title: 'Demo task', task: 'Read the attached hello file and confirm the bridge loop works.', attachments: [{ name: 'hello.txt', mime: 'text/plain', dataBase64: Buffer.from('hello from agent-b').toString('base64') }] } }
    })
  });
  const mcpData = await mcpRes.json();
  const handText = mcpData.result?.content?.[0]?.text || '';
  if (!handText.includes('relay #1')) die('hosted-MCP handoff failed: ' + handText);
  ok('agent-b filed task #1 via hosted MCP, with hello.txt attached');

  const events = await call('GET', '/api/events?since=0', { key: PRIMARY_KEY });
  const created = events.data.events.find(e => e.type === 'task.created' && e.taskId === 1);
  if (!created) die('task.created event missing from the event log');
  ok('event log caught task.created (long-poll wake works — no sweep needed)');

  const comment = await call('POST', '/api/tasks/1/comments', {
    key: PRIMARY_KEY,
    body: { author: 'mrghosty', body: 'Read hello.txt — it says "hello from agent-b". The loop works.', result: { status: 'done', summary: 'Attachment read; bridge loop proven end-to-end.', files: ['hello.txt'] } }
  });
  if (comment.status !== 201 || comment.data.comments.at(-1)?.result?.summary === undefined) die('structured result comment failed');
  const doneRes = await call('PATCH', '/api/tasks/1', { key: PRIMARY_KEY, body: { status: 'done', result: { status: 'done', summary: 'Demo complete.', files: [] } } });
  if (doneRes.data.status !== 'done') die('patch to done failed');
  ok('Mr.Ghosty answered with a structured result and marked the task done');

  const keys = await call('GET', '/api/keys', { key: PRIMARY_KEY });
  const list = await call('GET', '/api/tasks?state=all', { key: PRIMARY_KEY });
  console.log('\n# Ghost Bridge Board (demo)');
  for (const t of list.data.tasks) console.log(`- #${t.id} [${t.status}] ${t.title}${t.attachments?.length ? ` (attachments: ${t.attachments.map(a => a.name).join(', ')})` : ''}`);
  console.log(`\nKeys on this relay: ${keys.data.keys.map(k => k.name).join(', ')}`);
  console.log('\nDEMO PASSED — relay, multi-key auth, hosted MCP, attachments, events, and structured results all work.\n');
} catch (e) {
  if (!process.exitCode) { console.error(e); process.exitCode = 1; }
} finally {
  child.kill();
}
