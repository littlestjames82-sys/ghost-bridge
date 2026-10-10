#!/usr/bin/env node
/**
 * Ghost Bridge MCP — v4.4.0
 * Zero-dependency MCP server (stdio + optional HTTP) connecting Google
 * Antigravity (or any MCP client) to Mr.Ghosty, Ryan Cotten's Muse agent.
 *
 * Two layers:
 *  1. Context bridge — studio profile, project statuses, Ryan's rules,
 *     served from context.json next to this file.
 *  2. Live relay (Phase 2) — when GHOST_QUEUE_REPO and GITHUB_TOKEN are set,
 *     ghost_handoff files a real task as a GitHub Issue in that private repo.
 *     Mr.Ghosty is woken within a couple of minutes by a queue watcher (with scheduled pickups as backup), does the work
 *     under Ryan's standing rules, and posts the result back as a comment.
 *     ghost_inbox / ghost_task_result read status and results.
 *     Without those env vars, handoffs fall back to local files in ./handoffs/.
 *
 * Honest scope: Muse has no public personal-agent API. This bridge is the
 * working integration: shared context + a real task queue with an audit
 * trail — not a live chat with the Muse model inside Antigravity.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const HERE = __dirname;
const CONTEXT_PATH = process.env.GHOST_CONTEXT_PATH || path.join(HERE, 'context.json');
const HANDOFF_DIR = process.env.GHOST_HANDOFF_DIR || path.join(HERE, 'handoffs');
const SERVER_NAME = 'ghost-bridge';
const SERVER_VERSION = '4.4.0';
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const HANDOFF_LABEL = 'ghost-handoff';

function loadContext() {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_PATH, 'utf8'));
  } catch (e) {
    // Fresh public install: no context.json yet — fall back to the shipped
    // template so the tools still answer (with example data) instead of
    // failing. Copy context.example.json to context.json and make it yours.
    try {
      const example = JSON.parse(fs.readFileSync(path.join(HERE, 'context.example.json'), 'utf8'));
      example.bridge = (example.bridge || '') + ' [running on the EXAMPLE context — copy context.example.json to context.json to use your own]';
      return example;
    } catch { /* fall through to the empty context */ }
    return { profile: {}, projects: [], rules: [], updated: 'unknown', bridge: 'context.json failed to load: ' + e.message };
  }
}

// ---- Task attachments (v4) ----
// Same shape and caps as the relay: [{name, mime?, size?, path? (a relay
// file), dataBase64? (inline, max 256 KB decoded each, max 5)}].
const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1024;
const MAX_ATTACHMENTS = 5;
function normalizeAttachments(input) {
  if (input === undefined || input === null) return { list: [] };
  if (!Array.isArray(input)) return { error: 'attachments must be an array of {name, mime?, size?, path?, dataBase64?}' };
  if (input.length > MAX_ATTACHMENTS) return { error: `at most ${MAX_ATTACHMENTS} attachments per task` };
  const list = [];
  for (const a of input) {
    if (!a || !a.name) return { error: 'each attachment needs a name' };
    const out = { name: String(a.name).slice(0, 200), mime: a.mime ? String(a.mime).slice(0, 100) : 'application/octet-stream' };
    if (a.path) out.path = String(a.path).slice(0, 500);
    if (a.dataBase64) {
      const b64 = String(a.dataBase64);
      const bytes = Buffer.from(b64, 'base64').length;
      if (bytes > MAX_INLINE_ATTACHMENT_BYTES) return { error: `attachment "${out.name}" is too large inline (${bytes} bytes; max ${MAX_INLINE_ATTACHMENT_BYTES}). Upload it to the relay files API and pass its path instead.` };
      out.dataBase64 = b64;
      out.size = bytes;
    } else if (a.size !== undefined) {
      out.size = Number(a.size) || 0;
    }
    list.push(out);
  }
  return { list };
}
function attachmentSummary(list) {
  return (list || []).map(a => `- ${a.name} (${a.mime || 'application/octet-stream'}${a.size !== undefined ? `, ${a.size} bytes` : ''})${a.path ? ` — relay file: ${a.path}` : ''}${a.dataBase64 ? ' — inline data attached' : ''}`).join('\n');
}

// Live context: when the relay is configured, the freshest context.json is
// the one Mr.Ghosty publishes into the queue repo — fetch and cache it
// (5 min), falling back to the bundled snapshot on any failure, so the
// bridge never breaks because the network or repo is unavailable.
let contextCache = { data: null, source: null, fetchedAt: 0 };
const CONTEXT_TTL_MS = 5 * 60 * 1000;
async function getContext() {
  const now = Date.now();
  if (contextCache.data && now - contextCache.fetchedAt < CONTEXT_TTL_MS) return contextCache;
  const bundled = loadContext();
  const relay = relayConfig();
  if (relay.enabled) {
    try {
      const parsed = await relayFetch(relay, '/api/context');
      if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.rules)) {
        // contextVersion (v4.4) is additive on GET /api/context — older
        // relays simply don't send it, and the version lines stay absent.
        contextCache = { data: parsed, source: `live from the Ghost Bridge Relay (snapshot dated ${parsed.updated || 'unknown'})`, fetchedAt: now, contextVersion: typeof parsed.contextVersion === 'number' ? parsed.contextVersion : null };
        return contextCache;
      }
    } catch { /* fall through */ }
  }
  const cfg = queueConfig();
  if (cfg.enabled) {
    try {
      const file = await ghFetch(cfg, `/repos/${cfg.repo}/contents/context.json`);
      const decoded = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.rules)) {
        contextCache = { data: parsed, source: `live from queue repo ${cfg.repo} (snapshot dated ${parsed.updated || 'unknown'})`, fetchedAt: now };
        return contextCache;
      }
    } catch { /* fall through to the bundled snapshot */ }
  }
  contextCache = { data: bundled, source: `bundled snapshot (dated ${bundled.updated || 'unknown'})`, fetchedAt: now };
  return contextCache;
}

function queueConfig() {
  const repo = process.env.GHOST_QUEUE_REPO || '';
  const token = process.env.GHOST_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  const apiBase = (process.env.GHOST_GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  // Auth modes: a fine-grained token if one is set; otherwise the GitHub CLI
  // (`gh`) logged-in session on this machine — no token to create or paste.
  // GHOST_QUEUE_VIA_GH=0 disables the gh fallback.
  const mode = token ? 'token' : (process.env.GHOST_QUEUE_VIA_GH === '0' ? 'off' : 'gh');
  return { repo, token, apiBase, mode, enabled: !!(repo && mode !== 'off') };
}

// ---- Level 3: hosted relay transport ----
// When GHOST_RELAY_URL is set, the bridge talks to the hosted Ghost Bridge
// Relay (Netlify) instead of GitHub. The bridge key comes from
// GHOST_BRIDGE_KEY or the credentials file setup.mjs wrote
// (~/.ghost-bridge/credentials) — it never lives in the MCP config.
function relayConfig() {
  const url = (process.env.GHOST_RELAY_URL || '').replace(/\/$/, '');
  let key = process.env.GHOST_BRIDGE_KEY || '';
  if (!key) {
    const keyFile = process.env.GHOST_KEY_FILE || path.join(os.homedir(), '.ghost-bridge', 'credentials');
    try { key = fs.readFileSync(keyFile, 'utf8').trim().split(/\s+/)[0] || ''; } catch { /* no file */ }
  }
  return { url, key, enabled: !!(url && key) };
}

async function relayFetch(cfg, apiPath, options = {}) {
  const res = await fetch(cfg.url + apiPath, {
    method: options.method || 'GET',
    headers: { 'x-bridge-key': cfg.key, 'Content-Type': 'application/json', 'User-Agent': 'ghost-bridge-mcp' },
    body: options.body
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    // HTTP error RESPONSE from the relay (4xx/5xx). Tagged so callers can
    // tell it apart from a transport failure (fetch itself rejecting) —
    // the offline outbox only queues transport failures, never these.
    const e = new Error(`Relay ${res.status}: ${(data && data.error) || text.slice(0, 200)}`);
    e.relayStatus = res.status;
    e.relayData = data;
    throw e;
  }
  return data;
}

function isRelayHttpError(e) { return !!(e && e.relayStatus); }

// ---- Scheduling args (v4.3): `due` -> dueAt, `schedule` -> notBefore ----
function parseScheduleArg(v, label) {
  if (v === undefined || v === null || v === '') return { val: null };
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return { error: `invalid ${label} "${String(v).slice(0, 60)}" — not a recognizable date; use ISO 8601 (e.g. 2026-10-12T09:00:00Z)` };
  return { val: d.toISOString() };
}

// ---- Agent presence heartbeat (v4.3) ----
// The local MCP tells the relay "this client is here" so ghost_bridge_status
// (and the board) can show who is online. Best-effort by design: throttled
// to one beat per 30s per process, and a failed beat never fails a tool.
let lastHeartbeatAt = 0;
async function sendHeartbeat(relay) {
  const now = Date.now();
  if (now - lastHeartbeatAt < 30000) return;
  lastHeartbeatAt = now;
  try {
    await relayFetch(relay, '/api/presence', {
      method: 'POST',
      body: JSON.stringify({ displayName: process.env.GHOST_AGENT_NAME || 'Ghost Bridge MCP client', capabilities: ['mcp-client'], status: 'online' })
    });
  } catch { /* presence is a convenience, never a failure mode */ }
}

// ---- Offline outbox (v4.2) ----
// If the relay is UNREACHABLE (connection refused, DNS, timeout — i.e.
// fetch rejects before any HTTP response), a relay handoff is saved to a
// local outbox file instead of being lost, with an idempotency key minted
// at queue time so the eventual delivery can never create a duplicate.
// Later relay-touching tool calls (ghost_bridge_status, ghost_handoff)
// flush the outbox in order whenever the relay answers again. Relay HTTP
// errors (401/403/429/500 responses) are NOT queued — the relay heard the
// request and said no; that's a real answer, not an outage.
const OUTBOX_PATH = process.env.GHOST_OUTBOX_PATH || path.join(os.homedir(), '.ghost-bridge', 'outbox.json');
function loadOutbox() {
  try {
    const d = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    return Array.isArray(d) ? d : (d && Array.isArray(d.entries) ? d.entries : []);
  } catch { return []; }
}
function saveOutbox(entries) {
  try {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.writeFileSync(OUTBOX_PATH, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(OUTBOX_PATH, 0o600); } catch { /* best effort */ }
  } catch { /* the outbox is a safety net; failing to write it must not crash the tool call — the caller reports the failure */ }
}
let outboxLastFlush = null; // { at, flushed, pending, error? }
async function flushOutbox(relay) {
  const entries = loadOutbox();
  if (!entries.length) return { flushed: 0, pending: 0 };
  let flushed = 0;
  let stopped = null;
  const remaining = [];
  for (const entry of entries) {
    if (stopped) { remaining.push(entry); continue; }
    try {
      await relayFetch(relay, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: entry.title, body: entry.body, project: entry.project ?? null,
          priority: entry.priority || 'normal', type: 'task',
          attachments: entry.attachments || [], idempotencyKey: entry.idempotencyKey,
          dueAt: entry.dueAt || undefined, notBefore: entry.notBefore || undefined,
          blockedBy: Array.isArray(entry.blockedBy) && entry.blockedBy.length ? entry.blockedBy : undefined
        })
      });
      flushed += 1; // created OR duplicate-suppressed on the relay — either way it's filed exactly once
    } catch (e) { stopped = e; remaining.push(entry); }
  }
  saveOutbox(remaining);
  outboxLastFlush = { at: new Date().toISOString(), flushed, pending: remaining.length, ...(stopped ? { error: stopped.message } : {}) };
  return outboxLastFlush;
}
function queueToOutbox(entry) {
  const entries = loadOutbox();
  entries.push(entry);
  saveOutbox(entries);
  return entries.length;
}

