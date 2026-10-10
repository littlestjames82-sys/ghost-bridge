#!/usr/bin/env node
/**
 * Ghost Bridge one-command setup for Google Antigravity.
 *
 * What it does:
 *  1. Asks for your GitHub token (hidden input; or BRIDGE_TOKEN env for automation).
 *  2. Validates it against the queue repo BEFORE writing anything.
 *  3. Finds Antigravity's global mcp_config.json (~/.gemini/config/), backs it
 *     up, and merges in the ghost-bridge entry with the absolute server path.
 *
 * Usage:
 *   node setup.mjs           interactive setup
 *   node setup.mjs --check   validate token + existing config, change nothing
 *
 * Create the token first (2 minutes, only step on github.com):
 *   Settings → Developer settings → Personal access tokens → Fine-grained tokens
 *   Repository access: Only select repositories → ghost-bridge-queue
 *   Permissions: Issues = Read and write, Contents = Read-only, Metadata = Read-only
 * (If Antigravity runs as your-github-account, accept the repo invitation first.)
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = process.env.GHOST_QUEUE_REPO || 'your-username/your-queue-repo';
const API = (process.env.GHOST_GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const SERVER_PATH = path.join(__dirname, 'server.js');
const CHECK_ONLY = process.argv.includes('--check');
const ASSUME_YES = process.argv.includes('--yes');

function configPath() {
  const dir = process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), '.gemini', 'config');
  return path.join(dir, 'mcp_config.json');
}

async function gh(token, apiPath) {
  const res = await fetch(API + apiPath, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ghost-bridge-setup'
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(data && data.message) || res.statusText}`);
  return data;
}

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl._writeToOutput = function (str) {
      if (str.includes(question)) rl.output.write(str);
    };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
    rl.stdoutMuted = true;
  });
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function execGh(args) {
  return new Promise(resolve => {
    execFile('gh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function ghReady() {
  const v = await execGh(['--version']);
  if (v.err) return false;
  const a = await execGh(['auth', 'status']);
  return !a.err;
}

async function validateViaGh() {
  const r = await execGh(['api', `repos/${REPO}`]);
  if (r.err) throw new Error((r.stderr || 'gh api call failed').trim().slice(0, 200));
  const repo = JSON.parse(r.stdout);
  return { login: 'gh CLI session', repo, perms: repo.permissions || {} };
}

async function validateToken(token) {
  const me = await gh(token, '/user');
  const repo = await gh(token, `/repos/${REPO}`);
  const perms = repo.permissions || {};
  return { login: me.login, repo, perms };
}

function installPack() {
  const packSource = path.join(__dirname, 'antigravity-pack', 'AGENTS.md');
  const section = fs.readFileSync(packSource, 'utf8').trim();
  const globalAgents = path.join(os.homedir(), '.gemini', 'AGENTS.md');
  let existing = '';
  if (fs.existsSync(globalAgents)) existing = fs.readFileSync(globalAgents, 'utf8');
  const startMark = '<!-- ghost-bridge:start -->';
  const endMark = '<!-- ghost-bridge:end -->';
  let merged;
  if (existing.includes(startMark) && existing.includes(endMark)) {
    merged = existing.slice(0, existing.indexOf(startMark)) + section + existing.slice(existing.indexOf(endMark) + endMark.length);
    console.log('Antigravity pack: refreshed the Ghost section in your global AGENTS.md.');
  } else {
    merged = existing ? existing.replace(/\s*$/, '') + '\n\n' + section + '\n' : section + '\n';
    console.log('Antigravity pack: added the Ghost section to your global AGENTS.md.');
  }
  fs.mkdirSync(path.dirname(globalAgents), { recursive: true });
  fs.writeFileSync(globalAgents, merged);
  console.log(`Global rules: ${globalAgents}`);
  console.log('For per-project rules/workflows/skills, copy the .agents folder from antigravity-pack/ into a repo root.');
}

const RELAY_DEFAULT = 'https://YOUR-RELAY.example.com';

async function relaySetup() {
  const relayUrl = (process.env.BRIDGE_RELAY_URL || RELAY_DEFAULT).replace(/\/$/, '');
  console.log('Mode: hosted relay (Level 3) — no GitHub token needed.');
  console.log(`Relay: ${relayUrl}`);
  const credDir = path.join(os.homedir(), '.ghost-bridge');
  const credFile = path.join(credDir, 'credentials');
  let key = '';
  if (fs.existsSync(credFile)) key = fs.readFileSync(credFile, 'utf8').trim().split(/\s+/)[0] || '';
  if (!key) {
    const { randomBytes } = await import('node:crypto');
    key = randomBytes(24).toString('hex');
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(credFile, key + '\n', { mode: 0o600 });
    console.log(`Generated a new bridge key — saved only on this machine at ${credFile}.`);
  } else {
    console.log(`Using the bridge key already saved at ${credFile}.`);
  }
  const metaStatus = async () => {
    try { const res = await fetch(relayUrl + '/api/meta', { headers: { 'x-bridge-key': key } }); return res.status; }
    catch { return 0; }
  };
  if ((await metaStatus()) !== 200) {
    const code = process.env.BRIDGE_PAIRING_CODE || (await ask('Pairing code (Mr.Ghosty gave you this in Muse): '));
    const res = await fetch(relayUrl + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, setupSecret: String(code).trim() }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) { console.error('The relay rejected that pairing code. Nothing was changed.'); process.exit(1); }
    if (res.status === 409) { console.error('The relay already has a DIFFERENT key registered. Ask Mr.Ghosty in Muse to reset the relay key, then run this again. Nothing was changed.'); process.exit(1); }
    if (!res.ok) { console.error(`Relay setup failed (${res.status}): ${data.error || 'unknown error'}`); process.exit(1); }
    console.log('Bridge key registered with the relay.');
  } else {
    console.log("Relay already knows this machine's key — nothing to register.");
  }
  if ((await metaStatus()) !== 200) { console.error('Relay verification failed after registration. Nothing was changed.'); process.exit(1); }
  console.log('Relay verified — the key works.');
  if (CHECK_ONLY) { console.log('--check: validation passed, no files changed.'); return; }

  const file = configPath();
  let config = { mcpServers: {} };
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { config = JSON.parse(raw); } catch { console.error(`Existing config at ${file} is not valid JSON — fix it manually first. Nothing was changed.`); process.exit(1); }
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    console.log(`Backed up existing config to ${backup}`);
  }
  config.mcpServers['ghost-bridge'] = { command: 'node', args: [SERVER_PATH], env: { GHOST_RELAY_URL: relayUrl } };
  if (!ASSUME_YES) {
    const go = await ask('Write this into your Antigravity config? [y/N] ');
    if (!/^y(es)?$/i.test(go)) { console.log('Cancelled — nothing changed.'); return; }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`\nDone — ghost-bridge entry written to ${file} (relay mode; the key stays in ${credFile}, not in the config).`);
  if (process.argv.includes('--pack')) installPack();
  console.log('Next: restart Antigravity, then ask its agent:');
  console.log('  "Call ghost_bridge_status"  → should show the hosted relay reachable');
  console.log('One more step so Mr.Ghosty can work the queue from Muse: he will send you a');
  console.log('secure card in Muse — paste the key from ' + credFile + ' into it (never into chat).');
}

async function main() {
  console.log('Ghost Bridge setup — Antigravity ⇄ Mr.Ghosty live relay');
  console.log(`Queue repo: ${REPO}`);
  console.log(`Server:     ${SERVER_PATH}`);
  console.log(`Config:     ${configPath()}\n`);

  if (process.argv.includes('--relay')) { await relaySetup(); return; }

  if (process.argv.includes('--remove')) {
    const file = configPath();
    if (!fs.existsSync(file)) { console.log('No Antigravity config found — nothing to remove.'); return; }
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config.mcpServers || !config.mcpServers['ghost-bridge']) { console.log('ghost-bridge is not in the config — nothing to remove.'); return; }
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    delete config.mcpServers['ghost-bridge'];
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    console.log(`Removed the ghost-bridge entry (backup at ${backup}). Restart Antigravity to apply.`);
    return;
  }

  let token = process.env.BRIDGE_TOKEN || '';
  let useGh = false;
  if (!token) {
    if (await ghReady()) {
      useGh = true;
      console.log('GitHub CLI detected and logged in on this machine — no token needed.');
      console.log('The bridge will use your gh session. (Set GHOST_QUEUE_VIA_GH=0 to disable.)\n');
    } else if (CHECK_ONLY) {
      console.error('No BRIDGE_TOKEN provided and the GitHub CLI is not logged in — cannot validate. Nothing was changed.');
      process.exit(1);
    } else {
      console.log('Paste the fine-grained GitHub token for the queue repo.');
      console.log('(Issues: Read and write · Contents: Read-only · Metadata: Read-only)');
      console.log('Tip: if you install the GitHub CLI and run "gh auth login", this step disappears.');
      token = await askHidden('Token (input hidden): ');
    }
  }
  if (!token && !useGh) { console.error('No token given — nothing changed.'); process.exit(1); }

  let info;
  try {
    info = useGh ? await validateViaGh() : await validateToken(token);
  } catch (e) {
    console.error(`\nAuth check FAILED: ${e.message}`);
    console.error('Fixes: make sure the account in use has access to the repo,');
    console.error('the your-github-account collaborator invitation is accepted (if using that account),');
    console.error('and — for tokens — that it was copied without stray spaces. Nothing was changed.');
    process.exit(1);
  }
  console.log(`\nAuth OK — ${useGh ? 'gh CLI session' : `signed in as ${info.login}`}, repo reachable (push: ${info.perms.push ? 'yes' : 'no'}, admin: ${info.perms.admin ? 'yes' : 'no'}).`);
  if (!info.perms.push) {
    console.error('This token’s account cannot write to the queue repo, so handoffs would fail.');
    console.error('Accept the collaborator invitation or use the repo owner’s account. Nothing was changed.');
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log('--check: validation passed, no files changed.');
    return;
  }

  const file = configPath();
  let config = { mcpServers: {} };
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { config = JSON.parse(raw); } catch {
      console.error(`Existing config at ${file} is not valid JSON — fix it manually first. Nothing was changed.`);
      process.exit(1);
    }
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    console.log(`Backed up existing config to ${backup}`);
  }
  config.mcpServers['ghost-bridge'] = {
    command: 'node',
    args: [SERVER_PATH],
    env: useGh
      ? { GHOST_QUEUE_REPO: REPO, GHOST_QUEUE_VIA_GH: '1' }
      : { GHOST_QUEUE_REPO: REPO, GITHUB_TOKEN: token }
  };

  if (!ASSUME_YES && !process.env.BRIDGE_TOKEN) {
    const go = await ask('Write this into your Antigravity config? [y/N] ');
    if (!/^y(es)?$/i.test(go)) { console.log('Cancelled — nothing changed.'); return; }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`\nDone — ghost-bridge entry written to ${file}`);

  if (process.argv.includes('--pack')) installPack();
  console.log('Next: restart Antigravity, then ask its agent:');
  console.log('  "Call ghost_bridge_status"  → should show the relay reachable');
  console.log('  "Use ghost_handoff to send Mr.Ghosty a task: <your task>"');
  console.log('A watcher checks the queue every couple of minutes, so Mr.Ghosty usually picks tasks up fast and answers in the task thread.');
}

main().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
