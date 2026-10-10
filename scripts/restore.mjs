#!/usr/bin/env node
/**
 * ghost-bridge restore — import a backup into a relay (v4.2).
 *
 *   GHOST_RELAY_URL=https://YOUR-RELAY.example.com \
 *   GHOST_BRIDGE_KEY=<a FULL-SCOPE key on the TARGET relay> \
 *   node scripts/restore.mjs backup.json [--force]
 *
 * Safety: import restores into an EMPTY relay. If the target already has
 * tasks, the relay refuses (409) and nothing is written — pass --force to
 * overwrite, which sends the explicit {"confirm": "OVERWRITE"} the relay
 * demands (and prints a warning here first). Imported keys replace the
 * target's key list — except the key you restore WITH is preserved by the
 * relay (renamed "<name>-preimport" on a name collision) so you can't lock
 * yourself out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = (process.env.GHOST_RELAY_URL || '').replace(/\/$/, '');
let key = process.env.GHOST_BRIDGE_KEY || '';
if (!key) {
  try { key = fs.readFileSync(process.env.GHOST_KEY_FILE || path.join(os.homedir(), '.ghost-bridge', 'credentials'), 'utf8').trim().split(/\s+/)[0] || ''; } catch { /* none */ }
}
const [file, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
if (!url || !key || !file) { console.error('Usage: GHOST_RELAY_URL=… GHOST_BRIDGE_KEY=… node scripts/restore.mjs <backup.json> [--force]'); process.exit(1); }

let doc;
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`Cannot read backup file: ${e.message}`); process.exit(1); }
if (doc.format !== 'ghost-bridge-export' || !Array.isArray(doc.tasks) || !Array.isArray(doc.keys)) {
  console.error('That file is not a Ghost Bridge export (missing format/tasks/keys). Nothing sent.');
  process.exit(1);
}
if (force) console.error(`WARNING: --force — if ${url} already has tasks they will be OVERWRITTEN by this restore.`);

const res = await fetch(url + '/api/import' + (force ? '?force=true' : ''), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
  body: JSON.stringify(force ? { ...doc, confirm: 'OVERWRITE' } : doc)
});
const out = await res.json().catch(() => null);
if (!res.ok || !out?.ok) {
  console.error(`Import failed: HTTP ${res.status}${out?.error ? ' — ' + out.error : ''}`);
  process.exit(1);
}
console.error(`Restored into ${url}: ${out.imported.tasks} task(s), ${out.imported.files} file(s), ${out.imported.keys} key(s), context ${out.imported.context ? 'restored' : 'cleared'}, ${out.imported.events} event(s).`);