function relayStatusLine(t) {
  const labels = t.labels || [];
  let status = t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'cancelled' : 'queued';
  if (labels.includes('in-progress')) status = 'in progress';
  if (labels.includes('needs-approval')) status = 'NEEDS RYAN APPROVAL';
  // Scheduling flags: the relay computes overdue/scheduled on reads; fall
  // back to the raw dates for stubs/older relays that don't.
  const overdue = t.overdue !== undefined ? t.overdue : (t.status === 'queued' && !!t.dueAt && Date.parse(t.dueAt) < Date.now());
  const scheduled = t.scheduled !== undefined ? t.scheduled : (t.status === 'queued' && !!t.notBefore && Date.parse(t.notBefore) > Date.now());
  // Dependencies (v4.4): the relay computes blocked + blockedByUnfinished
  // on reads; against an older relay, fall back to the raw blockedBy list.
  const blocked = t.blocked !== undefined ? t.blocked : (Array.isArray(t.blockedBy) && t.blockedBy.length > 0 && !['done', 'cancelled'].includes(t.status));
  const blockedBy = t.blockedByUnfinished && t.blockedByUnfinished.length ? t.blockedByUnfinished : (blocked ? (t.blockedBy || []) : []);
  return `#${t.id} [${status}] ${t.title}${overdue ? ' [OVERDUE]' : ''}${scheduled ? ` [scheduled — not before ${t.notBefore}]` : ''}${blocked ? ` [BLOCKED by ${blockedBy.map(i => '#' + i).join(', ')}]` : ''}`;
}

const { spawn } = require('child_process');
function ghCliFetch(cfg, apiPath, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const args = ['api', apiPath.replace(/^\//, ''), '--method', method];
    if (options.body) args.push('--input', '-');
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('gh CLI timed out after 30s — check "gh auth status" or set GITHUB_TOKEN instead.')); }, 30000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errOut += d; });
    child.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') return reject(new Error('GitHub CLI (gh) not found — install it and run "gh auth login", or set GITHUB_TOKEN in the MCP config instead.'));
      reject(new Error(`gh CLI failed to start: ${err.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = errOut.trim().slice(0, 300);
        return reject(new Error(`gh CLI failed: ${msg || 'exit ' + code} (if this is an auth error, run "gh auth login" or set GITHUB_TOKEN)`));
      }
      try { resolve(out.trim() ? JSON.parse(out) : null); }
      catch { reject(new Error('gh CLI returned non-JSON output')); }
    });
    if (options.body) child.stdin.write(options.body);
    child.stdin.end();
  });
}

async function ghFetch(cfg, apiPath, options = {}) {
  if (cfg.mode === 'gh') return ghCliFetch(cfg, apiPath, options);
  const res = await fetch(cfg.apiBase + apiPath, {
    ...options,
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ghost-bridge-mcp',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && data.message) || text.slice(0, 200) || res.statusText;
    throw new Error(`GitHub API ${res.status}: ${msg}`);
  }
  return data;
}

async function repoFileGet(cfg, pathInRepo) {
  let f;
  try {
    f = await ghFetch(cfg, `/repos/${cfg.repo}/contents/${pathInRepo}`);
  } catch (e) {
    if (String(e.message).includes('404')) return null; // not created yet — a normal state
    throw e;
  }
  if (!f || f.type !== 'file') return null;
  return { text: Buffer.from(String(f.content || '').replace(/\n/g, ''), 'base64').toString('utf8'), sha: f.sha };
}

async function repoFilePut(cfg, pathInRepo, text, message, sha) {
  const body = { message, content: Buffer.from(text, 'utf8').toString('base64') };
  if (sha) body.sha = sha;
  return ghFetch(cfg, `/repos/${cfg.repo}/contents/${pathInRepo}`, { method: 'PUT', body: JSON.stringify(body) });
}

const NOTE_LABEL = 'ghost-note';

// ---- Project capsules: shared working memory, one markdown file per
// project in the queue repo (capsules/<slug>.md). Both Antigravity and
// Mr.Ghosty read and update them, so context survives across sessions
// and across the two agents instead of living in one chat.
function capsuleTemplate(p) {
  return [
    `# Capsule — ${p.name}`,
    '',
    '_Shared working memory between Antigravity and Mr.Ghosty. Both sides keep this current: read it before working on the project, update it when state, decisions, or next steps change._',
    '',
    '## State',
    `${p.status} — ${p.summary}`,
    '',
    '## Decisions (locked)',
    '- None recorded yet.',
    '',
    '## Next',
    '- See the project status; replace this line as concrete next steps emerge.',
    '',
    '## Session log',
    `- ${new Date().toISOString().slice(0, 10)} — Capsule created from the studio context snapshot.`,
    ''
  ].join('\n');
}

function capsuleSectionReplace(md, heading, newBody) {
  const marker = `## ${heading}`;
  const start = md.indexOf(marker);
  if (start === -1) return md.replace(/\s*$/, '') + `\n\n${marker}\n${newBody}\n`;
  const bodyStart = md.indexOf('\n', start) + 1;
  const nextIdx = md.indexOf('\n## ', bodyStart);
  const end = nextIdx === -1 ? md.length : nextIdx + 1;
  return md.slice(0, bodyStart) + newBody.replace(/\s+$/, '') + '\n' + md.slice(end);
}

function capsuleLogAppend(md, note) {
  const line = `- ${new Date().toISOString().slice(0, 10)} — ${note}`;
  const marker = '## Session log';
  const start = md.indexOf(marker);
  if (start === -1) return md.replace(/\s*$/, '') + `\n\n${marker}\n${line}\n`;
  return md.replace(/\s*$/, '') + `\n${line}\n`;
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text: String(text) }], isError: !!isError };
}

// Local "seen" state for ghost_new_results: remembers each task's last
// updated_at this client has reported, so results surface once, not forever.
const STATE_PATH = process.env.GHOST_STATE_PATH || path.join(os.homedir(), '.ghost-bridge', 'state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { seen: {} }; }
}
function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* state is a convenience; never fail a tool call over it */ }
}

function findProject(ctx, slugOrName) {
  const q = String(slugOrName || '').toLowerCase().trim();
  if (!q) return null;
  return ctx.projects.find(p => p.slug === q || p.name.toLowerCase() === q || p.name.toLowerCase().includes(q) || p.slug.includes(q)) || null;
}

