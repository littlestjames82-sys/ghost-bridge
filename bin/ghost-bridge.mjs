#!/usr/bin/env node
/**
 * ghost-bridge — the one CLI for Ghost Bridge (Ghost Developer Studio).
 *
 *   npx ghost-bridge setup [--relay] [--pack] [--yes]   one-command setup
 *        (maps to mcp/setup.mjs — same flow as `node setup.mjs`, unchanged)
 *   npx ghost-bridge server [--http --port 8767]        run the local MCP server
 *   npx ghost-bridge relay [port]                       run the relay locally
 *   npx ghost-bridge demo                               self-proving demo
 *   npx ghost-bridge watch [--stream]                   tail relay events
 *   npx ghost-bridge backup [--out f] [--events]        export a whole relay
 *   npx ghost-bridge restore <backup.json> [--force]    import a backup
 *   npx ghost-bridge archive [--days 30]                archive old done/cancelled tasks
 *   npx ghost-bridge doctor [--json] [--config <path>]  read-only diagnostics
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [cmd, ...rest] = process.argv.slice(2);

const targets = {
  setup: ['mcp/setup.mjs', rest],
  server: ['mcp/server.js', rest],
  relay: ['relay/local-server.mjs', rest],
  demo: ['scripts/demo.mjs', rest],
  watch: ['scripts/watch.mjs', rest],
  backup: ['scripts/backup.mjs', rest],
  restore: ['scripts/restore.mjs', rest],
  archive: ['scripts/archive.mjs', rest],
  doctor: ['scripts/doctor.mjs', rest]
};

if (!cmd || cmd === 'help' || cmd === '--help' || !targets[cmd]) {
  console.log(`Ghost Bridge v4.4 — Ghost Developer Studio

Usage:
  ghost-bridge setup [--relay] [--pack] [--yes]   Set up the bridge for your MCP client
  ghost-bridge server [--http --port 8767]        Run the local MCP server (stdio by default)
  ghost-bridge relay [port]                       Run the relay locally (default 8877)
  ghost-bridge demo                               Boot a local relay and prove the loop end-to-end
  ghost-bridge watch [--stream]                   Tail task events from your relay as they happen
  ghost-bridge backup [--out f] [--events]        Export a whole relay (full-scope key, env GHOST_RELAY_URL/GHOST_BRIDGE_KEY)
  ghost-bridge restore <backup.json> [--force]    Import a backup into a relay (empty target, or --force to overwrite)
  ghost-bridge archive [--days 30]                Archive done/cancelled tasks older than N days (explicit only — never automatic)
  ghost-bridge doctor [--json] [--config <path>]  Read-only diagnostics: versions, context file, relay reachability, key scope, outbox, MCP config sanity`);
  process.exit(cmd && !targets[cmd] && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
}

const [file, args] = targets[cmd];
const child = spawn('node', [path.join(root, file), ...args], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
child.on('error', e => { console.error('ghost-bridge: failed to start:', e.message); process.exit(1); });
