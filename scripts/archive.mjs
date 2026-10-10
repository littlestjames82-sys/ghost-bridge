#!/usr/bin/env node
/**
 * ghost-bridge archive — move old finished tasks into the relay's archive
 * (v4.3).
 *
 *   GHOST_RELAY_URL=https://YOUR-RELAY.example.com \
 *   GHOST_BRIDGE_KEY=<a FULL-SCOPE key> \
 *   node scripts/archive.mjs [--days 30]
 *
 * The key also falls back to ~/.ghost-bridge/credentials (written by setup).
 * Archiving is explicit — nothing ever archives on a timer. Eligible tasks
 * are done/cancelled tasks whose close time is older than the cutoff
 * (default: the relay's GHOST_BRIDGE_ARCHIVE_DAYS, 30 unless configured;
 * --days overrides it for this call; --days 0 disables and archives
 * nothing). Archived tasks leave the board, the default task lists, and
 * /probe counts, but they are never deleted: they stay readable via
 * GET /api/tasks?archived=1, they show up in ghost_search_tasks marked
 * [archived], and exports keep them.
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
const daysIdx = args.indexOf('--days');
let days;
if (daysIdx >= 0) {
  days = Number(args[daysIdx + 1]);
  if (!Number.isFinite(days) || days < 0) { console.error('--days needs a number >= 0 (0 disables archiving)'); process.exit(1); }
}

const res = await fetch(url + '/api/tasks/archive', {
  method: 'POST',
  headers: { 'x-bridge-key': key, 'Content-Type': 'application/json' },
  body: JSON.stringify(days !== undefined ? { days } : {})
});
const doc = await res.json().catch(() => null);
if (!res.ok || !doc) {
  console.error(`Archive failed: HTTP ${res.status}${doc?.error ? ' — ' + doc.error : ''} (a full-scope key is required)`);
  process.exit(1);
}
if (doc.note) console.error(`Ghost Bridge archive: ${doc.note}`);
else console.error(`Ghost Bridge archive: ${doc.archived} task(s) archived (done/cancelled older than ${doc.days} day(s))${doc.archivedIds?.length ? ` — ids: ${doc.archivedIds.join(', ')}` : ''}. Archived tasks remain searchable and stay in exports.`);