function issueStatusLine(issue) {
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name));
  let status = issue.state === 'closed' ? 'done' : 'queued';
  if (labels.includes('in-progress')) status = 'in progress';
  if (labels.includes('needs-approval')) status = 'NEEDS RYAN APPROVAL';
  return `#${issue.number} [${status}] ${issue.title}\n  ${issue.html_url}`;
}

const TOOLS = [
  {
    name: 'ghost_whoami',
    description: 'Who Mr.Ghosty and Ghost Developer Studio are, who Ryan Cotten is, how to work with him, and whether the live relay queue is connected. Call this first in a new session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      const p = ctx.profile;
      const q = queueConfig();
      return textResult([
        `Assistant: ${p.assistant}`,
        `Owner: ${p.owner}`,
        `Studio: ${p.studio}`,
        `Contact: ${p.studio_contact}`,
        `Facebook page: ${p.facebook_page}`,
        `Storefront (live): ${p.storefront_live}`,
        '',
        `How to work with Ryan: ${p.how_to_work_with_ryan}`,
        '',
        relayConfig().enabled
          ? `Live relay: CONNECTED via the hosted Ghost Bridge Relay (${relayConfig().url}) — handoffs are filed as relay tasks; a watcher checks the relay every couple of minutes and wakes Mr.Ghosty. Results come back in the task thread (see ghost_inbox / ghost_task_result).`
          : q.enabled
          ? `Live relay: CONNECTED — handoffs are filed as tasks in the private queue repo ${q.repo}, which a watcher checks every couple of minutes from Muse (scheduled pickups as backup). Auth: ${q.mode === 'token' ? 'fine-grained GitHub token from this MCP config' : 'the GitHub CLI (gh) logged-in session on this machine — no token in the config'}. Results come back as comments on the task (see ghost_inbox / ghost_task_result).`
          : 'Live relay: NOT configured in this MCP entry — handoffs are written to local files only. See the Ghost Bridge README setup.',
        '',
        `Context source: ${contextCache.source || `bundled snapshot (dated ${ctx.updated})`}`,
        ...(contextCache.contextVersion ? [`Context version: ${contextCache.contextVersion} (relay context history — older versions via GET /api/context/history)`] : []),
        `Context note: ${ctx.bridge}`
      ].join('\n'));
    }
  },
  {
    name: 'ghost_projects',
    description: 'List all Ghost Developer Studio projects with their current status. Optional "status" argument filters by a word in the status (e.g. "live", "parked", "working").',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false },
    run(ctx, args) {
      let list = ctx.projects;
      if (args && args.status) {
        const s = String(args.status).toLowerCase();
        list = list.filter(p => p.status.toLowerCase().includes(s));
      }
      if (!list.length) return textResult('No projects match that filter.');
      return textResult(list.map(p => `- ${p.name} [${p.slug}] — ${p.status}\n  ${p.summary}`).join('\n'));
    }
  },
  {
    name: 'ghost_project_status',
    description: 'Get the full status and summary for one Ghost project by slug or name (e.g. "ghostcut", "DevPulse", "Ghost Kernel").',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false },
    run(ctx, args) {
      const p = findProject(ctx, args && args.project);
      if (!p) return textResult(`No project found for "${args && args.project}". Known slugs: ${ctx.projects.map(x => x.slug).join(', ')}`, true);
      return textResult(`${p.name} [${p.slug}]\nStatus: ${p.status}\n\n${p.summary}`);
    }
  },
  {
    name: 'ghost_rules',
    description: "Ryan's standing rules for all Ghost Developer Studio work (spending, publishing, branding, parked projects, verification). Follow these in this workspace.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(ctx) {
      return textResult(ctx.rules.map((r, i) => `${i + 1}. ${r}`).join('\n'));
    }
  },
  {
    name: 'ghost_search',
    description: 'Keyword search across the bundled Ghost context (projects, rules, profile). Use when a question does not map to one project.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run(ctx, args) {
      const q = String((args && args.query) || '').toLowerCase();
      if (!q) return textResult('Provide a query.', true);
      const words = q.split(/\s+/).filter(w => w.length > 2);
      const hits = [];
      for (const p of ctx.projects) {
        const hay = `${p.name} ${p.slug} ${p.status} ${p.summary}`.toLowerCase();
        if (words.some(w => hay.includes(w))) hits.push(`PROJECT ${p.name} [${p.status}]: ${p.summary}`);
      }
      ctx.rules.forEach((r, i) => { if (words.some(w => r.toLowerCase().includes(w))) hits.push(`RULE ${i + 1}: ${r}`); });
      return textResult(hits.length ? hits.join('\n') : `No matches for "${args.query}" in the ${ctx.updated} context snapshot. Ask Ryan to have Mr.Ghosty refresh context.json if this should exist.`);
    }
  },
  {
    name: 'ghost_handoff',
    description: "Send a task to Mr.Ghosty (Ryan's Muse agent). With the live relay configured, this files a real task in the queue that Mr.Ghosty picks up from Muse about every 15 minutes and answers in the task thread; use ghost_inbox / ghost_task_result to follow it. Without the relay, it writes a local handoff file for Ryan to pass along. Use for work that needs Muse-side access (memory, accounts, phone, deployments, verification). Never include credentials or secrets in a task. Relay transport only (v4.2): if the relay is unreachable, the handoff is queued in a local offline outbox and delivered automatically (exactly once) when the relay answers again — the result will say QUEUED, not delivered.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        task: { type: 'string' },
        project: { type: 'string', description: 'Optional project slug this task belongs to' },
        priority: { type: 'string', enum: ['normal', 'urgent'], description: 'urgent tasks are picked up before other queued tasks' },
        due: { type: 'string', description: 'Optional (v4.3) due time as an ISO date (e.g. 2026-10-12T09:00:00Z). A task still queued past it is flagged OVERDUE on the board, in ghost_inbox, and in /health.' },
        schedule: { type: 'string', description: 'Optional (v4.3) not-before time as an ISO date. The task is filed now but pickup workers must SKIP it until that time — it is flagged [scheduled] meanwhile.' },
        blockedBy: { type: 'array', items: { type: 'number' }, description: 'Optional (v4.4, relay transport) task numbers that must finish first. The new task cannot be claimed until every blocker is done or cancelled; blockers must already exist or the handoff is refused. Alias: dependsOn.' },
        dependsOn: { type: 'array', items: { type: 'number' }, description: 'Optional (v4.4) alias for blockedBy.' },
        idempotencyKey: { type: 'string', description: 'Optional (v4.1, relay transport): re-filing with the same idempotency key from the same bridge key returns the existing task instead of creating a duplicate — safe retries after a timeout.' },
        attachments: {
          type: 'array',
          description: 'Optional files to send with the task (v4): each {name, mime?, size?, path? (a file already in the relay), dataBase64? (inline content, max 256 KB decoded each, max 5 files)}.',
          items: { type: 'object', properties: { name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'number' }, path: { type: 'string' }, dataBase64: { type: 'string' } }, required: ['name'] }
        }
      },
      required: ['title', 'task'], additionalProperties: false
    },
    async run(ctx, args) {
      const title = String((args && args.title) || 'Untitled task').trim();
      const task = String((args && args.task) || '').trim();
      if (!task) return textResult('A task description is required.', true);
      const att = normalizeAttachments(args && args.attachments);
      if (att.error) return textResult(`Not sent — ${att.error}`, true);
      const dueParsed = parseScheduleArg(args && args.due, 'due');
      if (dueParsed.error) return textResult(`Not sent — ${dueParsed.error}`, true);
      const schedParsed = parseScheduleArg(args && args.schedule, 'schedule');
      if (schedParsed.error) return textResult(`Not sent — ${schedParsed.error}`, true);
      const dueAt = dueParsed.val;
      const notBefore = schedParsed.val;
      // Dependencies (v4.4): blockedBy / dependsOn — task numbers that
      // must finish before this task can be claimed. Shape is validated
      // here; existence is enforced by the relay (400 -> "Not sent").
      const rawDeps = args && args.blockedBy !== undefined ? args.blockedBy : (args && args.dependsOn);
      let blockedBy = [];
      if (rawDeps !== undefined && rawDeps !== null) {
        if (!Array.isArray(rawDeps)) return textResult('Not sent — blockedBy must be an array of task numbers, e.g. blockedBy: [3, 5].', true);
        for (const v of rawDeps) {
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) return textResult(`Not sent — blockedBy entries must be positive task numbers, got ${JSON.stringify(v)}.`, true);
          if (!blockedBy.includes(n)) blockedBy.push(n);
        }
      }
      const schedBodyLines = [
        ...(dueAt ? [`Due: ${dueAt}`] : []),
        ...(notBefore ? [`Not before: ${notBefore} — pickup workers: skip this task until then.`] : []),
        ...(blockedBy.length ? [`Blocked by: ${blockedBy.map(i => '#' + i).join(', ')} — this task cannot be claimed until every blocker is done or cancelled.`] : [])
      ];
      const attachments = att.list;
      const proj = args && args.project ? findProject(ctx, args.project) : null;
      const projectLine = proj ? `Project: ${proj.name} [${proj.slug}] — ${proj.status}` : (args && args.project ? `Project (unmatched): ${args.project}` : 'Project: (none specified)');
      const cfg = queueConfig();
      const relay = relayConfig();
      if (relay.enabled) {
        await sendHeartbeat(relay);
        // Opportunistically deliver anything sitting in the offline outbox
        // from an earlier outage before filing the new handoff (order kept).
        try { await flushOutbox(relay); } catch { /* flush reports through ghost_bridge_status */ }
        const urgent = args && args.priority === 'urgent';
        const idempotencyKey = args && args.idempotencyKey ? String(args.idempotencyKey).slice(0, 200) : null;
        if (!idempotencyKey) {
          try {
            const open = await relayFetch(relay, '/api/tasks?state=open&type=task&limit=100');
            const dup = (open.tasks || []).find(t => String(t.title).trim().toLowerCase() === title.toLowerCase());
            if (dup) return textResult(`Not sent — an open task with this exact title already exists: #${dup.id} "${dup.title}". Follow that one with ghost_task_result, reply on it with ghost_reply, or retitle this task if it is genuinely different work.`, true);
          } catch { /* guard is best-effort */ }
        }
        const body = [
          projectLine,
          ...(proj ? ['', '## Project context (from Mr.Ghosty)', proj.summary, '', `Project capsule (shared working memory — read before starting, update when state changes): capsules/${proj.slug}.md in the relay.`, '', '## Standing rules that apply', ...ctx.rules.slice(0, 5).map(r => `- ${r}`)] : []),
          ...(schedBodyLines.length ? ['', ...schedBodyLines] : []),
          '',
          '## Task',
          task,
          '',
          '---',
          'Queued via Ghost Bridge relay from Google Antigravity. Mr.Ghosty: execute under Ryan\'s standing rules (no paid spend, draft-first for public posts, nothing destructive without approval — otherwise park as needs-approval). Post the full result as a comment here, then mark done.'
        ].join('\n');
        try {
          const created = await relayFetch(relay, '/api/tasks', { method: 'POST', body: JSON.stringify({ title, body, project: proj ? proj.slug : (args && args.project) || null, priority: urgent ? 'urgent' : 'normal', type: 'task', attachments, ...(idempotencyKey ? { idempotencyKey } : {}), ...(dueAt ? { dueAt } : {}), ...(notBefore ? { notBefore } : {}), ...(blockedBy.length ? { blockedBy } : {}) }) });
          if (created.duplicateSuppressed) return textResult(`Duplicate suppressed — this idempotency key was already filed as relay #${created.id} "${created.title}" (status: ${created.status}). No second task was created. Follow it with ghost_task_result (task ${created.id}).`);
          const schedNote = `${dueAt ? `\nDue: ${dueAt}.` : ''}${notBefore ? `\nScheduled: this task should NOT be picked up before ${notBefore} — pickup workers must skip it until then.` : ''}`;
          const depNote = blockedBy.length ? `\nBlocked by: ${blockedBy.map(i => '#' + i).join(', ')}${created.blocked ? ' — this task cannot be claimed until every blocker is done or cancelled' : ' — all blockers are already finished, so it can be claimed right away'}.` : '';
          return textResult(`Task sent to Mr.Ghosty — relay #${created.id}${urgent ? ' (URGENT — goes to the front of the queue)' : ''}: ${created.title}${attachments.length ? `\nAttachments: ${attachments.map(a => a.name).join(', ')}` : ''}${schedNote}${depNote}\n\nA watcher checks the relay every couple of minutes and wakes him (event watchers are woken instantly). Check progress with ghost_inbox and read the result with ghost_task_result (task ${created.id}). Ryan also gets a summary in Muse when it is done.`);
        } catch (e) {
          if (isRelayHttpError(e) && e.relayStatus === 400) {
            // The relay heard the request and refused it on validation
            // (e.g. a blockedBy task number that does not exist) — that
            // is a "Not sent" answer, never an outbox candidate.
            return textResult(`Not sent — ${(e.relayData && e.relayData.error) || e.message}`, true);
          }
          if (!isRelayHttpError(e)) {
            // Transport failure — the relay never heard this. Queue it in
            // the offline outbox with a freshly minted idempotency key so
            // the automatic flush later can't deliver it twice.
            const genKey = idempotencyKey || `outbox-${crypto.randomUUID()}`;
            const pending = queueToOutbox({
              idempotencyKey: genKey,
              title, body,
              project: proj ? proj.slug : (args && args.project) || null,
              priority: urgent ? 'urgent' : 'normal',
              attachments,
              dueAt: dueAt || undefined, notBefore: notBefore || undefined,
              blockedBy: blockedBy.length ? blockedBy : undefined,
              queuedAt: new Date().toISOString()
            });
            return textResult(`Relay unreachable (${e.message}) — this handoff was QUEUED locally in the offline outbox (${OUTBOX_PATH}), NOT delivered. It will be sent automatically the next time a bridge tool reaches the relay (ghost_bridge_status or another ghost_handoff flushes the outbox in order), and its queue-time idempotency key (${genKey}) guarantees it lands exactly once.\n\nOutbox: ${pending} queued handoff(s) pending. Tell Ryan the task is parked locally — it has NOT reached Mr.Ghosty yet.`, true);
          }
          return textResult(`Hosted relay failed (${e.message}). Falling back to the GitHub queue / local file below.`, true);
        }
      }

      if (cfg.enabled) {
        const urgent = args && args.priority === 'urgent';
        // Duplicate guard: an open task with the same title is almost always
        // an accidental re-send — stop and point at the existing one.
        try {
          const open = await ghFetch(cfg, `/repos/${cfg.repo}/issues?state=open&labels=${HANDOFF_LABEL}&per_page=100`);
          const dup = open.find(i => String(i.title).trim().toLowerCase() === title.toLowerCase());
          if (dup) return textResult(`Not sent — an open task with this exact title already exists: #${dup.number} "${dup.title}" (${dup.html_url}). Follow that one with ghost_task_result, reply on it with ghost_reply, or retitle this task if it is genuinely different work.`, true);
        } catch { /* guard is best-effort; proceed if the check itself fails */ }
        const body = [
          projectLine,
          ...(proj ? ['', '## Project context (from Mr.Ghosty)', proj.summary, '', `Project capsule (shared working memory — read before starting, update when state changes): capsules/${proj.slug}.md in this repo.`, '', '## Standing rules that apply', ...ctx.rules.slice(0, 5).map(r => `- ${r}`)] : []),
          ...(schedBodyLines.length ? ['', ...schedBodyLines] : []),
          '',
          '## Task',
          task,
          '',
          '---',
          'Queued via Ghost Bridge MCP from Google Antigravity. Mr.Ghosty: execute under Ryan\'s standing rules (no paid spend, draft-first for public posts, nothing destructive without approval — otherwise comment with label needs-approval). Post the full result as a comment here, then label done and close.',
          ...(attachments.length ? ['', '## Attachments', attachmentSummary(attachments.map(a => ({ ...a, dataBase64: a.dataBase64 ? 'yes' : undefined }))), '(Inline attachment data travels with the relay transport; the GitHub queue carries the metadata — fetch the files from the relay.)'] : [])
        ].join('\n');
        try {
          const issue = await ghFetch(cfg, `/repos/${cfg.repo}/issues`, {
            method: 'POST',
            body: JSON.stringify({ title, body, labels: urgent ? [HANDOFF_LABEL, 'urgent'] : [HANDOFF_LABEL] })
          });
          return textResult(`Task sent to Mr.Ghosty — queue #${issue.number}${urgent ? ' (URGENT — goes to the front of the queue)' : ''}: ${issue.title}\n${issue.html_url}\n\nA watcher checks the queue every couple of minutes, so pickup is usually fast. Check progress with ghost_inbox and read the result with ghost_task_result (issue ${issue.number}). Ryan also gets a summary in Muse when it is done.`);
        } catch (e) {
          return textResult(`Live relay failed (${e.message}). Falling back to a local handoff file — Ryan can pass it to Mr.Ghosty in Muse.`, true);
        }
      }

      fs.mkdirSync(HANDOFF_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
      const file = path.join(HANDOFF_DIR, `${stamp}-${slug}.md`);
      const body = [
        `# Handoff for Mr.Ghosty: ${title}`,
        '',
        `Created: ${new Date().toISOString()}`,
        'Source: Google Antigravity via Ghost Bridge MCP (local mode — relay not configured)',
        projectLine,
        ...(schedBodyLines.length ? ['', ...schedBodyLines] : []),
        '',
        '## Task',
        task,
        ...(attachments.length ? ['', '## Attachments', attachmentSummary(attachments)] : []),
        '',
        '## Studio rules reminder',
        ...ctx.rules.slice(0, 5).map(r => `- ${r}`),
        ''
      ].join('\n');
      fs.writeFileSync(file, body);
      return textResult(`Handoff written locally: ${file}\n\nThe live relay is not configured in this MCP entry, so nothing was sent. Ryan: drop this file into Muse, or finish the Phase 2 setup in the Ghost Bridge README to send tasks directly.`);
    }
  },
  {
    name: 'ghost_bridge_status',
    description: 'Health check for the Ghost Bridge: is the live relay configured and reachable, how many tasks are waiting / in progress / waiting on Ryan, and how fresh the context is. Use this to diagnose any bridge problem before asking Ryan.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const cfg = queueConfig();
      const relay = relayConfig();
      const lines = [`Ghost Bridge v${SERVER_VERSION}`, `Context source: ${contextCache.source || 'bundled snapshot'}`, ...(contextCache.contextVersion ? [`Relay context version: ${contextCache.contextVersion}`] : [])];
      if (relay.enabled) {
        lines.push(`Live relay: HOSTED relay at ${relay.url} (Level 3 — no GitHub involved)`);
        await sendHeartbeat(relay);
        let flush = null;
        try { flush = await flushOutbox(relay); } catch { /* reported below */ }
        try {
          const meta = await relayFetch(relay, '/api/meta');
          try {
            const pres = await relayFetch(relay, '/api/presence');
            if (pres && Array.isArray(pres.agents)) {
              lines.push(pres.agents.length
                ? `Online agents (seen in the last ${pres.windowMinutes ?? 10} min): ${pres.agents.map(a => `${a.displayName || a.name}${a.displayName ? ` (${a.name})` : ''} — ${a.status || 'online'}${(a.capabilities || []).length ? ` [${a.capabilities.join(', ')}]` : ''}`).join('; ')}`
                : 'Online agents: none seen recently.');
            }
          } catch { /* presence is best-effort; older relays may not have it */ }
          const list = await relayFetch(relay, '/api/tasks?state=open&type=task&limit=100');
          const tasks = list.tasks || [];
          lines.push(`Relay: reachable (relay v${meta.version}, ${meta.tasks} tasks total)`);
          lines.push(`Open tasks: ${tasks.length} (${tasks.filter(t => t.status === 'queued').length} waiting for pickup, ${tasks.filter(t => t.status === 'in-progress').length} in progress, ${tasks.filter(t => t.status === 'needs-approval').length} waiting on Ryan's approval)`);
          // Digest (v4.4): the relay's GET /api/digest folded into status
          // (no new tool). Older relays 404 and the section is skipped.
          try {
            const dg = await relayFetch(relay, '/api/digest?hours=24');
            if (dg && dg.counts && Array.isArray(dg.completed)) {
              const brief = arr => arr.slice(0, 5).map(t => `#${t.id} ${t.title}`).join('; ');
              lines.push('Digest (24h):');
              lines.push(`- Completed: ${dg.completed.length}${dg.completed.length ? ' — ' + brief(dg.completed) : ''}`);
              lines.push(`- Waiting on Ryan: ${dg.waitingOnOwner.length}${dg.waitingOnOwner.length ? ' — ' + brief(dg.waitingOnOwner) : ''}`);
              lines.push(`- Overdue: ${dg.overdue.length}${dg.overdue.length ? ' — ' + brief(dg.overdue) : ''}`);
              lines.push(`- Blocked: ${(dg.blocked || []).length}${(dg.blocked || []).length ? ' — ' + (dg.blocked || []).slice(0, 5).map(t => `#${t.id} ${t.title} (by ${t.blockedByUnfinished.map(i => '#' + i).join(', ')})`).join('; ') : ''}`);
              lines.push(`- New notes: ${dg.newNotes} · Agents seen: ${dg.agentsSeen && dg.agentsSeen.length ? dg.agentsSeen.map(a => a.displayName || a.name).join(', ') : 'none recently'}`);
            }
          } catch { /* digest is best-effort; pre-v4.4 relays don't have it */ }
          lines.push('Pickup: a watcher checks the relay every couple of minutes from Muse and wakes Mr.Ghosty when tasks land; scheduled sweeps run as backup.');
          if (meta.version !== SERVER_VERSION) lines.push(`Note: relay runs v${meta.version}, this client v${SERVER_VERSION} — ask Mr.Ghosty in Muse if anything misbehaves.`);
          else lines.push(`Version: v${SERVER_VERSION} (matches relay).`);
          if (flush && flush.flushed) lines.push(`Outbox: flushed ${flush.flushed} queued handoff(s) just now — ${flush.pending} pending.`);
          else lines.push(`Outbox: ${flush ? flush.pending : loadOutbox().length} pending.`);
          if (outboxLastFlush && outboxLastFlush.error) lines.push(`Outbox last flush: delivered ${outboxLastFlush.flushed}, stopped on: ${outboxLastFlush.error}`);
        } catch (e) {
          lines.push(`Relay: NOT reachable — ${e.message}`);
          lines.push(`Outbox: ${loadOutbox().length} pending — handoffs queued during the outage will flush automatically once the relay is reachable.`);
          lines.push('Likely fixes: bridge key missing or wrong (re-run node setup.mjs --relay in the ghost-bridge-mcp folder), or the relay is briefly down.');
        }
        return textResult(lines.join('\n'));
      }
      if (!cfg.enabled) {
        lines.push('Live relay: NOT configured — run node setup.mjs in the ghost-bridge-mcp folder (it sets GHOST_QUEUE_REPO and either a token or gh-CLI auth). Context tools and local-file handoffs still work.');
        return textResult(lines.join('\n'));
      }
      lines.push(`Live relay: configured for ${cfg.repo} (auth: ${cfg.mode === 'token' ? 'fine-grained token' : 'GitHub CLI session on this machine'})`);
      try {
        const repo = await ghFetch(cfg, `/repos/${cfg.repo}`);
        lines.push(`Queue repo: reachable (${repo.full_name}, private: ${repo.private})`);
        const open = await ghFetch(cfg, `/repos/${cfg.repo}/issues?state=open&labels=${HANDOFF_LABEL}&per_page=100`);
        const waiting = open.filter(i => !(i.labels || []).some(l => (typeof l === 'string' ? l : l.name) === 'in-progress' || (typeof l === 'string' ? l : l.name) === 'needs-approval')).length;
        const inProgress = open.filter(i => (i.labels || []).some(l => (typeof l === 'string' ? l : l.name) === 'in-progress')).length;
        const needsApproval = open.filter(i => (i.labels || []).some(l => (typeof l === 'string' ? l : l.name) === 'needs-approval')).length;
        lines.push(`Open tasks: ${open.length} (${waiting} waiting for pickup, ${inProgress} in progress, ${needsApproval} waiting on Ryan's approval)`);
        lines.push('Pickup: a queue watcher checks every couple of minutes from Muse and wakes Mr.Ghosty when tasks land; scheduled pickups run as backup.');
        try {
          const vf = await ghFetch(cfg, `/repos/${cfg.repo}/contents/version.json`);
          const manifest = JSON.parse(Buffer.from(String(vf.content || '').replace(/\n/g, ''), 'base64').toString('utf8'));
          if (manifest.latest && manifest.latest !== SERVER_VERSION) {
            lines.push(`Update available: Ghost Bridge v${manifest.latest} (this client runs v${SERVER_VERSION}). Ask Mr.Ghosty in Muse for the new package — your config and token carry over.`);
          } else if (manifest.latest) {
            lines.push(`Version: v${SERVER_VERSION} (latest).`);
          }
        } catch { /* manifest is optional */ }
      } catch (e) {
        lines.push(`Queue repo: NOT reachable — ${e.message}`);
        lines.push('Likely fixes: token expired or revoked (make a new fine-grained token for this repo: Issues Read+Write, Contents Read, Metadata Read), token pasted with stray spaces, or the collaborator invitation for this GitHub account has not been accepted yet.');
      }
      return textResult(lines.join('\n'));
    }
  },
  {
    name: 'ghost_inbox',
    description: 'List recent Ghost Bridge tasks and their live status (queued / in progress / needs approval / done) from the relay queue. limit + offset page through the queue (newest first). Requires the live relay to be configured.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many tasks to show (default 10, max 30)' }, offset: { type: 'number', description: 'How many newest tasks to skip first (default 0) — page with limit' } }, additionalProperties: false },
    async run(ctx, args) {
      const cfg = queueConfig();
      const relay = relayConfig();
      const limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 10, 1), 30);
      const offset = Math.max(parseInt(args && args.offset, 10) || 0, 0);
      if (relay.enabled) {
        try {
          const data = await relayFetch(relay, `/api/tasks?state=all&type=task&limit=${limit}${offset ? `&offset=${offset}` : ''}`);
          if (!data.tasks.length) return textResult('The queue is empty — no tasks have been sent yet.');
          return textResult(data.tasks.map(relayStatusLine).join('\n'));
        } catch (e) { return textResult(`Could not read the relay queue: ${e.message}`, true); }
      }
      if (!cfg.enabled) return textResult('Live relay is not configured in this MCP entry (GHOST_QUEUE_REPO missing, or no usable GitHub auth), so there is no queue to read. Run node setup.mjs in the ghost-bridge-mcp folder.', true);
      try {
        const issues = await ghFetch(cfg, `/repos/${cfg.repo}/issues?state=all&labels=${HANDOFF_LABEL}&per_page=${limit + offset}&sort=created&direction=desc`);
        const page = issues.slice(offset, offset + limit);
        if (!page.length) return textResult('The queue is empty — no tasks have been sent yet.');
        return textResult(page.map(issueStatusLine).join('\n'));
      } catch (e) {
        return textResult(`Could not read the queue: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_task_result',
    description: 'Read one Ghost Bridge task by its queue number: current status plus all comments, including Mr.Ghosty\'s result when done. Requires the live relay.',
    inputSchema: { type: 'object', properties: { issue: { type: 'number' } }, required: ['issue'], additionalProperties: false },
    async run(ctx, args) {
      const cfg = queueConfig();
      if (!cfg.enabled && !relayConfig().enabled) return textResult('Live relay is not configured in this MCP entry (GHOST_QUEUE_REPO / GITHUB_TOKEN missing). See the Ghost Bridge README, Phase 2 setup.', true);
      const n = parseInt(args && args.issue, 10);
      if (!n) return textResult('Provide the queue issue number, e.g. 3.', true);
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          const task = await relayFetch(relay, `/api/tasks/${n}`);
          const lines = [relayStatusLine(task), '', `Task:\n${task.body || '(no body)'}`];
          if (Array.isArray(task.blockedBy) && task.blockedBy.length) {
            lines.push('', task.blocked
              ? `Blocked by: ${task.blockedBy.map(i => '#' + i).join(', ')} — still waiting on ${(task.blockedByUnfinished || []).map(i => '#' + i).join(', ')}. This task cannot be claimed until every blocker is done or cancelled.`
              : `Blocked by: ${task.blockedBy.map(i => '#' + i).join(', ')} — all blockers finished, so this task is ready to claim.`);
          }
          if (task.dueAt) lines.push('', `Due: ${task.dueAt}${task.overdue ? ' (OVERDUE — still queued past its due time)' : ''}`);
          if (task.notBefore) lines.push('', `Scheduled: not before ${task.notBefore} — pickup workers should skip this task until then.`);
          if (task.archived) lines.push('', `Archived: ${task.archivedAt || 'yes'} (kept for the record; out of the working queue)`);
          if (task.claimedBy) lines.push('', `Claimed by: ${task.claimedBy}${task.claimExpiresAt ? ` (lease expires ${task.claimExpiresAt})` : ''}`);
          if ((task.attachments || []).length) {
            lines.push('', '--- Attachments ---', attachmentSummary(task.attachments));
          }
          if (task.result) {
            lines.push('', `--- Structured result ---\nStatus: ${task.result.status}\nSummary: ${task.result.summary || '(none)'}${(task.result.files || []).length ? `\nFiles: ${task.result.files.join(', ')}` : ''}`);
          }
          if ((task.comments || []).length) {
            lines.push('', '--- Thread ---');
            for (const c of task.comments.slice(-10)) {
              const b = c.body.length > 4000 ? c.body.slice(0, 4000) + '\n…[truncated]' : c.body;
              lines.push(`\n@${c.author} (${c.at}):\n${b}`);
              if (c.result) lines.push(`Structured result: status=${c.result.status}, summary=${c.result.summary || '(none)'}${(c.result.files || []).length ? `, files=${c.result.files.join(', ')}` : ''}`);
            }
          } else {
            lines.push('', 'No comments yet — Mr.Ghosty has not picked this up yet (a watcher checks the relay every couple of minutes).');
          }
          return textResult(lines.join('\n'));
        } catch (e) { return textResult(`Could not read task #${n}: ${e.message}`, true); }
      }
      try {
        const issue = await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}`);
        const comments = await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}/comments?per_page=100`);
        const lines = [issueStatusLine(issue), '', `Task:\n${issue.body || '(no body)'}`];
        if (comments.length) {
          lines.push('', '--- Thread ---');
          for (const c of comments.slice(-10)) {
            const body = c.body.length > 4000 ? c.body.slice(0, 4000) + '\n…[truncated]' : c.body;
            lines.push(`\n@${c.user.login} (${c.created_at}):\n${body}`);
          }
        } else {
          lines.push('', 'No comments yet — Mr.Ghosty has not picked this up yet (a watcher checks the queue every couple of minutes).');
        }
        return textResult(lines.join('\n'));
      } catch (e) {
        return textResult(`Could not read task #${n}: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_reply',
    description: "Reply on a Ghost Bridge task thread — most importantly, answer a task that is waiting on Ryan's approval (needs-approval). The reply is posted as a comment and the needs-approval label is removed, so Mr.Ghosty resumes the task on his next pickup (about every 15 minutes) with Ryan's answer in the thread. Requires the live relay.",
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number' },
        message: { type: 'string', description: "Ryan's answer or additional instruction for this task" }
      },
      required: ['issue', 'message'], additionalProperties: false
    },
    async run(ctx, args) {
      const cfg = queueConfig();
      if (!cfg.enabled && !relayConfig().enabled) return textResult('Live relay is not configured in this MCP entry. See the Ghost Bridge README, Phase 2 setup.', true);
      const n = parseInt(args && args.issue, 10);
      const message = String((args && args.message) || '').trim();
      if (!n || !message) return textResult('Provide the issue number and the reply message.', true);
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          const task = await relayFetch(relay, `/api/tasks/${n}`);
          await relayFetch(relay, `/api/tasks/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: `Reply from Ryan (via Antigravity):\n\n${message}`, author: 'ryan-via-antigravity' }) });
          if (task.status === 'needs-approval') await relayFetch(relay, `/api/tasks/${n}`, { method: 'PATCH', body: JSON.stringify({ status: 'queued' }) });
          return textResult(`Reply posted on task #${n} and the needs-approval hold cleared. Mr.Ghosty will resume it on his next pickup (a watcher checks every couple of minutes). Follow it with ghost_task_result (task ${n}).`);
        } catch (e) { return textResult(`Could not reply on task #${n}: ${e.message}`, true); }
      }
      try {
        await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: `Reply from Ryan (via Antigravity):\n\n${message}` }) });
        try { await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}/labels/needs-approval`, { method: 'DELETE' }); } catch { /* label may not be set */ }
        return textResult(`Reply posted on task #${n} and the needs-approval hold cleared. Mr.Ghosty will resume it on his next pickup (about every 15 minutes). Follow it with ghost_task_result (issue ${n}).`);
      } catch (e) {
        return textResult(`Could not reply on task #${n}: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_cancel_task',
    description: 'Cancel a queued Ghost Bridge task before Mr.Ghosty picks it up (or stop one waiting on approval). Posts a cancellation note, labels it cancelled, and closes it. Requires the live relay.',
    inputSchema: { type: 'object', properties: { issue: { type: 'number' } }, required: ['issue'], additionalProperties: false },
    async run(ctx, args) {
      const cfg = queueConfig();
      if (!cfg.enabled && !relayConfig().enabled) return textResult('Live relay is not configured in this MCP entry. See the Ghost Bridge README, Phase 2 setup.', true);
      const n = parseInt(args && args.issue, 10);
      if (!n) return textResult('Provide the queue issue number.', true);
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          await relayFetch(relay, `/api/tasks/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Cancelled from Antigravity via Ghost Bridge before completion.', author: 'antigravity' }) });
          await relayFetch(relay, `/api/tasks/${n}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
          return textResult(`Task #${n} cancelled. If Mr.Ghosty was already working on it, he will see the cancellation in the thread; anything already done cannot be un-done from here.`);
        } catch (e) { return textResult(`Could not cancel task #${n}: ${e.message}`, true); }
      }
      try {
        await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: 'Cancelled from Antigravity via Ghost Bridge before completion.' }) });
        await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}/labels`, { method: 'POST', body: JSON.stringify({ labels: ['cancelled'] }) });
        await ghFetch(cfg, `/repos/${cfg.repo}/issues/${n}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
        return textResult(`Task #${n} cancelled and closed. If Mr.Ghosty was already working on it (in-progress), he will see the cancellation in the thread; anything already done cannot be un-done from here.`);
      } catch (e) {
        return textResult(`Could not cancel task #${n}: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_new_results',
    description: 'Show Ghost Bridge tasks with activity since this client last checked (new results, approval requests, status changes) — each task is reported once, then marked seen locally. Call this when starting work or returning to Antigravity to catch up on what Mr.Ghosty finished. Requires the live relay.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const cfg = queueConfig();
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          const data = await relayFetch(relay, '/api/tasks?state=all&type=task&limit=30');
          const tasks = (data.tasks || []).slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
          const state = loadState();
          const firstRun = !state.seenRelay || Object.keys(state.seenRelay).length === 0;
          state.seenRelay = state.seenRelay || {};
          const fresh = tasks.filter(t => state.seenRelay[String(t.id)] !== t.updatedAt);
          for (const t of tasks) state.seenRelay[String(t.id)] = t.updatedAt;
          saveState(state);
          if (!fresh.length) return textResult('No new Ghost Bridge activity since the last check.');
          return textResult((firstRun ? 'Recent Ghost Bridge activity (first check from this client):\n' : 'New Ghost Bridge activity:\n') + fresh.map(relayStatusLine).join('\n') + '\n\nRead a full thread with ghost_task_result.');
        } catch (e) { return textResult(`Could not check for new results: ${e.message}`, true); }
      }
      if (!cfg.enabled) return textResult('Live relay is not configured in this MCP entry. See the Ghost Bridge README, Phase 2 setup.', true);
      try {
        const issues = await ghFetch(cfg, `/repos/${cfg.repo}/issues?state=all&labels=${HANDOFF_LABEL}&per_page=30&sort=updated&direction=desc`);
        const state = loadState();
        const firstRun = !state.seen || Object.keys(state.seen).length === 0;
        const fresh = issues.filter(i => state.seen[String(i.number)] !== i.updated_at);
        for (const i of issues) state.seen[String(i.number)] = i.updated_at;
        saveState(state);
        if (!fresh.length) return textResult('No new Ghost Bridge activity since the last check.');
        const lines = fresh.map(issueStatusLine);
        return textResult((firstRun ? 'Recent Ghost Bridge activity (first check from this client):\n' : 'New Ghost Bridge activity:\n') + lines.join('\n') + '\n\nRead a full thread with ghost_task_result.');
      } catch (e) {
        return textResult(`Could not check for new results: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_search_tasks',
    description: 'Search past and current Ghost Bridge tasks (titles, bodies, and status) by keywords — e.g. to find whether something was already asked, or what Mr.Ghosty answered before. Requires the live relay.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    async run(ctx, args) {
      const cfg = queueConfig();
      if (!cfg.enabled && !relayConfig().enabled) return textResult('Live relay is not configured in this MCP entry. See the Ghost Bridge README, Phase 2 setup.', true);
      const q = String((args && args.query) || '').trim();
      if (!q) return textResult('Provide search keywords.', true);
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          const data = await relayFetch(relay, `/api/tasks?state=all&type=task&limit=100&q=${encodeURIComponent(q)}`);
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          // Search is the one list surface that also looks into the
          // archive — archived hits are marked, never mistaken for live work.
          let archived = [];
          try {
            const arch = await relayFetch(relay, `/api/tasks?state=all&type=task&archived=1&limit=100&q=${encodeURIComponent(q)}`);
            archived = arch.tasks || [];
          } catch { /* older relays have no archive — search the live set only */ }
          const liveHits = (data.tasks || []).filter(t => words.some(w => (t.title + ' ' + t.body + ' ' + (t.comments || []).map(c => c.body).join(' ')).toLowerCase().includes(w)));
          const archHits = archived.filter(t => words.some(w => (t.title + ' ' + t.body + ' ' + (t.comments || []).map(c => c.body).join(' ')).toLowerCase().includes(w)));
          const hits = [...liveHits.map(h => ({ t: h, arch: false })), ...archHits.map(h => ({ t: h, arch: true }))].slice(0, 10);
          return textResult(hits.length ? hits.map(h => `${h.arch ? '[archived] ' : ''}${relayStatusLine(h.t)}`).join('\n') : `No Ghost Bridge tasks match "${q}".`);
        } catch (e) { return textResult(`Search failed: ${e.message}`, true); }
      }
      try {
        const query = encodeURIComponent(`repo:${cfg.repo} label:${HANDOFF_LABEL} ${q}`);
        const data = await ghFetch(cfg, `/search/issues?q=${query}&per_page=10`);
        const items = data.items || [];
        if (!items.length) return textResult(`No Ghost Bridge tasks match "${q}".`);
        return textResult(items.map(issueStatusLine).join('\n'));
      } catch (e) {
        return textResult(`Search failed: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_capsule',
    description: 'Read the shared project capsule — the living working memory for one project (state, locked decisions, next steps, session log) kept in the queue repo and maintained by BOTH Antigravity and Mr.Ghosty. Read this before working on a project; it is fresher and more specific than the context snapshot. Auto-creates the capsule from the snapshot on first read. Requires the live relay.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false },
    async run(ctx, args) {
      const cfg = queueConfig();
      const p = findProject(ctx, args && args.project);
      if (!p) return textResult(`No project found for "${args && args.project}". Known slugs: ${ctx.projects.map(x => x.slug).join(', ')}`, true);
      if (!cfg.enabled && !relayConfig().enabled) return textResult(`Capsules live in the queue repo / hosted relay and need the live relay. Snapshot state for ${p.name}: ${p.status} — ${p.summary}`, true);
      const pathInRepo = `capsules/${p.slug}.md`;
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          try {
            const f = await relayFetch(relay, `/api/files?path=${encodeURIComponent(pathInRepo)}`);
            return textResult(f.text);
          } catch (e) {
            if (!String(e.message).includes('404')) throw e;
            const created = capsuleTemplate(p);
            await relayFetch(relay, '/api/files', { method: 'PUT', body: JSON.stringify({ path: pathInRepo, text: created }) });
            return textResult(`Capsule created for ${p.name} (capsules/${p.slug}.md in the relay):\n\n${created}`);
          }
        } catch (e) { return textResult(`Could not read capsule for ${p.name}: ${e.message}`, true); }
      }
      try {
        let file = await repoFileGet(cfg, pathInRepo);
        if (!file) {
          const created = capsuleTemplate(p);
          await repoFilePut(cfg, pathInRepo, created, `capsule: create ${p.slug}`);
          return textResult(`Capsule created for ${p.name} (capsules/${p.slug}.md in the queue repo):\n\n${created}`);
        }
        return textResult(file.text);
      } catch (e) {
        return textResult(`Could not read capsule for ${p.name}: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_capsule_update',
    description: 'Update a project capsule after working on it: replace the State, Decisions, or Next sections (pass the full new text for a section), and/or append a dated line to the Session log (note). This is how Antigravity keeps Mr.Ghosty current between tasks — and he does the same for you. Requires the live relay.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        state: { type: 'string', description: 'New full text for the State section' },
        decisions: { type: 'string', description: 'New full text for the Decisions (locked) section' },
        next: { type: 'string', description: 'New full text for the Next section' },
        note: { type: 'string', description: 'One-line session log entry (dated automatically)' }
      },
      required: ['project'], additionalProperties: false
    },
    async run(ctx, args) {
      const cfg = queueConfig();
      if (!cfg.enabled && !relayConfig().enabled) return textResult('Capsules need the live relay. Run node setup.mjs in the ghost-bridge-mcp folder.', true);
      const p = findProject(ctx, args && args.project);
      if (!p) return textResult(`No project found for "${args && args.project}".`, true);
      if (!args.state && !args.decisions && !args.next && !args.note) return textResult('Provide at least one of: state, decisions, next, note.', true);
      const pathInRepo = `capsules/${p.slug}.md`;
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          let md = null, readRev;
          try { const f = await relayFetch(relay, `/api/files?path=${encodeURIComponent(pathInRepo)}`); md = f.text; readRev = typeof f.rev === 'number' ? f.rev : undefined; } catch { md = null; }
          if (md === null) md = capsuleTemplate(p);
          if (args.state) md = capsuleSectionReplace(md, 'State', String(args.state));
          if (args.decisions) md = capsuleSectionReplace(md, 'Decisions (locked)', String(args.decisions));
          if (args.next) md = capsuleSectionReplace(md, 'Next', String(args.next));
          if (args.note) md = capsuleLogAppend(md, String(args.note));
          try {
            const w = await relayFetch(relay, '/api/files', {
              method: 'PUT',
              body: JSON.stringify({ path: pathInRepo, text: md, ...(readRev !== undefined ? { expectedRev: readRev } : {}) })
            });
            return textResult(`Capsule for ${p.name} updated (capsules/${p.slug}.md in the relay)${typeof w.rev === 'number' ? ` — now rev ${w.rev}` : ''}. Mr.Ghosty reads capsules on pickup, so he will work from this state.`);
          } catch (e) {
            if (e && e.relayStatus === 409) {
              // Optimistic concurrency (v4.3): another agent wrote this
              // capsule between our read and our write. Surface it clearly
              // instead of the old last-write-wins silent clobber.
              let currentRev = e.relayData && typeof e.relayData.currentRev === 'number' ? e.relayData.currentRev : undefined;
              if (currentRev === undefined) {
                try { currentRev = (await relayFetch(relay, `/api/files?path=${encodeURIComponent(pathInRepo)}`)).rev; } catch { /* message below works without it */ }
              }
              return textResult(`Capsule for ${p.name} was NOT updated — revision conflict: another agent changed capsules/${p.slug}.md first${currentRev !== undefined ? ` (it is now at rev ${currentRev}; you read rev ${readRev})` : ''}. Nothing was overwritten. Re-read the capsule with ghost_capsule, merge your changes into the current text, then update again.`, true);
            }
            throw e;
          }
        } catch (e) { return textResult(`Could not update capsule for ${p.name}: ${e.message}`, true); }
      }
      try {
        let file = await repoFileGet(cfg, pathInRepo);
        let md = file ? file.text : capsuleTemplate(p);
        if (args.state) md = capsuleSectionReplace(md, 'State', String(args.state));
        if (args.decisions) md = capsuleSectionReplace(md, 'Decisions (locked)', String(args.decisions));
        if (args.next) md = capsuleSectionReplace(md, 'Next', String(args.next));
        if (args.note) md = capsuleLogAppend(md, String(args.note));
        await repoFilePut(cfg, pathInRepo, md, `capsule: update ${p.slug} (via Antigravity)`, file ? file.sha : undefined);
        return textResult(`Capsule for ${p.name} updated (capsules/${p.slug}.md). Mr.Ghosty reads capsules on pickup, so he will work from this state.`);
      } catch (e) {
        return textResult(`Could not update capsule for ${p.name}: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_publish_note',
    description: "Send Mr.Ghosty a note that is NOT a task — a decision Ryan made, something learned about a project, a change of direction. Notes land in his pickup sweep: he reads them, folds them into his memory and the project capsules, and acknowledges them. For work you want done, use ghost_handoff instead. Requires the live relay.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        project: { type: 'string', description: 'Optional project slug the note is about' }
      },
      required: ['title', 'body'], additionalProperties: false
    },
    async run(ctx, args) {
      const cfg = queueConfig();
      if (!cfg.enabled && !relayConfig().enabled) return textResult('Notes need the live relay. Run node setup.mjs in the ghost-bridge-mcp folder.', true);
      const title = String((args && args.title) || '').trim();
      const bodyText = String((args && args.body) || '').trim();
      if (!title || !bodyText) return textResult('A note needs a title and a body.', true);
      const proj = args && args.project ? findProject(ctx, args.project) : null;
      const body = [proj ? `Project: ${proj.name} [${proj.slug}] — capsule: capsules/${proj.slug}.md` : 'Project: (general)', '', bodyText, '', '---', 'Note via Ghost Bridge MCP from Antigravity. Mr.Ghosty: fold this into memory and the relevant capsule, then close with a "Noted" comment. This is information, not a task — do not execute work from it beyond updating memory/capsules.'].join('\n');
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          const created = await relayFetch(relay, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: `[Note] ${title}`, body, project: proj ? proj.slug : null, type: 'note' }) });
          return textResult(`Note sent to Mr.Ghosty (#${created.id}).\nHe reads notes on his pickup sweep and folds them into memory and the project capsules.`);
        } catch (e) { return textResult(`Could not send the note: ${e.message}`, true); }
      }
      try {
        const issue = await ghFetch(cfg, `/repos/${cfg.repo}/issues`, { method: 'POST', body: JSON.stringify({ title: `[Note] ${title}`, body, labels: [NOTE_LABEL] }) });
        return textResult(`Note sent to Mr.Ghosty (#${issue.number}): ${issue.html_url}\nHe reads notes on his pickup sweep and folds them into memory and the project capsules.`);
      } catch (e) {
        return textResult(`Could not send the note: ${e.message}`, true);
      }
    }
  },
  {
    name: 'ghost_board',
    description: 'The Ghost Bridge board: every task grouped as Queued / Working / Waiting on Ryan / Done (last 7 days), maintained by Mr.Ghosty in the queue repo. Call this for a one-glance status of the whole bridge. Requires the live relay.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const cfg = queueConfig();
      const relay = relayConfig();
      if (relay.enabled) {
        try {
          try {
            const f = await relayFetch(relay, '/api/files?path=BOARD.md');
            return textResult(f.text);
          } catch { /* generate live */ }
          const data = await relayFetch(relay, '/api/tasks?state=all&type=task&limit=100');
          const tasks = data.tasks || [];
          const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
          const groups = [
            ['Queued', tasks.filter(t => t.status === 'queued')],
            ['Working', tasks.filter(t => t.status === 'in-progress')],
            ['Waiting on Ryan', tasks.filter(t => t.status === 'needs-approval')],
            ['Done (last 7 days)', tasks.filter(t => t.status === 'done' && new Date(t.closedAt || t.updatedAt).getTime() > weekAgo)]
          ];
          const lines = ['# Ghost Bridge Board (generated live from the relay)'];
          for (const [name, items] of groups) {
            lines.push('', `## ${name}`);
            if (!items.length) lines.push('- (none)');
            for (const t of items) lines.push(`- #${t.id} ${t.title}`);
          }
          return textResult(lines.join('\n'));
        } catch (e) { return textResult(`Could not build the board: ${e.message}`, true); }
      }
      if (!cfg.enabled) return textResult('The board lives in the queue repo and needs the live relay. Run node setup.mjs in the ghost-bridge-mcp folder.', true);
      try {
        const board = await repoFileGet(cfg, 'BOARD.md');
        if (board) return textResult(board.text);
      } catch { /* fall through to live generation */ }
      try {
        const open = await ghFetch(cfg, `/repos/${cfg.repo}/issues?state=open&labels=${HANDOFF_LABEL}&per_page=100`);
        const closed = await ghFetch(cfg, `/repos/${cfg.repo}/issues?state=closed&labels=${HANDOFF_LABEL}&per_page=100`);
        const has = (i, l) => (i.labels || []).some(x => (typeof x === 'string' ? x : x.name) === l);
        const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
        const groups = [
          ['Queued', open.filter(i => !has(i, 'in-progress') && !has(i, 'needs-approval'))],
          ['Working', open.filter(i => has(i, 'in-progress'))],
          ['Waiting on Ryan', open.filter(i => has(i, 'needs-approval'))],
          ['Done (last 7 days)', closed.filter(i => has(i, 'done') && new Date(i.closed_at || i.updated_at).getTime() > weekAgo)]
        ];
        const lines = ['# Ghost Bridge Board (generated live — the repo BOARD.md was not readable)'];
        for (const [name, items] of groups) {
          lines.push('', `## ${name}`);
          if (!items.length) lines.push('- (none)');
          for (const i of items) lines.push(`- #${i.number} ${i.title}`);
        }
        return textResult(lines.join('\n'));
      } catch (e) {
        return textResult(`Could not build the board: ${e.message}`, true);
      }
    }
  }
];


