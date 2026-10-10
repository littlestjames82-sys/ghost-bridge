#!/usr/bin/env node
/**
 * ghost-bridge doctor — read-only diagnostics for a Ghost Bridge install (v4.4).
 *
 *   ghost-bridge doctor [--json] [--config <path-to-mcp-config.json>]
 *
 * Checks, in plain language with a fix for anything that isn't a PASS:
 *   - Node version (Ghost Bridge needs 18+)
 *   - version consistency across the 3 package.json files and the
 *     SERVER_VERSION / RELAY_VERSION code constants
 *   - the context file: a real mcp/context.json vs the EXAMPLE template,
 *     and whether it parses
 *   - the relay, when one is configured (GHOST_RELAY_URL / credentials):
 *     /health + /probe reachability, relay-vs-local version comparison,
 *     whether the bridge key is accepted and its scope (via harmless
 *     authed reads), and the offline-outbox pending count
 *   - an MCP client config, when one is passed with --config: does it
 *     parse, does it carry a ghost-bridge entry, does that entry point
 *     at a server.js that exists, is it wired to a relay or a queue repo
 *
 * Everything is READ-ONLY. Credentials are never printed — presence and
 * scope only. Exit code is 1 ONLY when a check FAILs; warnings exit 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: ghost-bridge doctor [--json] [--config <mcp-config.json>]\n\nRead-only health checks for this Ghost Bridge install. Exit 1 only on a FAIL.');
  process.exit(0);
}
const asJson = args.includes('--json');
const cfgIdx = args.indexOf('--config');
const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : null;

const checks = [];
const add = (name, status, detail, fix) => checks.push({ name, status, detail, ...(fix ? { fix } : {}) });
const readJsonFile = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---------- 1. Node version ----------
{
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) add('Node version', 'PASS', `v${process.versions.node} (Ghost Bridge needs 18+)`);
  else add('Node version', 'FAIL', `v${process.versions.node} is too old — Ghost Bridge needs Node 18 or newer`, 'Install Node 18+ from nodejs.org (or your package manager), then re-run doctor.');
}

// ---------- 2. Package version consistency ----------
let pkgVersion = null;
{
  const spots = [];
  const readVersion = (label, file) => {
    const doc = readJsonFile(path.join(root, file));
    spots.push([label, doc && doc.version ? String(doc.version) : null]);
  };
  readVersion('package.json', 'package.json');
  readVersion('mcp/package.json', 'mcp/package.json');
  readVersion('relay/package.json', 'relay/package.json');
  const grab = (label, file, re) => {
    let v = null;
    try { const m = fs.readFileSync(path.join(root, file), 'utf8').match(re); if (m) v = m[1]; } catch { /* missing */ }
    spots.push([label, v]);
  };
  grab('SERVER_VERSION (mcp/server.js)', 'mcp/server.js', /SERVER_VERSION = '([0-9.]+)'/);
  grab('RELAY_VERSION (relay/core.mjs)', 'relay/core.mjs', /RELAY_VERSION = '([0-9.]+)'/);
  const missing = spots.filter(([, v]) => !v).map(([l]) => l);
  const distinct = [...new Set(spots.map(([, v]) => v).filter(Boolean))];
  if (missing.length) {
    add('Package versions', 'FAIL', `could not read a version from: ${missing.join(', ')}`, 'Reinstall or re-extract the Ghost Bridge package — a version stamp is missing, so the tree is incomplete or damaged.');
  } else if (distinct.length === 1) {
    pkgVersion = distinct[0];
    add('Package versions', 'PASS', `v${pkgVersion} in all 3 package.json files and both code constants`);
  } else {
    add('Package versions', 'FAIL', `version mismatch — ${spots.map(([l, v]) => `${l}=${v}`).join(', ')}`, 'Set the SAME version in package.json, mcp/package.json, relay/package.json, SERVER_VERSION (mcp/server.js) and RELAY_VERSION (relay/core.mjs), then run npm test.');
  }
}

// ---------- 3. Context file ----------
{
  const realPath = path.join(root, 'mcp', 'context.json');
  const examplePath = path.join(root, 'mcp', 'context.example.json');
  if (fs.existsSync(realPath)) {
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(fs.readFileSync(realPath, 'utf8')); } catch (e) { parseErr = e; }
    if (parseErr) add('Context file', 'FAIL', 'mcp/context.json exists but is not valid JSON', 'Fix the JSON in mcp/context.json, or delete it and re-publish the context (PUT /api/context on the relay).');
    else if (!parsed || !Array.isArray(parsed.projects)) add('Context file', 'FAIL', 'mcp/context.json parses but has no "projects" array — the bridge cannot use it', 'Re-publish the context from Muse (it always carries profile/projects/rules), or restore a known-good context.json.');
    else add('Context file', 'PASS', `real context.json present and valid (${parsed.projects.length} project(s))`);
  } else if (fs.existsSync(examplePath)) {
    add('Context file', 'WARN', 'no real mcp/context.json — tools are running on the EXAMPLE context (placeholder projects)', 'For a real install: publish the context to your relay (PUT /api/context) or place a real context.json next to mcp/server.js. In the public source tree this warning is expected.');
  } else {
    add('Context file', 'FAIL', 'neither mcp/context.json nor mcp/context.example.json exists', 'Reinstall the package — the context template ships with it.');
  }
}

