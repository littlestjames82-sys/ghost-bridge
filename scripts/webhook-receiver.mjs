#!/usr/bin/env node
/**
 * ghost-bridge webhook receiver — a minimal, verified example (v4.2).
 *
 *   GHOST_BRIDGE_WEBHOOK_SECRET=<same secret as the relay> \
 *   node scripts/webhook-receiver.mjs [port]        # default 8910
 *
 * Point the relay at it with GHOST_BRIDGE_WEBHOOK_URL=http://127.0.0.1:8910/hook
 * and every relay event is printed here as it lands. When a secret is set,
 * signatures are verified and bad ones are refused with 401; with no
 * secret set, events are accepted unsigned (the relay then sends them
 * unsigned too). Keep this behind your own network / a secret path if it
 * ever triggers anything consequential — and remember the bridge rule:
 * consequential work still goes through the needs-approval gate.
 */
import http from 'node:http';
import { verifyGhostSignature } from './webhook-verify.mjs';

const port = parseInt(process.argv[2], 10) || 8910;
const secret = process.env.GHOST_BRIDGE_WEBHOOK_SECRET || '';

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (secret && !verifyGhostSignature(raw, req.headers['x-ghost-signature'], secret)) {
      console.error('✗ webhook REJECTED — bad x-ghost-signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad signature' }));
    }
    let event = null;
    try { event = JSON.parse(raw.toString('utf8')); } catch { /* not JSON — still ack */ }
    console.log(`${secret ? '✓ verified' : '· unsigned'}  ${req.headers['x-ghost-event'] || event?.type || 'event'}  ${event ? JSON.stringify(event) : raw.toString('utf8').slice(0, 200)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(port, '127.0.0.1', () => console.error(`ghost-bridge webhook receiver on http://127.0.0.1:${port}/hook (signatures ${secret ? 'REQUIRED' : 'not required — set GHOST_BRIDGE_WEBHOOK_SECRET to require them'})`));