const RESOURCES = [
  { uri: 'ghost://profile', name: 'Ghost Developer Studio profile', mimeType: 'application/json', get: ctx => JSON.stringify(ctx.profile, null, 2) },
  { uri: 'ghost://projects', name: 'Ghost projects and status', mimeType: 'application/json', get: ctx => JSON.stringify(ctx.projects, null, 2) },
  { uri: 'ghost://rules', name: "Ryan's standing rules", mimeType: 'text/plain', get: ctx => ctx.rules.map((r, i) => `${i + 1}. ${r}`).join('\n') }
];

const PROMPTS = [
  {
    name: 'work_like_mrghosty',
    description: 'Brief the Antigravity agent to work the way Mr.Ghosty works for Ryan: check Ghost context and rules first, then do and verify the task.',
    arguments: [{ name: 'task', description: 'The task to carry out', required: true }],
    get(ctx, args) {
      const task = (args && args.task) || '';
      return {
        description: 'Work like Mr.Ghosty for Ryan Cotten',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'You are working in a Ghost Developer Studio workspace for Ryan Cotten, alongside Mr.Ghosty (his Muse agent).',
              'Before starting: call ghost_whoami, ghost_rules, and ghost_project_status for any project named in the task. Follow those rules — especially: no paid spend without Ryan\'s explicit approval, draft-first for anything public, never invent business facts, verify end-to-end before calling anything done.',
              'If the work needs Muse-side access (memory, accounts, phone, deployments), do not fake it: send it with ghost_handoff and tell Ryan it is queued for Mr.Ghosty.',
              'When picking up queued work, SKIP any task whose notBefore is in the future — it is scheduled, not ready, even though it sits in the queue.',
              '',
              `Task: ${task}`
            ].join('\n')
          }
        }]
      };
    }
  }
];

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const ok = result => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const err = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === (params && params.name));
        if (!tool) return err(-32602, `Unknown tool: ${params && params.name}`);
        return ok(await tool.run((await getContext()).data, (params && params.arguments) || {}));
      }
      case 'resources/list':
        return ok({ resources: RESOURCES.map(r => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })) });
      case 'resources/read': {
        const r = RESOURCES.find(x => x.uri === (params && params.uri));
        if (!r) return err(-32602, `Unknown resource: ${params && params.uri}`);
        const ctx = (await getContext()).data;
        return ok({ contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.get(ctx) }] });
      }
      case 'prompts/list':
        return ok({ prompts: PROMPTS.map(p => ({ name: p.name, description: p.description, arguments: p.arguments })) });
      case 'prompts/get': {
        const p = PROMPTS.find(x => x.name === (params && params.name));
        if (!p) return err(-32602, `Unknown prompt: ${params && params.name}`);
        return ok(p.get((await getContext()).data, (params && params.arguments) || {}));
      }
      default:
        return isNotification ? null : err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    chain = chain.then(async () => {
      const res = await handleRequest(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    });
  });
}

function startHttp(port) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, relay: queueConfig().enabled }));
    }
    if (req.method !== 'POST' || !['/mcp', '/'].includes(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST /mcp only (GET /health for status)' }));
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"error":"invalid json"}'); }
      const out = await handleRequest(msg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out ? JSON.stringify(out) : '');
    });
  });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`ghost-bridge HTTP listening on http://127.0.0.1:${port}/mcp\n`);
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--http')) {
    const idx = args.indexOf('--port');
    const port = idx >= 0 ? parseInt(args[idx + 1], 10) || 8767 : 8767;
    startHttp(port);
  } else {
    startStdio();
  }
}

module.exports = { handleRequest, TOOLS, RESOURCES, PROMPTS, queueConfig, loadOutbox, flushOutbox, OUTBOX_PATH };