// ---------- 4. Relay (only when configured) ----------
const relayUrl = (process.env.GHOST_RELAY_URL || '').replace(/\/$/, '');
let relayKey = process.env.GHOST_BRIDGE_KEY || '';
if (!relayKey) {
  try { relayKey = fs.readFileSync(process.env.GHOST_KEY_FILE || path.join(os.homedir(), '.ghost-bridge', 'credentials'), 'utf8').trim().split(/\s+/)[0] || ''; } catch { /* no credentials file */ }
}
async function relayGet(p, withKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(relayUrl + p, { signal: ctrl.signal, headers: withKey ? { 'x-bridge-key': relayKey } : {} });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, data };
  } finally { clearTimeout(timer); }
}
if (!relayUrl && !relayKey) {
  add('Relay', 'SKIP', 'no relay configured here (GHOST_RELAY_URL unset, no credentials file) — relay checks skipped');
} else if (!relayUrl) {
  add('Relay', 'WARN', 'a bridge key exists but GHOST_RELAY_URL is not set, so there is nothing to check it against', 'Set GHOST_RELAY_URL to your relay (e.g. https://your-relay.example.com), or re-run: ghost-bridge setup --relay');
} else {
  let health = null, healthErr = null;
  try { health = await relayGet('/health', false); } catch (e) { healthErr = e; }
  if (healthErr) {
    add('Relay reachability', 'FAIL', `relay at ${relayUrl} did not answer /health (${healthErr.name === 'AbortError' ? 'timed out' : healthErr.message})`, 'Check GHOST_RELAY_URL is the relay\'s base URL and that the relay is deployed/running (try opening <relay>/health in a browser).');
  } else if (!health.data || health.status !== 200) {
    add('Relay reachability', 'FAIL', `/health answered HTTP ${health.status}`, 'The URL answers but does not look like a healthy Ghost Bridge relay — check the deployment and its logs.');
  } else {
    add('Relay reachability', 'PASS', `/health OK at ${relayUrl} — ${health.data.tasks} task(s), ${health.data.keys} key(s), ${health.data.events} event(s) in the log`);
    // Version comparison via /probe (also unauthenticated).
    try {
      const probe = await relayGet('/probe', false);
      const rv = probe.data && probe.data.version;
      if (rv && pkgVersion && rv !== pkgVersion) {
        add('Relay version', 'WARN', `relay runs v${rv}, this package is v${pkgVersion}`, 'Upgrade whichever is behind: redeploy relay/ to update the relay, or update this package — a version gap is exactly what this warning exists to catch before it confuses an agent.');
      } else if (rv) {
        add('Relay version', 'PASS', `relay runs v${rv} — matches this package`);
      }
    } catch { /* probe is a bonus; /health already proved reachability */ }
  }
  // Key acceptance + scope — harmless authed reads only.
  if (!relayKey) {
    add('Bridge key', 'WARN', 'no bridge key found (GHOST_BRIDGE_KEY unset, no ~/.ghost-bridge/credentials file)', 'Run: ghost-bridge setup --relay — it registers a key for this machine and stores it in ~/.ghost-bridge/credentials (never in the MCP config).');
  } else if (health && health.data) {
    try {
      const meta = await relayGet('/api/meta', true);
      if (meta.status === 401) {
        add('Bridge key', 'FAIL', 'the relay rejected this machine\'s bridge key (401)', 'The key was revoked or belongs to a different relay. Re-run: ghost-bridge setup --relay (or POST /api/keys with a full key to mint a fresh one for this machine).');
      } else if (meta.status === 200) {
        const keys = await relayGet('/api/keys', true);
        if (keys.status === 200) add('Bridge key', 'PASS', 'key accepted — scope: full (reads, writes, and key management all allowed)');
        else if (keys.status === 403) add('Bridge key', 'PASS', 'key accepted — scope: readonly (reads only; writes and key management will be refused, by design)');
        else add('Bridge key', 'PASS', 'key accepted (authed read OK)');
      } else {
        add('Bridge key', 'WARN', `authed read of /api/meta answered HTTP ${meta.status}`, 'The key may be fine but the relay is misbehaving — check the relay logs.');
      }
    } catch (e) {
      add('Bridge key', 'WARN', `could not verify the bridge key (${e.message})`, 'The relay answered /health but the authed check failed — retry; if it persists, check the relay deployment.');
    }
  }
  // Offline outbox pending count (local state, read-only).
  const outboxPath = process.env.GHOST_OUTBOX_PATH || path.join(os.homedir(), '.ghost-bridge', 'outbox.json');
  let pending = 0;
  try {
    const d = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
    pending = Array.isArray(d) ? d.length : (d && Array.isArray(d.entries) ? d.entries.length : 0);
  } catch { pending = 0; }
  if (pending > 0) add('Offline outbox', 'WARN', `${pending} handoff(s) sitting in the offline outbox (${outboxPath}) — queued during an outage, NOT yet delivered`, 'They flush automatically, in order, on the next successful ghost_bridge_status or ghost_handoff call once the relay answers. If the relay is healthy now, just call ghost_bridge_status from your MCP client.');
  else add('Offline outbox', 'PASS', 'offline outbox is empty — nothing waiting to be delivered');
}

