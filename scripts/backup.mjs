#!/usr/bin/env node
/**
 * ghost-bridge backup — export a whole relay to one JSON file (v4.2).
 *
 *   GHOST_RELAY_URL=https://YOUR-RELAY.example.com \
 *   GHOST_BRIDGE_KEY=<a FULL-SCOPE key> \
 *   node scripts/backup.mjs [--out backup.json] [--events] [--stdout]
 *
 * The key also falls back to ~/.ghost-bridge/credentials (written by setup).
 * The export carries key NAMES + SCOPES + sha256 HASHES (plaintext keys are
 * never stored server-side), all tasks (with comments, attachments, and the
 * internal idempotency keys), all files, the context, and the counter.
 * Events are included only with --events. Treat the backup file as
 * sensitive anyway: it's your whole queue and working memory in one file.
 * Default output: ghost-bridge-backup-<YYYYMMDD-HHMMSS>.json in the cwd.
 * Summary goes to stderr so --stdout stays pipe-clean.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = (process.env.GHOST_RELAY_URL || '').replace(/\/$/, '');
let key = process.env.GHOST_BRIDGE_KEY || '';
if (!key) {
  try { key = fs.readFileSync(process.env.GHOST_KEY_FILE || path.join(os.homedir(), '.ghost-bridge', 'credentials'), 'utf8').trim().split(/\s+/)[0] || ''; } catch { /* none */ }
}
if (!url || !key) { console.error('Set GHOST_RELAY_URL and GHOST_BRIDGE_KEY (a full-scope key), or run setup first.'); process.exit(1); }

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = outIdx >= 0 ? args[outIdx + 1] : `ghost-bridge-backup-${stamp}.json`;
const toStdout = args.includes('--stdout');
const includeEvents = args.includes('--events');

const res = await fetch(url + '/api/export' + (includeEvents ? '?events=1' : ''), { headers: { 'x-bridge-key': key } });
const doc = await res.json().catch(() => null);
if (!res.ok || !doc || doc.format !== 'ghost-bridge-export') {
  console.error(`Export failed: HTTP ${res.status}${doc?.error ? ' — ' + doc.error : ''} (a full-scope key is required)`);
  process.exit(1);
}
const json = JSON.stringify(doc, null, 2);
if (toStdout) process.stdout.write(json + '\n');
else fs.writeFileSync(outFile, json + '\n', { mode: 0o600 });
console.error(`Ghost Bridge backup: ${doc.tasks.length} task(s), ${Object.keys(doc.files || {}).length} file(s), ${doc.keys.length} key(s)${doc.events ? `, ${doc.events.length} event(s)` : ''}, context ${doc.context ? 'included' : 'absent'} — exported from relay v${doc.version} at ${doc.exportedAt}${toStdout ? '' : ` → ${outFile}`}`);