// ---------- 5. MCP config (only when --config is given) ----------
if (!configPath) {
  add('MCP config', 'SKIP', 'no --config given — pass --config <path> to sanity-check a client MCP config');
} else if (!fs.existsSync(configPath)) {
  add('MCP config', 'FAIL', `${configPath} does not exist`, 'Point --config at your client\'s MCP config file (per-client paths are in docs/clients/).');
} else {
  const cfg = readJsonFile(configPath);
  if (!cfg) {
    add('MCP config', 'FAIL', `${configPath} is not valid JSON`, 'Fix the JSON (a trailing comma is the usual culprit), or regenerate the entry with: ghost-bridge setup');
  } else {
    const entry = cfg.mcpServers && cfg.mcpServers['ghost-bridge'];
    if (!entry) {
      add('MCP config', 'FAIL', `${configPath} has no "ghost-bridge" entry under mcpServers`, 'Run: ghost-bridge setup — it adds the entry for your client and keeps a backup of the old config.');
    } else {
      const serverArg = (entry.args || []).find(a => typeof a === 'string' && a.endsWith('server.js'));
      if (serverArg && !fs.existsSync(serverArg)) {
        add('MCP config', 'FAIL', `the ghost-bridge entry points at ${serverArg}, which does not exist`, 'The package moved — re-run: ghost-bridge setup — so the entry points at the current mcp/server.js.');
      } else {
        add('MCP config', 'PASS', `ghost-bridge entry present${serverArg ? ` and points at an existing server.js` : ''}`);
      }
      const env = entry.env || {};
      if ('GHOST_BRIDGE_KEY' in env || 'GHOST_BRIDGE_API_KEY' in env) {
        add('MCP config env', 'WARN', 'a bridge key is sitting in the MCP config env', 'Move it out: the key belongs in ~/.ghost-bridge/credentials (setup --relay writes it there, mode 0600). Configs get pasted into chats and screenshots; credentials files don\'t.');
      } else if (env.GHOST_RELAY_URL || env.GHOST_QUEUE_REPO) {
        add('MCP config env', 'PASS', env.GHOST_RELAY_URL ? 'entry is wired to a hosted relay (GHOST_RELAY_URL set; key stays in the credentials file)' : 'entry is wired to a GitHub queue repo (GHOST_QUEUE_REPO set)');
      } else {
        add('MCP config env', 'WARN', 'the entry sets neither GHOST_RELAY_URL nor GHOST_QUEUE_REPO — context tools work, but handoffs stay local files', 'Run: ghost-bridge setup --relay (hosted relay) or ghost-bridge setup (GitHub queue) to wire the live queue.');
      }
    }
  }
}

// ---------- report ----------
const summary = {
  pass: checks.filter(c => c.status === 'PASS').length,
  warn: checks.filter(c => c.status === 'WARN').length,
  fail: checks.filter(c => c.status === 'FAIL').length,
  skip: checks.filter(c => c.status === 'SKIP').length
};
const exitCode = summary.fail > 0 ? 1 : 0;
if (asJson) {
  console.log(JSON.stringify({ tool: 'ghost-bridge doctor', version: pkgVersion, ok: summary.fail === 0, checks, summary }, null, 2));
} else {
  console.log(`Ghost Bridge doctor${pkgVersion ? ` — v${pkgVersion}` : ''}\n`);
  for (const c of checks) {
    console.log(`${c.status.padEnd(4)}  ${c.name} — ${c.detail}`);
    if (c.fix) console.log(`      fix: ${c.fix}`);
  }
  console.log(`\ndoctor: ${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail · ${summary.skip} skip — ${summary.fail ? 'NEEDS ATTENTION' : 'OK'}`);
}
process.exit(exitCode);
