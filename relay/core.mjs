/**
 * Ghost Bridge Relay — core logic (transport-agnostic).
 * A store is any object with async get(key)->string|null, set(key, value), del(key).
 * createHandler(store, env) returns an async handler:
 *   ({ method, path, query, headers, bodyText }) -> { status, body (object|string), contentType }
 *
 * Storage keys: config {keys:[{name,hash,createdAt,lastUsedAt}]}, tasks (one blob
 * per task), counter n, files {path:text}, context {...}, events (one blob per event).
 * Auth: x-bridge-key header or Authorization: Bearer <key>; only sha256 hashes
 * are stored. v4 supports MULTIPLE named keys: any non-revoked named key
 * authenticates. A legacy v3 config {keyHash} auto-migrates on first v4 boot
 * to a named key called "primary" — existing clients keep working untouched.
 * Setup: POST /setup {key, setupSecret, name?} registers the first key (secret
 * from env BRIDGE_SETUP_SECRET). POST /api/keys (authed) adds named keys,
 * GET /api/keys lists them (names + timestamps only), DELETE /api/keys/:name
 * revokes one. POST /setup/reset {currentKey, setupSecret} clears all keys.
 * GET /probe and GET /health are unauthenticated and return COUNTS ONLY.
 * Events: task create/comment/status changes append to an event log.
 * GET /api/events?since=<seq|ISO> returns events after that point (add
 * &wait=<sec<=25> to long-poll). GET /api/events/stream is SSE on servers
 * that can hold a connection (local/Docker — see local-server.mjs); on
 * Netlify Functions use the long-poll form. If env GHOST_BRIDGE_WEBHOOK_URL
 * is set, each event is also POSTed there as JSON (best-effort, failures
 * never break the request).
 * Attachments: a task may carry attachments[] — {name, mime?, size?,
 * path? (a relay file), dataBase64? (inline, max 256 KB decoded each,
 * max 5 per task)}. Comments may carry a structured result {status,
 * summary, files[]}; a PATCH to a task may also set result the same way.
 *
 * v4.1 additions:
 *  - SCOPED KEYS: each key has a scope, "full" (default) or "readonly".
 *    A readonly key may only read (tasks/files/context/board/events, and
 *    the read-only MCP tools); writes and key management get a 403 with a
 *    clear error. Legacy/migrated keys are full. GET /api/keys shows scope.
 *  - CLAIM LEASES: PATCHing a task to in-progress claims it for the
 *    caller's key (claimedBy + claimExpiresAt, default 15 minutes,
 *    GHOST_BRIDGE_CLAIM_MINUTES). A second full key claiming an actively
 *    leased task gets 409 naming the holder and expiry; expired leases
 *    can be re-claimed; moving a task out of in-progress (queued, done,
 *    cancelled, needs-approval) clears the lease. PATCH {claim:true}
 *    without a status claims the same way.
 *  - IDEMPOTENT HANDOFFS: POST /api/tasks (and ghost_handoff) accept an
 *    optional idempotencyKey. Re-filing the same key from the same key
 *    name returns the existing task (200, duplicateSuppressed: true)
 *    instead of creating a duplicate. The key is stored on the task as
 *    idemKey and stripped from normal task reads.
 *  - SELF-PROTECTION: per-key rate limiting on authenticated calls
 *    (GHOST_BRIDGE_RATE_PER_MIN, default 600/min/key; 429 + Retry-After
 *    when exceeded; /probe + /health share a light unauthenticated
 *    bucket) and an event-log retention cap (GHOST_BRIDGE_EVENT_CAP,
 *    default 500 events). /health reports counts by status, key count,
 *    and event-log size.
 *
 * v4.2 additions:
 *  - SIGNED WEBHOOKS: when GHOST_BRIDGE_WEBHOOK_SECRET is set, outbound
 *    webhook POSTs carry `x-ghost-event: <type>` and
 *    `x-ghost-signature: sha256=<hmac-sha256 hex of the raw body>` —
 *    receivers verify with scripts/webhook-verify.mjs. No secret set =
 *    unsigned, exactly as before.
 *  - BACKUP / RESTORE: GET /api/export (full-scope key ONLY) returns one
 *    JSON document {format, version, exportedAt, keys (names + scopes +
 *    sha256 hashes — plaintext keys don't exist server-side), tasks
 *    (complete, INCLUDING the internal idemKey so a restored relay keeps
 *    suppressing duplicates), files, context, counter, events (only
 *    with ?events=1)}. POST /api/import (full-scope only) restores an
 *    export into an EMPTY relay; a non-empty relay is refused with 409
 *    unless ?force=true AND body.confirm === "OVERWRITE". Imported keys
 *    replace the key list, except the importing key itself is preserved
 *    (renamed "<name>-preimport" on a name collision) so a restore can
 *    never lock the operator out mid-flight.
 *
 * v4.3 additions:
 *  - CAPSULE CONCURRENCY: relay files carry a revision counter (stored
 *    under filerev:<path>, exposed as rev + ETag on GET /api/files).
 *    PUT /api/files accepts an optional expectedRev — a mismatch is a
 *    409 with the current rev + a merge hint, and NOTHING is written.
 *    Without expectedRev, writes stay last-write-wins (v4.2 behavior).
 *    Files written before v4.3 (no stored rev) report rev 1. Capsule
 *    updates (hosted MCP + the local MCP client) pass expectedRev
 *    automatically, so two agents editing one capsule collide loudly
 *    instead of silently clobbering each other.
 *  - AGENT PRESENCE: POST /api/presence {displayName?, capabilities?,
 *    status?} heartbeats for the caller's key name; GET /api/presence
 *    lists agents seen within GHOST_BRIDGE_PRESENCE_MINUTES (default
 *    10) — names, display names, capabilities, status, lastSeen; never
 *    key material. Readonly keys may heartbeat and read presence.
 *  - TASK SCHEDULING: tasks accept dueAt / notBefore (ISO; REST also
 *    accepts due / schedule aliases, ghost_handoff takes due / schedule
 *    arguments). Task reads compute `overdue` (queued + past dueAt) and
 *    `scheduled` (queued + future notBefore) flags; /health reports an
 *    overdue count. There is NO timer service — events still fire at
 *    creation; pickup workers skip not-yet-due tasks (the prompts and
 *    the handoff result text both say so). Malformed dates are a 400.
 *  - PAGINATION + SEARCH: GET /api/tasks gains offset + q= (title, body
 *    and comments, any-word matching like ghost_search_tasks). Default
 *    behavior is unchanged; when limit/offset are passed the response
 *    also carries total (the filtered count), limit and offset.
 *    ghost_inbox gains an offset argument.
 *  - ARCHIVE + RETENTION: POST /api/tasks/archive (full-scope ONLY)
 *    archives done/cancelled tasks whose close time is older than
 *    GHOST_BRIDGE_ARCHIVE_DAYS (default 30; 0 disables; a {days} body
 *    field overrides for one call). Archived tasks vanish from default
 *    task lists, the board data, /probe and /health status counts,
 *    survive in GET /api/tasks?archived=1, ghost_search_tasks (marked
 *    [archived]) and /api/export. Nothing archives automatically.
 *
 * v4.4 additions:
 *  - TASK DEPENDENCIES: tasks accept blockedBy: number[] (REST create +
 *    both MCP handoffs; `dependsOn` is an accepted alias). Blockers must
 *    exist (400 / "Not sent" otherwise) and can never include the task
 *    itself. Blocked state is COMPUTED on every read: a task is blocked
 *    while any blocker is not done/cancelled. An ARCHIVED blocker counts
 *    as satisfied — archive only ever takes done/cancelled tasks, so an
 *    archived blocker is by construction a finished one. Blocked tasks
 *    carry blocked + blockedByUnfinished on reads, a [BLOCKED by #n]
 *    marker in inbox/task_result, and a badge on the board. CLAIMING a
 *    blocked task (PATCH to in-progress, or {claim:true}) is a 409
 *    naming the unfinished blockers. Finishing/cancelling a blocker
 *    unblocks dependents automatically — nothing is mutated.
 *  - DIGEST: GET /api/digest?hours=24 (any authed key, readonly included)
 *    returns a structured summary — counts by status, tasks completed in
 *    the window, the needs-approval (waiting-on-owner) list, the overdue
 *    list, new-notes count, agents seen. ?format=md renders the same
 *    digest as Markdown text. ghost_bridge_status shows a "Digest (24h)"
 *    section (hosted MCP computes it internally; no new MCP tool).
 *  - METRICS: GET /metrics (unauthenticated, like /probe) returns COUNTS
 *    ONLY in Prometheus text format — task gauges by status, key count,
 *    event-log size, overdue + archived counts, and a version info
 *    gauge. No titles, no key material, no event bodies, ever.
 *  - CONTEXT HISTORY: every PUT /api/context bumps a monotonically
 *    increasing context version (returned in the PUT response and as an
 *    additive `contextVersion` field on GET /api/context) and archives
 *    the previous context as context-history:<n>. The last 10 versions
 *    are retained in total (current + up to 9 snapshots); older ones are
 *    pruned. GET /api/context/history lists versions (n, at, project
 *    count; readonly OK); GET /api/context/history/<n> returns that
 *    snapshot (the current version included).
 */
import crypto from 'node:crypto';

export const RELAY_VERSION = '4.4.0';
const STATUSES = ['queued', 'in-progress', 'needs-approval', 'done', 'cancelled'];
const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1024;
const MAX_ATTACHMENTS = 5;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// Validate + normalize an attachments array. Returns {list} or {error}.
export function normalizeAttachments(input) {
  if (input === undefined || input === null) return { list: [] };
  if (!Array.isArray(input)) return { error: 'attachments must be an array' };
  if (input.length > MAX_ATTACHMENTS) return { error: `at most ${MAX_ATTACHMENTS} attachments per task` };
  const list = [];
  for (const a of input) {
    if (!a || !a.name) return { error: 'each attachment needs a name' };
    const out = { name: String(a.name).slice(0, 200), mime: a.mime ? String(a.mime).slice(0, 100) : 'application/octet-stream' };
    if (a.path) out.path = String(a.path).slice(0, 500);
    if (a.dataBase64) {
      const b64 = String(a.dataBase64);
      const bytes = Buffer.from(b64, 'base64').length;
      if (bytes > MAX_INLINE_ATTACHMENT_BYTES) return { error: `attachment "${out.name}" is too large inline (${bytes} bytes; max ${MAX_INLINE_ATTACHMENT_BYTES}). Upload it via the files API and pass its path instead.` };
      out.dataBase64 = b64;
      out.size = bytes;
    } else if (a.size !== undefined) {
      out.size = Number(a.size) || 0;
    }
    list.push(out);
  }
  return { list };
}
export function normalizeResult(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    status: r.status ? String(r.status).slice(0, 100) : 'done',
    summary: r.summary ? String(r.summary) : '',
    files: Array.isArray(r.files) ? r.files.map(f => String(f).slice(0, 500)).slice(0, 20) : []
  };
}

async function readJSON(store, key, fallback) {
  const raw = await store.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
const writeJSON = (store, key, val) => store.set(key, JSON.stringify(val));

export function labelsFor(task) {
  const labels = [task.type === 'note' ? 'ghost-note' : 'ghost-handoff'];
  if (task.priority === 'urgent' && task.status !== 'done' && task.status !== 'cancelled') labels.push('urgent');
  if (task.status === 'in-progress') labels.push('in-progress');
  if (task.status === 'needs-approval') labels.push('needs-approval');
  if (task.status === 'done') labels.push('done');
  if (task.status === 'cancelled') labels.push('cancelled');
  return labels;
}
// Scheduling flags are computed at read time so they are always fresh:
// overdue = still queued and past its dueAt; scheduled = still queued and
// its notBefore is in the future (pickup workers should skip those).
export function scheduleFlags(t, nowMs = Date.now()) {
  const overdue = t.status === 'queued' && !!t.dueAt && Date.parse(t.dueAt) < nowMs;
  const scheduled = t.status === 'queued' && !!t.notBefore && Date.parse(t.notBefore) > nowMs;
  return { overdue, scheduled };
}
// ---- task dependencies (v4.4) ----
// A blocker is satisfied when it is done/cancelled — or archived, because
// archive only ever takes terminal (done/cancelled) tasks, so an archived
// blocker is a finished blocker by construction. A blocker id that no
// longer resolves to a task counts as UNFINISHED (fail closed: the task
// stays blocked rather than silently losing its dependency).
export function blockerSatisfied(blockerTask) {
  return !!blockerTask && (blockerTask.archived === true || blockerTask.status === 'done' || blockerTask.status === 'cancelled');
}
// Compute the dependency state of one task. byId is a Map(id -> task) over
// ALL tasks (archived included). Returns null when the task declares no
// blockers, so plain tasks keep their exact pre-v4.4 read shape.
export function blockedInfo(t, byId) {
  const blockers = Array.isArray(t && t.blockedBy) ? t.blockedBy : [];
  if (!blockers.length) return null;
  const unfinished = blockers.filter(id => !blockerSatisfied(byId ? byId.get(id) : null));
  return { blockedBy: blockers.slice(), blocked: unfinished.length > 0, blockedByUnfinished: unfinished };
}
// Validate a blockedBy / dependsOn value. Returns {list} (deduped positive
// integer ids) or {error}. Existence is checked by the caller, which owns
// the task list.
export function normalizeBlockedBy(input) {
  if (input === undefined || input === null) return { list: [] };
  if (!Array.isArray(input)) return { error: 'blockedBy must be an array of task numbers (e.g. "blockedBy": [3, 5])' };
  const list = [];
  for (const v of input) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { error: `blockedBy entries must be positive task numbers — got ${JSON.stringify(v)}` };
    if (!list.includes(n)) list.push(n);
  }
  return { list };
}
const publicTask = (t, byId) => {
  const { idemKey, ...rest } = t;
  const out = { ...rest, ...scheduleFlags(t), labels: labelsFor(t) };
  const bi = blockedInfo(t, byId);
  if (bi) { out.blocked = bi.blocked; out.blockedByUnfinished = bi.blockedByUnfinished; }
  return out;
};
// Build the id -> task lookup publicTask / digest / claim checks need.
export function taskIndex(tasks) { return new Map((tasks || []).map(t => [t.id, t])); }

// ---- digest (v4.4) ----
// One structured summary over a time window, shared by GET /api/digest
// and the hosted MCP's ghost_bridge_status. Counts are current state;
// `completed` and `newNotes` are window-scoped; waiting-on-owner and
// overdue are current lists (an old approval wait matters MORE, not less,
// so it is never windowed out). completedBy is recovered from the event
// log when the completing event is still in it.
export function buildDigest({ tasks, agents, events, hours }) {
  const winH = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
  const sinceMs = Date.now() - winH * 3600 * 1000;
  const byId = taskIndex(tasks);
  const live = tasks.filter(t => !t.archived);
  const counts = {};
  for (const s of STATUSES) counts[s] = 0;
  for (const t of live) if (t.type === 'task' && counts[t.status] !== undefined) counts[t.status] += 1;
  const completedBy = {};
  for (const e of events || []) {
    if (e && e.type === 'task.status' && e.status === 'done' && e.taskId !== undefined) completedBy[e.taskId] = e.byKey || null;
  }
  const inWindow = iso => { const ms = Date.parse(iso || ''); return !Number.isNaN(ms) && ms >= sinceMs; };
  const brief = t => ({ id: t.id, title: t.title, project: t.project || null });
  return {
    ok: true,
    version: RELAY_VERSION,
    windowHours: winH,
    since: new Date(sinceMs).toISOString(),
    generatedAt: new Date().toISOString(),
    counts: { ...counts, total: live.filter(t => t.type === 'task').length, archived: tasks.length - live.length },
    completed: live.filter(t => t.type === 'task' && t.status === 'done' && inWindow(t.closedAt || t.updatedAt))
      .sort((a, b) => Date.parse(b.closedAt || b.updatedAt) - Date.parse(a.closedAt || a.updatedAt))
      .map(t => ({ ...brief(t), completedAt: t.closedAt || t.updatedAt, ...(completedBy[t.id] ? { completedBy: completedBy[t.id] } : {}) })),
    waitingOnOwner: live.filter(t => t.type === 'task' && t.status === 'needs-approval')
      .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''))
      .map(t => ({ ...brief(t), since: t.updatedAt || t.createdAt })),
    overdue: live.filter(t => t.type === 'task' && scheduleFlags(t).overdue)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .map(t => ({ ...brief(t), dueAt: t.dueAt })),
    blocked: live.filter(t => t.type === 'task' && !['done', 'cancelled'].includes(t.status) && (blockedInfo(t, byId) || {}).blocked)
      .map(t => ({ ...brief(t), blockedByUnfinished: blockedInfo(t, byId).blockedByUnfinished })),
    newNotes: live.filter(t => t.type === 'note' && inWindow(t.createdAt)).length,
    newTasks: live.filter(t => t.type === 'task' && inWindow(t.createdAt)).length,
    agentsSeen: (agents || []).map(a => ({ name: a.name, displayName: a.displayName || null, status: a.status || 'online', lastSeen: a.lastSeen }))
  };
}
export function digestMarkdown(d) {
  const lines = [
    `# Ghost Bridge digest — last ${d.windowHours}h`,
    '',
    `Generated ${d.generatedAt} · relay v${d.version}`,
    '',
    `**Queue:** ${d.counts.queued} queued · ${d.counts['in-progress']} in progress · ${d.counts['needs-approval']} waiting on owner · ${d.counts.done} done · ${d.counts.cancelled} cancelled${d.counts.archived ? ` · ${d.counts.archived} archived` : ''}`,
    '',
    `## Waiting on owner (${d.waitingOnOwner.length})`
  ];
  if (d.waitingOnOwner.length) for (const t of d.waitingOnOwner) lines.push(`- #${t.id} ${t.title}${t.project ? ` (${t.project})` : ''} — waiting since ${t.since}`);
  else lines.push('- (nothing waiting)');
  lines.push('', `## Overdue (${d.overdue.length})`);
  if (d.overdue.length) for (const t of d.overdue) lines.push(`- #${t.id} ${t.title}${t.project ? ` (${t.project})` : ''} — due ${t.dueAt}`);
  else lines.push('- (nothing overdue)');
  lines.push('', `## Completed in window (${d.completed.length})`);
  if (d.completed.length) for (const t of d.completed) lines.push(`- #${t.id} ${t.title}${t.completedBy ? ` — completed by ${t.completedBy}` : ''} (${t.completedAt})`);
  else lines.push('- (nothing completed)');
  if (d.blocked.length) {
    lines.push('', `## Blocked (${d.blocked.length})`);
    for (const t of d.blocked) lines.push(`- #${t.id} ${t.title} — blocked by ${t.blockedByUnfinished.map(i => '#' + i).join(', ')}`);
  }
  lines.push('', `**New in window:** ${d.newTasks} task(s), ${d.newNotes} note(s)`);
  lines.push(`**Agents seen:** ${d.agentsSeen.length ? d.agentsSeen.map(a => `${a.displayName || a.name} (${a.status})`).join(', ') : 'none recently'}`);
  return lines.join('\n') + '\n';
}
// Validate one scheduling field value. Returns {val: ISO string} or {error}.
function parseScheduleValue(v, field) {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return { error: `invalid ${field} "${String(v).slice(0, 60)}" — not a recognizable date; use ISO 8601 (e.g. 2026-10-12T09:00:00Z)` };
  return { val: d.toISOString() };
}
const scopeOf = k => (k && k.scope === 'readonly' ? 'readonly' : 'full');

export function createHandler(store, env = {}) {
  const setupSecret = env.BRIDGE_SETUP_SECRET || '';
  const CLAIM_MINUTES = Math.max(0, parseFloat(env.GHOST_BRIDGE_CLAIM_MINUTES) || 15);
  const RATE_PER_MIN = Math.max(1, parseInt(env.GHOST_BRIDGE_RATE_PER_MIN, 10) || 600);
  const EVENT_CAP = Math.max(1, parseInt(env.GHOST_BRIDGE_EVENT_CAP, 10) || 500);
  const PRESENCE_MINUTES = Math.max(0, parseFloat(env.GHOST_BRIDGE_PRESENCE_MINUTES) || 10);
  const ARCHIVE_DAYS = env.GHOST_BRIDGE_ARCHIVE_DAYS === undefined
    ? 30
    : (Number.isFinite(parseFloat(env.GHOST_BRIDGE_ARCHIVE_DAYS)) ? Math.max(0, parseFloat(env.GHOST_BRIDGE_ARCHIVE_DAYS)) : 30);

  // Per-key fixed-window rate limiting (in-memory: per server instance —
  // on serverless each warm instance enforces its own window, which is
  // still a hard brake on a runaway client).
  const rateBuckets = new Map();
  function rateOk(bucket, limit) {
    const now = Date.now();
    const win = Math.floor(now / 60000);
    let b = rateBuckets.get(bucket);
    if (!b || b.win !== win) { b = { win, count: 0 }; rateBuckets.set(bucket, b); }
    b.count += 1;
    if (b.count > limit) { b.retryAfter = Math.max(1, Math.ceil(((win + 1) * 60000 - now) / 1000)); return b; }
    return null;
  }

  // Storage layout v2: one blob key per task ('task:<id>') and per file
  // ('file:<path>'), plus small index keys. The v1 layout kept all tasks /
  // all files in single blobs; under the store's propagation lag, rapid
  // read-modify-write cycles could clobber each other. Per-key writes can't.
  let migrated = false;
  async function ensureMigrated() {
    if (migrated) return;
    migrated = true;
    try {
      const legacyTasks = await readJSON(store, 'tasks', null);
      if (Array.isArray(legacyTasks)) {
        const ids = [];
        for (const t of legacyTasks) { await writeJSON(store, `task:${t.id}`, t); ids.push(t.id); }
        await writeJSON(store, 'task-ids', ids);
        await store.del('tasks');
      }
      const legacyFiles = await readJSON(store, 'files', null);
      if (legacyFiles && typeof legacyFiles === 'object') {
        const paths = [];
        for (const [p, text] of Object.entries(legacyFiles)) { await store.set(`file:${p}`, String(text)); paths.push(p); }
        await writeJSON(store, 'file-index', paths);
        await store.del('files');
      }
    } catch { /* migration is best-effort; reads fall back gracefully */ }
  }

  // ---- keys (v4: named, multi-client; v3 legacy config auto-migrates) ----
  async function getConfig() {
    const cfg = await readJSON(store, 'config', null);
    if (cfg && cfg.keyHash && !Array.isArray(cfg.keys)) {
      // Legacy single-key config -> migrate to a named key "primary".
      // The hash moves verbatim, so Ryan's existing bridge key keeps working.
      const migratedCfg = {
        keys: [{ name: 'primary', hash: cfg.keyHash, scope: 'full', createdAt: cfg.createdAt || new Date().toISOString(), lastUsedAt: null }],
        createdAt: cfg.createdAt || new Date().toISOString()
      };
      await writeJSON(store, 'config', migratedCfg);
      return migratedCfg;
    }
    return cfg;
  }
  const saveConfig = cfg => writeJSON(store, 'config', cfg);
  function extractKey(headers) {
    return headers['x-bridge-key'] || (headers['authorization'] || '').replace(/^Bearer\s+/i, '') || '';
  }
  async function matchKey(key) {
    if (!key) return null;
    const cfg = await getConfig();
    if (!cfg || !Array.isArray(cfg.keys) || !cfg.keys.length) return null;
    const h = sha256(key);
    const a = Buffer.from(h);
    const entry = cfg.keys.find(k => { const b = Buffer.from(k.hash); return a.length === b.length && crypto.timingSafeEqual(a, b); });
    return entry ? { cfg, entry } : null;
  }
  // Returns the matched key entry or null. Touches lastUsedAt at most once
  // a minute per key so hot paths don't rewrite config on every request.
  async function authed(headers) {
    const m = await matchKey(extractKey(headers));
    if (!m) return null;
    const now = Date.now();
    if (!m.entry.lastUsedAt || now - new Date(m.entry.lastUsedAt).getTime() > 60 * 1000) {
      m.entry.lastUsedAt = new Date(now).toISOString();
      await saveConfig(m.cfg);
    }
    return m.entry;
  }

  // ---- events + webhook (v4 push wake; v4.2: HMAC-signed when a secret is set) ----
  const webhookUrl = env.GHOST_BRIDGE_WEBHOOK_URL || '';
  const webhookSecret = env.GHOST_BRIDGE_WEBHOOK_SECRET || '';
  async function fireWebhook(event) {
    if (!webhookUrl) return;
    try {
      const raw = JSON.stringify(event);
      const headers = { 'Content-Type': 'application/json', 'x-ghost-event': event.type };
      if (webhookSecret) {
        headers['x-ghost-signature'] = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      await fetch(webhookUrl, { method: 'POST', headers, body: raw, signal: ctrl.signal });
      clearTimeout(t);
    } catch { /* webhooks are best-effort; never break the request */ }
  }
  async function emitEvent(type, data = {}) {
    try {
      const seq = (await readJSON(store, 'ev-counter', 0)) + 1;
      await writeJSON(store, 'ev-counter', seq);
      const event = { seq, type, at: new Date().toISOString(), ...data };
      await writeJSON(store, `event:${seq}`, event);
      const idx = await readJSON(store, 'ev-index', []);
      idx.push(seq);
      while (idx.length > EVENT_CAP) { const old = idx.shift(); await store.del(`event:${old}`); }
      await writeJSON(store, 'ev-index', idx);
      await fireWebhook(event);
      return event;
    } catch { return null; /* events are a wake-up convenience, not the store of record */ }
  }
  async function listEvents(since) {
    const idx = await readJSON(store, 'ev-index', []);
    const out = [];
    for (const seq of idx) {
      const e = await readJSON(store, `event:${seq}`, null);
      if (!e) continue;
      const after = since === null || (/^\d+$/.test(String(since)) ? e.seq > Number(since) : e.at > String(since));
      if (after) out.push(e);
    }
    return out;
  }

  async function listTasks() {
    await ensureMigrated();
    const ids = await readJSON(store, 'task-ids', []);
    const out = [];
    for (const id of ids) {
      const t = await readJSON(store, `task:${id}`, null);
      if (t) out.push(t);
    }
    return out;
  }
  async function saveTask(task) {
    await ensureMigrated();
    await writeJSON(store, `task:${task.id}`, task);
    const ids = await readJSON(store, 'task-ids', []);
    if (!ids.includes(task.id)) { ids.push(task.id); await writeJSON(store, 'task-ids', ids); }
  }
  async function saveTasks(tasks) { for (const t of tasks) await saveTask(t); }

  // ---- file revisions (v4.3 optimistic concurrency) ----
  // Revisions live under filerev:<path>. A file written before v4.3 has
  // no stored rev and reports 1 — its first v4.3 write takes it to 2.
  async function fileRev(p) {
    const r = await readJSON(store, `filerev:${p}`, null);
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    const exists = await store.get(`file:${p}`);
    return exists !== null && exists !== undefined ? 1 : 0;
  }
  // Write a file. With expectedRev given, the write only lands when the
  // file's current rev matches — otherwise {conflict, currentRev} and
  // nothing is written. Without it, the write is last-write-wins (v4.2).
  async function writeFile(p, text, expectedRev) {
    const cur = await fileRev(p);
    if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== cur) {
      return { conflict: true, currentRev: cur };
    }
    await store.set(`file:${p}`, String(text));
    const next = cur + 1;
    await writeJSON(store, `filerev:${p}`, next);
    const idx = await readJSON(store, 'file-index', []);
    if (!idx.includes(p)) { idx.push(p); await writeJSON(store, 'file-index', idx); }
    return { rev: next };
  }
  async function listPresence() {
    const idx = await readJSON(store, 'presence-index', []);
    const cutoff = Date.now() - PRESENCE_MINUTES * 60000;
    const agents = [];
    for (const name of idx) {
      const r = await readJSON(store, `presence:${name}`, null);
      if (r && Date.parse(r.lastSeen) >= cutoff) {
        agents.push({ name: r.name, displayName: r.displayName || null, capabilities: Array.isArray(r.capabilities) ? r.capabilities : [], status: r.status || 'online', lastSeen: r.lastSeen });
      }
    }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return agents;
  }

  async function route(req) {
    const { method, path } = req;
    const query = req.query || {};
    const headers = req.headers || {};
    const json = (status, obj) => ({ status, body: obj, contentType: 'application/json' });
    let body = null;
    if (req.bodyText) { try { body = JSON.parse(req.bodyText); } catch { return json(400, { error: 'invalid JSON body' }); } }

    // ---- unauthenticated ----
    if ((method === 'GET' && path === '/probe') || (method === 'GET' && path === '/health') || (method === 'GET' && path === '/metrics')) {
      // Lightly rated: one shared bucket at twice the per-key limit.
      const limited = rateOk('__unauth__', RATE_PER_MIN * 2);
      if (limited) return { status: 429, body: { error: 'rate limit exceeded — slow down', retryAfterSeconds: limited.retryAfter }, contentType: 'application/json', headers: { 'Retry-After': String(limited.retryAfter) } };
    }
    if (method === 'GET' && path === '/probe') {
      const tasks = (await listTasks()).filter(t => !t.archived);
      const actionable = tasks.filter(t => t.type === 'task' && t.status === 'queued');
      return json(200, {
        queued: actionable.length,
        urgent: actionable.filter(t => t.priority === 'urgent').length,
        notes: tasks.filter(t => t.type === 'note' && t.status === 'queued').length,
        ids: actionable.map(t => t.id),
        version: RELAY_VERSION
      });
    }
    if (method === 'GET' && path === '/health') {
      const allTasks = await listTasks();
      const archivedCount = allTasks.filter(t => t.archived).length;
      const tasks = allTasks.filter(t => !t.archived);
      const byStatus = {};
      for (const s of STATUSES) byStatus[s] = 0;
      for (const t of tasks) if (t.type === 'task' && byStatus[t.status] !== undefined) byStatus[t.status] += 1;
      let keyCount = 0;
      try { const cfg = await getConfig(); keyCount = cfg && Array.isArray(cfg.keys) ? cfg.keys.length : 0; } catch { /* counts only */ }
      const evIdx = await readJSON(store, 'ev-index', []);
      return json(200, {
        ok: true, server: 'ghost-bridge-relay', version: RELAY_VERSION,
        tasks: tasks.length,
        open: tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length,
        queued: tasks.filter(t => t.type === 'task' && t.status === 'queued').length,
        overdue: tasks.filter(t => t.type === 'task' && scheduleFlags(t).overdue).length,
        archived: archivedCount,
        byStatus,
        keys: keyCount,
        events: evIdx.length
      });
    }

    if (method === 'GET' && path === '/metrics') {
      // v4.4: Prometheus text format, COUNTS ONLY — the same discipline as
      // /probe and /health. Safe to scrape unauthenticated: no titles, no
      // key material, no event bodies ever leave through this endpoint.
      const allTasks = await listTasks();
      const archivedCount = allTasks.filter(t => t.archived).length;
      const tasks = allTasks.filter(t => !t.archived);
      const byStatus = {};
      for (const s of STATUSES) byStatus[s] = 0;
      for (const t of tasks) if (t.type === 'task' && byStatus[t.status] !== undefined) byStatus[t.status] += 1;
      let keyCount = 0;
      try { const cfg = await getConfig(); keyCount = cfg && Array.isArray(cfg.keys) ? cfg.keys.length : 0; } catch { /* counts only */ }
      const evIdx = await readJSON(store, 'ev-index', []);
      const overdue = tasks.filter(t => t.type === 'task' && scheduleFlags(t).overdue).length;
      const lines = [
        '# HELP ghost_bridge_tasks Tasks by status (archived excluded)',
        '# TYPE ghost_bridge_tasks gauge',
        ...STATUSES.map(s => `ghost_bridge_tasks{status="${s}"} ${byStatus[s]}`),
        '# HELP ghost_bridge_keys Registered bridge keys',
        '# TYPE ghost_bridge_keys gauge',
        `ghost_bridge_keys ${keyCount}`,
        '# HELP ghost_bridge_events_total Events currently held in the relay event log',
        '# TYPE ghost_bridge_events_total gauge',
        `ghost_bridge_events_total ${evIdx.length}`,
        '# HELP ghost_bridge_overdue Queued tasks past their due time',
        '# TYPE ghost_bridge_overdue gauge',
        `ghost_bridge_overdue ${overdue}`,
        '# HELP ghost_bridge_archived Archived tasks',
        '# TYPE ghost_bridge_archived gauge',
        `ghost_bridge_archived ${archivedCount}`,
        '# HELP ghost_bridge_version_info Relay version info',
        '# TYPE ghost_bridge_version_info gauge',
        `ghost_bridge_version_info{version="${RELAY_VERSION}"} 1`,
        ''
      ];
      return { status: 200, body: lines.join('\n'), contentType: 'text/plain; charset=utf-8' };
    }

    if (method === 'POST' && path === '/setup') {
      if (!setupSecret) return json(503, { error: 'setup secret is not configured on the relay' });
      if (!body || body.setupSecret !== setupSecret) return json(403, { error: 'bad setup secret' });
      const cfg = await getConfig();
      if (cfg && Array.isArray(cfg.keys) && cfg.keys.length) return json(409, { error: 'relay already has a key — reset first (needs a current key + setup secret), or add more keys via POST /api/keys' });
      if (!body.key || String(body.key).length < 16) return json(400, { error: 'key must be at least 16 characters' });
      const name = String(body.name || 'primary').slice(0, 60) || 'primary';
      if (body.scope !== undefined && !['full', 'readonly'].includes(body.scope)) return json(400, { error: 'scope must be "full" or "readonly"' });
      const now = new Date().toISOString();
      await saveConfig({ keys: [{ name, hash: sha256(body.key), scope: body.scope || 'full', createdAt: now, lastUsedAt: null }], createdAt: now });
      await emitEvent('key.registered', { name });
      return json(200, { ok: true, message: `Bridge key "${name}" registered. The relay is live.` });
    }
    if (method === 'POST' && path === '/setup/reset') {
      if (!setupSecret) return json(503, { error: 'setup secret is not configured on the relay' });
      if (!body || body.setupSecret !== setupSecret) return json(403, { error: 'bad setup secret' });
      const cfg = await getConfig();
      const currentKey = (body && body.currentKey) || extractKey(headers);
      if (cfg && Array.isArray(cfg.keys) && cfg.keys.length) {
        const m = await matchKey(currentKey);
        if (!m) return json(403, { error: 'current key does not match' });
      }
      await store.del('config');
      return json(200, { ok: true, message: 'All bridge keys cleared. The relay is unlocked for a fresh setup.' });
    }

    // ---- everything below needs a valid named bridge key ----
    const auth = await authed(headers);
    if (!auth) return json(401, { error: 'missing or wrong bridge key' });
    const authScope = scopeOf(auth);

    // Rate limit: per key name, fixed one-minute window.
    {
      const limited = rateOk(`key:${auth.name}`, RATE_PER_MIN);
      if (limited) return { status: 429, body: { error: `rate limit exceeded for key "${auth.name}" (${RATE_PER_MIN}/min) — retry after the window resets`, retryAfterSeconds: limited.retryAfter }, contentType: 'application/json', headers: { 'Retry-After': String(limited.retryAfter) } };
    }

    // Scope gate (REST): readonly keys may only GET read surfaces. /mcp is
    // let through and enforced per-tool inside handleMcp; key management
    // (/api/keys, any method) is never available to a readonly key.
    if (authScope === 'readonly' && path !== '/mcp') {
      // Presence is a read-ish surface by design: a readonly key may
      // heartbeat (it only ever writes its OWN presence record) and read
      // the agent list, same as any other read.
      const presenceBeat = path === '/api/presence' && method === 'POST';
      const readOk = method === 'GET' && path !== '/api/keys' &&
        (path === '/api/meta' || path === '/api/context' || path === '/api/digest' || path === '/api/files' || path === '/api/files/list' ||
         path === '/api/context/history' || /^\/api\/context\/history\/\d+$/.test(path) ||
         path === '/api/tasks' || /^\/api\/tasks\/\d+$/.test(path) || path === '/api/events' || path === '/api/presence');
      if (!readOk && !presenceBeat) return json(403, { error: `bridge key "${auth.name}" is read-only (scope=readonly) — this operation needs a full-scope key` });
    }

    // ---- named key management (v4) ----
    if (path === '/api/keys' && method === 'GET') {
      const cfg = await getConfig();
      return json(200, { keys: (cfg.keys || []).map(k => ({ name: k.name, scope: scopeOf(k), createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })) });
    }
    if (path === '/api/keys' && method === 'POST') {
      if (!body || !body.name) return json(400, { error: 'name required' });
      const name = String(body.name).trim().slice(0, 60);
      if (!name) return json(400, { error: 'name required' });
      if (body.scope !== undefined && !['full', 'readonly'].includes(body.scope)) return json(400, { error: 'scope must be "full" or "readonly"' });
      const newScope = body.scope || 'full';
      let keyValue = body.key ? String(body.key) : '';
      if (keyValue && keyValue.length < 16) return json(400, { error: 'key must be at least 16 characters' });
      const generated = !keyValue;
      if (generated) keyValue = crypto.randomBytes(24).toString('hex');
      const cfg = await getConfig();
      if (cfg.keys.some(k => k.name === name)) return json(409, { error: `a key named "${name}" already exists` });
      if (cfg.keys.some(k => k.hash === sha256(keyValue))) return json(409, { error: 'that exact key value is already registered under another name' });
      cfg.keys.push({ name, hash: sha256(keyValue), scope: newScope, createdAt: new Date().toISOString(), lastUsedAt: null });
      await saveConfig(cfg);
      await emitEvent('key.registered', { name, scope: newScope });
      return json(201, { ok: true, name, scope: newScope, ...(generated ? { key: keyValue, note: 'This generated key is shown ONCE — save it now. Only its hash is stored.' } : {}) });
    }
    const km = path.match(/^\/api\/keys\/(.+)$/);
    if (km && method === 'DELETE') {
      const name = decodeURIComponent(km[1]);
      const cfg = await getConfig();
      const idx = cfg.keys.findIndex(k => k.name === name);
      if (idx === -1) return json(404, { error: `no key named "${name}"` });
      if (cfg.keys.length === 1) return json(400, { error: 'cannot revoke the last remaining key — use POST /setup/reset instead' });
      cfg.keys.splice(idx, 1);
      await saveConfig(cfg);
      await emitEvent('key.revoked', { name });
      return json(200, { ok: true, revoked: name });
    }

    // ---- backup / restore (v4.2; full-scope only — the scope gate above
    // already 403s readonly keys on both of these routes) ----
    if (path === '/api/export' && method === 'GET') {
      const cfg = await getConfig();
      const tasks = await listTasks(); // raw tasks — idemKey INCLUDED so a restored relay keeps suppressing duplicates
      await ensureMigrated();
      const files = {};
      const idx = await readJSON(store, 'file-index', []);
      for (const p of idx) { const v = await store.get(`file:${p}`); if (v !== null && v !== undefined) files[p] = v; }
      if (!idx.length) {
        const legacy = await readJSON(store, 'files', null);
        if (legacy && typeof legacy === 'object') for (const [p, text] of Object.entries(legacy)) files[p] = String(text);
      }
      const doc = {
        format: 'ghost-bridge-export',
        version: RELAY_VERSION,
        exportedAt: new Date().toISOString(),
        // Names + scopes + hashes ONLY. Plaintext keys are never stored
        // server-side, so there is nothing more sensitive to export.
        keys: (cfg && Array.isArray(cfg.keys) ? cfg.keys : []).map(k => ({ name: k.name, scope: scopeOf(k), hash: k.hash, createdAt: k.createdAt || null, lastUsedAt: k.lastUsedAt || null })),
        tasks,
        files,
        context: await readJSON(store, 'context', null),
        counter: await readJSON(store, 'counter', 0)
      };
      if (query.events === '1' || query.includeEvents === 'true') {
        doc.events = await listEvents(null); // the log is already capped at EVENT_CAP entries
      }
      return json(200, doc);
    }
    if (path === '/api/import' && method === 'POST') {
      if (!body || typeof body !== 'object' || !Array.isArray(body.tasks) || !Array.isArray(body.keys)) {
        return json(400, { error: 'import needs an export document: {keys: [...], tasks: [...], files: {...}, context, counter}' });
      }
      for (const k of body.keys) {
        if (!k || typeof k.name !== 'string' || !k.name || !/^[0-9a-f]{64}$/i.test(String(k.hash || ''))) {
          return json(400, { error: 'every exported key needs a name and a 64-char sha256 hash — nothing was imported' });
        }
      }
      for (const t of body.tasks) {
        if (!t || !Number.isFinite(Number(t.id)) || typeof t.title !== 'string') {
          return json(400, { error: 'every exported task needs a numeric id and a title — nothing was imported' });
        }
      }
      const existing = await listTasks();
      const force = query.force === 'true' && body.confirm === 'OVERWRITE';
      if (existing.length && !force) {
        return json(409, { error: `relay is not empty (${existing.length} task(s) already here) — import restores into an EMPTY relay. To overwrite instead, POST /api/import?force=true with {"confirm": "OVERWRITE"} in the body. Nothing was imported.`, tasks: existing.length });
      }
      await ensureMigrated();
      if (existing.length) { // force overwrite: clear current tasks + files first
        for (const t of existing) await store.del(`task:${t.id}`);
        const oldIdx = await readJSON(store, 'file-index', []);
        for (const p of oldIdx) { await store.del(`file:${p}`); await store.del(`filerev:${p}`); }
      }
      // tasks (complete objects, idemKey and all)
      const inTasks = body.tasks.map(t => ({ ...t, id: Number(t.id) }));
      for (const t of inTasks) await writeJSON(store, `task:${t.id}`, t);
      await writeJSON(store, 'task-ids', inTasks.map(t => t.id));
      const maxId = inTasks.reduce((m, t) => Math.max(m, t.id), 0);
      await writeJSON(store, 'counter', Math.max(Number(body.counter) || 0, maxId));
      // files (imported files start their revision history at rev 1)
      const inFiles = body.files && typeof body.files === 'object' ? body.files : {};
      for (const [p, text] of Object.entries(inFiles)) { await store.set(`file:${p}`, String(text)); await writeJSON(store, `filerev:${p}`, 1); }
      await writeJSON(store, 'file-index', Object.keys(inFiles));
      // context (v4.4: an imported context restarts history at version 1 —
      // snapshots from the source relay are not carried over)
      {
        const oldHist = await readJSON(store, 'context-history-index', []);
        for (const n of oldHist) await store.del(`context-history:${n}`);
        await store.del('context-history-index');
        if (body.context) {
          await writeJSON(store, 'context', body.context);
          await writeJSON(store, 'context-version', 1);
          await writeJSON(store, 'context-updated-at', new Date().toISOString());
        } else {
          await store.del('context');
          await store.del('context-version');
          await store.del('context-updated-at');
        }
      }
      // keys: imported keys replace the list, but the key doing the import
      // is preserved (renamed on collision) so a restore never locks the
      // operator out.
      const now = new Date().toISOString();
      const importedKeys = body.keys.map(k => ({ name: String(k.name).slice(0, 60), hash: String(k.hash).toLowerCase(), scope: scopeOf(k), createdAt: k.createdAt || now, lastUsedAt: k.lastUsedAt || null }));
      if (!importedKeys.some(k => k.hash === auth.hash)) {
        let keepName = auth.name;
        if (importedKeys.some(k => k.name === keepName)) keepName = `${auth.name}-preimport`.slice(0, 60);
        importedKeys.push({ name: keepName, hash: auth.hash, scope: scopeOf(auth), createdAt: auth.createdAt || now, lastUsedAt: auth.lastUsedAt || null });
      }
      const prevCfg = await getConfig();
      await saveConfig({ keys: importedKeys, createdAt: (prevCfg && prevCfg.createdAt) || now });
      // events: only when the export carried them — replace the log wholesale
      let eventsImported = 0;
      if (Array.isArray(body.events)) {
        const oldIdx = await readJSON(store, 'ev-index', []);
        for (const s of oldIdx) await store.del(`event:${s}`);
        const idx = []; let maxSeq = 0;
        for (const e of body.events) {
          if (e && Number.isFinite(Number(e.seq))) { const seq = Number(e.seq); await writeJSON(store, `event:${seq}`, e); idx.push(seq); maxSeq = Math.max(maxSeq, seq); eventsImported += 1; }
        }
        idx.sort((a, b) => a - b);
        await writeJSON(store, 'ev-index', idx);
        await writeJSON(store, 'ev-counter', maxSeq);
      }
      await emitEvent('relay.imported', { tasks: inTasks.length, files: Object.keys(inFiles).length, keys: importedKeys.length, byKey: auth.name });
      return json(200, { ok: true, imported: { keys: importedKeys.length, tasks: inTasks.length, files: Object.keys(inFiles).length, context: !!body.context, events: eventsImported } });
    }

    // ---- events: long-poll JSON (serverless-safe) ----
    if (path === '/api/events' && method === 'GET') {
      const since = query.since !== undefined ? query.since : '0';
      const wait = Math.min(Math.max(parseInt(query.wait, 10) || 0, 0), 25);
      let events = await listEvents(since);
      if (!events.length && wait > 0) {
        const deadline = Date.now() + wait * 1000;
        while (Date.now() < deadline && !events.length) {
          await new Promise(r => setTimeout(r, 500));
          events = await listEvents(since);
        }
      }
      const all = await readJSON(store, 'ev-index', []);
      return json(200, { events, lastSeq: all.length ? all[all.length - 1] : 0 });
    }

    // ---- agent presence (v4.3) ----
    if (path === '/api/presence' && method === 'POST') {
      if (body && body.status !== undefined && !['online', 'busy', 'away'].includes(body.status)) {
        return json(400, { error: 'status must be one of online, busy, away' });
      }
      if (body && body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
        return json(400, { error: 'capabilities must be an array of strings' });
      }
      const rec = {
        name: auth.name,
        displayName: body && body.displayName ? String(body.displayName).slice(0, 80) : null,
        capabilities: body && Array.isArray(body.capabilities) ? body.capabilities.map(c => String(c).slice(0, 60)).slice(0, 12) : [],
        status: (body && body.status) || 'online',
        lastSeen: new Date().toISOString()
      };
      await writeJSON(store, `presence:${auth.name}`, rec);
      const idx = await readJSON(store, 'presence-index', []);
      if (!idx.includes(auth.name)) { idx.push(auth.name); await writeJSON(store, 'presence-index', idx); }
      return json(200, { ok: true, agent: rec });
    }
    if (path === '/api/presence' && method === 'GET') {
      return json(200, { agents: await listPresence(), windowMinutes: PRESENCE_MINUTES });
    }

    if (method === 'GET' && path === '/api/meta') {
      const tasks = (await listTasks()).filter(t => !t.archived);
      return json(200, { server: 'ghost-bridge-relay', version: RELAY_VERSION, tasks: tasks.length, open: tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length });
    }

    // ---- digest (v4.4; any authed key, readonly included — the scope
    // gate above already lets this GET through) ----
    if (path === '/api/digest' && method === 'GET') {
      const digest = buildDigest({
        tasks: await listTasks(),
        agents: await listPresence(),
        events: await listEvents(null),
        hours: query.hours
      });
      if (query.format === 'md' || query.format === 'markdown') {
        return { status: 200, body: digestMarkdown(digest), contentType: 'text/markdown; charset=utf-8' };
      }
      return json(200, digest);
    }

    // ---- context + context history (v4.4) ----
    // Storage: 'context' (current), 'context-version' (monotonic counter),
    // 'context-updated-at', 'context-history-index' (snapshot numbers,
    // ascending) and one 'context-history:<n>' blob per snapshot holding
    // {n, at, context}. Retention: the last CONTEXT_HISTORY_KEEP versions
    // in total (current + snapshots) — older snapshots are pruned.
    const CONTEXT_HISTORY_KEEP = 10;
    if (path === '/api/context') {
      if (method === 'GET') {
        const ctx = await readJSON(store, 'context', null);
        if (!ctx) return json(404, { error: 'no context published yet' });
        const version = await readJSON(store, 'context-version', 0);
        // Additive field — existing consumers keep working unchanged.
        return json(200, { ...ctx, contextVersion: version });
      }
      if (method === 'PUT') {
        if (!body || !Array.isArray(body.projects)) return json(400, { error: 'context must be an object with a projects array' });
        const prev = await readJSON(store, 'context', null);
        const prevVersion = await readJSON(store, 'context-version', 0);
        const version = prevVersion + 1;
        const now = new Date().toISOString();
        if (prev) {
          // The outgoing context becomes the snapshot for ITS version.
          await writeJSON(store, `context-history:${prevVersion}`, { n: prevVersion, at: now, context: prev });
          const idx = await readJSON(store, 'context-history-index', []);
          if (!idx.includes(prevVersion)) idx.push(prevVersion);
          idx.sort((a, b) => a - b);
          // Keep at most KEEP versions total: current + (KEEP-1) snapshots.
          while (idx.length > CONTEXT_HISTORY_KEEP - 1) { const old = idx.shift(); await store.del(`context-history:${old}`); }
          await writeJSON(store, 'context-history-index', idx);
        }
        await writeJSON(store, 'context', body);
        await writeJSON(store, 'context-version', version);
        await writeJSON(store, 'context-updated-at', now);
        return json(200, { ok: true, version, contextVersion: version });
      }
    }
    if (path === '/api/context/history' && method === 'GET') {
      const idx = await readJSON(store, 'context-history-index', []);
      const versions = [];
      for (const n of idx) {
        const snap = await readJSON(store, `context-history:${n}`, null);
        if (snap) versions.push({ n: snap.n, at: snap.at, projects: Array.isArray(snap.context && snap.context.projects) ? snap.context.projects.length : 0 });
      }
      const ctx = await readJSON(store, 'context', null);
      if (ctx) {
        const version = await readJSON(store, 'context-version', 0);
        versions.push({ n: version, at: await readJSON(store, 'context-updated-at', null), projects: Array.isArray(ctx.projects) ? ctx.projects.length : 0, current: true });
      }
      versions.sort((a, b) => a.n - b.n);
      return json(200, { versions });
    }
    const chm = path.match(/^\/api\/context\/history\/(\d+)$/);
    if (chm && method === 'GET') {
      const n = Number(chm[1]);
      const version = await readJSON(store, 'context-version', 0);
      if (n === version) {
        const ctx = await readJSON(store, 'context', null);
        return ctx ? json(200, { ...ctx, contextVersion: version }) : json(404, { error: 'no context published yet' });
      }
      const snap = await readJSON(store, `context-history:${n}`, null);
      if (!snap) return json(404, { error: `no context snapshot for version ${n} (it may have been pruned — only the last ${CONTEXT_HISTORY_KEEP} versions are kept)` });
      return json(200, { ...snap.context, contextVersion: snap.n, snapshotAt: snap.at });
    }

    if (path === '/api/files') {
      await ensureMigrated();
      if (method === 'GET') {
        const p = query.path || '';
        const text = await store.get(`file:${p}`);
        if (text === null || text === undefined) return json(404, { error: 'file not found' });
        const rev = await fileRev(p);
        return { status: 200, body: { path: p, text, rev }, contentType: 'application/json', headers: { ETag: `"rev-${rev}"` } };
      }
      if (method === 'PUT') {
        if (!body || !body.path || typeof body.text !== 'string') return json(400, { error: 'path and text required' });
        const hasExpected = body.expectedRev !== undefined && body.expectedRev !== null;
        if (hasExpected && !Number.isFinite(Number(body.expectedRev))) return json(400, { error: 'expectedRev must be a number (the rev you read before editing)' });
        const w = await writeFile(body.path, body.text, hasExpected ? Number(body.expectedRev) : undefined);
        if (w.conflict) {
          return json(409, {
            error: `revision conflict for "${body.path}": you based this write on rev ${Number(body.expectedRev)}, but the file is now at rev ${w.currentRev} — another agent changed it first. Nothing was written. Re-read the file (rev ${w.currentRev}), merge your changes into the current text, and retry with expectedRev: ${w.currentRev}.`,
            currentRev: w.currentRev, path: body.path
          });
        }
        return json(200, { ok: true, path: body.path, rev: w.rev });
      }
    }
    if (method === 'GET' && path === '/api/files/list') {
      await ensureMigrated();
      return json(200, { files: await readJSON(store, 'file-index', []) });
    }

    if (path === '/api/tasks' && method === 'GET') {
      let tasks = await listTasks();
      // Dependency state resolves against ALL tasks (a done blocker must
      // still satisfy its dependents even when a state filter hides it).
      const byIdAll = taskIndex(tasks);
      // Archived tasks are hidden by default; ?archived=1 returns ONLY them.
      const wantArchived = query.archived === '1' || query.archived === 'true';
      tasks = tasks.filter(t => (wantArchived ? !!t.archived : !t.archived));
      const state = query.state || 'all';
      const type = query.type || 'all';
      if (state === 'open') tasks = tasks.filter(t => !['done', 'cancelled'].includes(t.status));
      if (state === 'closed') tasks = tasks.filter(t => ['done', 'cancelled'].includes(t.status));
      if (type !== 'all') tasks = tasks.filter(t => t.type === type);
      if (query.q) {
        const words = String(query.q).toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length) {
          tasks = tasks.filter(t => {
            const hay = `${t.title} ${t.body} ${(t.comments || []).map(c => c.body).join(' ')}`.toLowerCase();
            return words.some(w => hay.includes(w));
          });
        }
      }
      tasks.sort((a, b) => b.id - a.id);
      const hasPaging = query.limit !== undefined || query.offset !== undefined;
      const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
      const total = tasks.length;
      const page = tasks.slice(offset, offset + limit).map(t => publicTask(t, byIdAll));
      // Backward compatible: without paging params the shape is exactly
      // v4.2's ({tasks}); with them it adds total/limit/offset.
      return json(200, hasPaging ? { tasks: page, total, limit, offset } : { tasks: page });
    }
    if (path === '/api/tasks/archive' && method === 'POST') {
      // Full-scope only — the scope gate above already 403s readonly keys
      // (this is not a read route and not the presence exception).
      const days = body && body.days !== undefined && body.days !== null
        ? (Number.isFinite(parseFloat(body.days)) ? Math.max(0, parseFloat(body.days)) : NaN)
        : ARCHIVE_DAYS;
      if (Number.isNaN(days)) return json(400, { error: 'days must be a number (0 disables archiving)' });
      if (days === 0) return json(200, { ok: true, archived: 0, days: 0, note: 'archiving is disabled (days = 0) — nothing was archived' });
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      const tasks = await listTasks();
      const archivedIds = [];
      for (const t of tasks) {
        if (t.archived) continue;
        if (!['done', 'cancelled'].includes(t.status)) continue;
        const closedMs = Date.parse(t.closedAt || t.updatedAt || t.createdAt || '');
        if (Number.isNaN(closedMs) || closedMs >= cutoff) continue;
        t.archived = true;
        t.archivedAt = new Date().toISOString();
        await saveTask(t);
        archivedIds.push(t.id);
      }
      if (archivedIds.length) await emitEvent('tasks.archived', { count: archivedIds.length, days, byKey: auth.name });
      return json(200, { ok: true, archived: archivedIds.length, archivedIds, days });
    }
    if (path === '/api/tasks' && method === 'POST') {
      if (!body || !body.title || !body.body) return json(400, { error: 'title and body required' });
      const att = normalizeAttachments(body.attachments);
      if (att.error) return json(400, { error: att.error });
      // Scheduling (v4.3): dueAt / notBefore, with due / schedule aliases.
      let dueAt = null, notBefore = null;
      const rawDue = body.dueAt !== undefined ? body.dueAt : body.due;
      const rawNotBefore = body.notBefore !== undefined ? body.notBefore : body.schedule;
      if (rawDue !== undefined && rawDue !== null && rawDue !== '') { const p = parseScheduleValue(rawDue, 'dueAt'); if (p.error) return json(400, { error: p.error }); dueAt = p.val; }
      if (rawNotBefore !== undefined && rawNotBefore !== null && rawNotBefore !== '') { const p = parseScheduleValue(rawNotBefore, 'notBefore'); if (p.error) return json(400, { error: p.error }); notBefore = p.val; }
      const tasks = await listTasks();
      // Dependencies (v4.4): blockedBy (alias dependsOn). Every blocker
      // must already exist — a dangling dependency would block forever.
      const deps = normalizeBlockedBy(body.blockedBy !== undefined ? body.blockedBy : body.dependsOn);
      if (deps.error) return json(400, { error: deps.error });
      for (const id of deps.list) {
        if (!tasks.some(t => t.id === id)) return json(400, { error: `blockedBy task #${id} does not exist — file the blocker first, then the task that depends on it` });
      }
      const idemKey = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 200) : null;
      if (idemKey) {
        const existing = tasks.find(t => t.idemKey && t.idemKey === idemKey && (t.createdBy || null) === auth.name);
        if (existing) return json(200, { ...publicTask(existing, taskIndex(tasks)), duplicateSuppressed: true, note: `Idempotency key already filed by key "${auth.name}" — returning existing task #${existing.id} instead of creating a duplicate.` });
      }
      const counter = (await readJSON(store, 'counter', 0)) + 1;
      await writeJSON(store, 'counter', counter);
      const now = new Date().toISOString();
      const task = {
        id: counter,
        type: body.type === 'note' ? 'note' : 'task',
        title: String(body.title).slice(0, 300),
        body: String(body.body),
        project: body.project ? String(body.project) : null,
        priority: body.priority === 'urgent' ? 'urgent' : 'normal',
        status: 'queued',
        comments: [],
        attachments: att.list,
        result: null,
        createdBy: auth.name,
        claimedBy: null, claimExpiresAt: null,
        dueAt, notBefore, archived: false, archivedAt: null,
        ...(deps.list.length ? { blockedBy: deps.list } : {}),
        ...(idemKey ? { idemKey } : {}),
        createdAt: now, updatedAt: now, closedAt: null
      };
      tasks.push(task);
      await saveTasks(tasks);
      await emitEvent('task.created', { taskId: task.id, title: task.title, taskType: task.type, priority: task.priority, byKey: auth.name });
      return json(201, publicTask(task, taskIndex(tasks)));
    }
    const tm = path.match(/^\/api\/tasks\/(\d+)$/);
    if (tm && method === 'GET') {
      const tasks = await listTasks();
      const task = tasks.find(t => t.id === Number(tm[1]));
      return task ? json(200, publicTask(task, taskIndex(tasks))) : json(404, { error: 'task not found' });
    }
    if (tm && method === 'PATCH') {
      const tasks = await listTasks();
      const task = tasks.find(t => t.id === Number(tm[1]));
      if (!task) return json(404, { error: 'task not found' });
      const byId = taskIndex(tasks);
      const wantClaim = body && body.claim === true;
      const hasSchedule = !!body && ('dueAt' in body || 'notBefore' in body || 'due' in body || 'schedule' in body);
      const hasDeps = !!body && ('blockedBy' in body || 'dependsOn' in body);
      if (!body || (!STATUSES.includes(body.status) && !wantClaim && !hasSchedule && !hasDeps)) return json(400, { error: `status must be one of ${STATUSES.join(', ')}, or pass {claim: true} to claim the task, or dueAt/notBefore to (re)schedule it, or blockedBy to change its dependencies` });
      // Dependencies (v4.4) validate BEFORE anything mutates: blockers
      // must exist and a task can never block itself.
      let deps = null;
      if (hasDeps) {
        deps = normalizeBlockedBy(body.blockedBy !== undefined ? body.blockedBy : body.dependsOn);
        if (deps.error) return json(400, { error: deps.error });
        if (deps.list.includes(task.id)) return json(400, { error: `task #${task.id} cannot block itself` });
        for (const id of deps.list) {
          if (!byId.has(id)) return json(400, { error: `blockedBy task #${id} does not exist` });
        }
      }
      // Scheduling fields may ride along with any patch, or be the whole
      // patch. null / "" clears the field; anything else must parse.
      if (hasSchedule) {
        for (const [field, aliases] of [['dueAt', ['dueAt', 'due']], ['notBefore', ['notBefore', 'schedule']]]) {
          const key = aliases.find(k => k in body);
          if (key === undefined) continue;
          const v = body[key];
          if (v === null || v === '') { task[field] = null; continue; }
          const p = parseScheduleValue(v, field);
          if (p.error) return json(400, { error: p.error });
          task[field] = p.val;
        }
      }
      if (deps) { if (deps.list.length) task.blockedBy = deps.list; else delete task.blockedBy; }
      if (!STATUSES.includes(body.status) && !wantClaim) {
        // Schedule/deps-only patch: status and lease stay exactly as they are.
        task.updatedAt = new Date().toISOString();
        await saveTasks(tasks);
        return json(200, publicTask(task, byId));
      }
      const newStatus = wantClaim && !STATUSES.includes(body.status) ? 'in-progress' : body.status;
      const nowMs = Date.now();
      const leaseActive = !!(task.claimedBy && task.claimExpiresAt && Date.parse(task.claimExpiresAt) > nowMs);
      if (newStatus === 'in-progress') {
        if (['done', 'cancelled'].includes(task.status)) return json(400, { error: `cannot claim a ${task.status} task` });
        // Dependency gate (v4.4): a blocked task cannot be claimed. The
        // 409 names the unfinished blockers so the agent can go work on
        // (or follow up) the thing actually in the way.
        if (task.status !== 'in-progress') {
          const bi = blockedInfo(task, byId);
          if (bi && bi.blocked) {
            return json(409, { error: `task #${task.id} is blocked by unfinished task(s): ${bi.blockedByUnfinished.map(i => '#' + i).join(', ')} — a blocked task cannot be claimed until every blocker is done or cancelled`, blockedByUnfinished: bi.blockedByUnfinished });
          }
        }
        if (leaseActive && task.claimedBy !== auth.name) {
          return json(409, { error: `task #${task.id} is claimed by key "${task.claimedBy}" until ${task.claimExpiresAt} — wait for the lease to expire or for the holder to release it`, claimedBy: task.claimedBy, claimExpiresAt: task.claimExpiresAt });
        }
        const mins = body.claimMinutes !== undefined && body.claimMinutes !== null && !Number.isNaN(parseFloat(body.claimMinutes)) ? Math.max(0, parseFloat(body.claimMinutes)) : CLAIM_MINUTES;
        task.claimedBy = auth.name;
        task.claimExpiresAt = new Date(nowMs + mins * 60000).toISOString();
      } else {
        // Leaving in-progress (release to queued, done, cancelled,
        // needs-approval) always clears the lease.
        task.claimedBy = null;
        task.claimExpiresAt = null;
      }
      task.status = newStatus;
      if (body.result) task.result = normalizeResult(body.result);
      task.updatedAt = new Date().toISOString();
      task.closedAt = ['done', 'cancelled'].includes(task.status) ? task.updatedAt : null;
      await saveTasks(tasks);
      await emitEvent('task.status', { taskId: task.id, title: task.title, status: task.status, byKey: auth.name, ...(task.claimedBy ? { claimedBy: task.claimedBy, claimExpiresAt: task.claimExpiresAt } : {}) });
      return json(200, publicTask(task, byId));
    }
    const cm = path.match(/^\/api\/tasks\/(\d+)\/comments$/);
    if (cm && method === 'POST') {
      const tasks = await listTasks();
      const task = tasks.find(t => t.id === Number(cm[1]));
      if (!task) return json(404, { error: 'task not found' });
      if (!body || !body.body) return json(400, { error: 'comment body required' });
      const comment = { author: body.author || 'antigravity', body: String(body.body), at: new Date().toISOString() };
      const resObj = normalizeResult(body.result);
      if (resObj) comment.result = resObj;
      task.comments.push(comment);
      task.updatedAt = new Date().toISOString();
      await saveTasks(tasks);
      await emitEvent('task.comment', { taskId: task.id, title: task.title, author: comment.author, hasResult: !!resObj, byKey: auth.name });
      return json(201, publicTask(task, taskIndex(tasks)));
    }

    if (path === '/mcp' && method === 'POST') {
      return json(200, await handleMcp(store, body, emitEvent, { keyName: auth.name, scope: authScope, presenceMinutes: PRESENCE_MINUTES }));
    }

    return json(404, { error: 'not found' });
  }

  return async req => {
    try { return await route(req); }
    catch (e) { return { status: 500, body: { error: String(e && e.message || e) }, contentType: 'application/json' }; }
  };
}

// ---------------- Hosted MCP (same tools, backed by the relay store) ----------------

function textResult(text, isError) { return { content: [{ type: 'text', text: String(text) }], isError: !!isError }; }
function findProject(ctx, q0) {
  const q = String(q0 || '').toLowerCase().trim();
  if (!q || !ctx || !Array.isArray(ctx.projects)) return null;
  return ctx.projects.find(p => p.slug === q || p.name.toLowerCase() === q || p.name.toLowerCase().includes(q) || p.slug.includes(q)) || null;
}
function statusLine(t, byId) {
  const map = { 'queued': 'queued', 'in-progress': 'in progress', 'needs-approval': 'NEEDS RYAN APPROVAL', 'done': 'done', 'cancelled': 'cancelled' };
  const f = scheduleFlags(t);
  const bi = blockedInfo(t, byId);
  const flags = `${f.overdue ? ' [OVERDUE]' : ''}${f.scheduled ? ` [scheduled — not before ${t.notBefore}]` : ''}${bi && bi.blocked ? ` [BLOCKED by ${bi.blockedByUnfinished.map(i => '#' + i).join(', ')}]` : ''}`;
  return `#${t.id} [${map[t.status] || t.status}] ${t.title}${flags}`;
}
function capsuleTemplate(p) {
  return [`# Capsule — ${p.name}`, '',
    '_Shared working memory between Antigravity and Mr.Ghosty. Both sides keep this current._', '',
    '## State', `${p.status} — ${p.summary}`, '',
    '## Decisions (locked)', '- None recorded yet.', '',
    '## Next', '- See the project status; replace this line as concrete next steps emerge.', '',
    '## Session log', `- ${new Date().toISOString().slice(0, 10)} — Capsule created from the studio context snapshot.`, ''].join('\n');
}
function sectionReplace(md, heading, newBody) {
  const marker = `## ${heading}`;
  const start = md.indexOf(marker);
  if (start === -1) return md.replace(/\s*$/, '') + `\n\n${marker}\n${newBody}\n`;
  const bodyStart = md.indexOf('\n', start) + 1;
  const nextIdx = md.indexOf('\n## ', bodyStart);
  const end = nextIdx === -1 ? md.length : nextIdx + 1;
  return md.slice(0, bodyStart) + newBody.replace(/\s+$/, '') + '\n' + md.slice(end);
}

const MCP_WRITE_TOOLS = ['ghost_handoff', 'ghost_reply', 'ghost_cancel_task', 'ghost_capsule_update', 'ghost_publish_note'];
async function handleMcp(store, msg, emit = async () => {}, caller = { keyName: 'hosted-mcp', scope: 'full' }) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = result => (isNotification ? {} : { jsonrpc: '2.0', id, result });
  const err = (code, message) => (isNotification ? {} : { jsonrpc: '2.0', id, error: { code, message } });
  const ctx = await readJSON(store, 'context', { profile: {}, projects: [], rules: [], updated: 'not published yet' });
  const getTasks = async (includeArchived = false) => {
    const ids = await readJSON(store, 'task-ids', []);
    let all;
    if (!ids.length) {
      const legacy = await readJSON(store, 'tasks', null);
      all = Array.isArray(legacy) ? legacy : [];
    } else {
      all = [];
      for (const id of ids) { const t = await readJSON(store, `task:${id}`, null); if (t) all.push(t); }
    }
    // Archived tasks are out of the working set; search opts back in.
    return includeArchived ? all : all.filter(t => !t.archived);
  };
  const saveTasks = async tasks => {
    for (const t of tasks) await writeJSON(store, `task:${t.id}`, t);
    // Merge with the stored index instead of replacing it: callers pass
    // the non-archived working set (getTasks()), and archived tasks must
    // stay indexed or they would fall out of lists/exports (and out of
    // dependency resolution) after any hosted write.
    const existing = await readJSON(store, 'task-ids', []);
    const ids = existing.slice();
    for (const t of tasks) if (!ids.includes(t.id)) ids.push(t.id);
    await writeJSON(store, 'task-ids', ids);
  };
  const getFiles = async () => {
    const idx = await readJSON(store, 'file-index', []);
    const out = {};
    for (const p of idx) { const v = await store.get(`file:${p}`); if (v !== null && v !== undefined) out[p] = v; }
    // legacy single-blob fallback (pre-migration data)
    if (!idx.length) {
      const legacy = await readJSON(store, 'files', null);
      if (legacy && typeof legacy === 'object') return legacy;
    }
    return out;
  };
  const saveFiles = async f => {
    for (const [p, text] of Object.entries(f)) await store.set(`file:${p}`, String(text));
    await writeJSON(store, 'file-index', Object.keys(f));
  };
  // Capsule writes go through the same revision machinery as the REST
  // files API (v4.3): read the current rev, write against it, and a
  // concurrent change surfaces as a conflict instead of a silent clobber.
  const fileRevOf = async p => {
    const r = await readJSON(store, `filerev:${p}`, null);
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    const ex = await store.get(`file:${p}`);
    return ex !== null && ex !== undefined ? 1 : 0;
  };
  const putFileWithRev = async (p, text, expectedRev) => {
    const cur = await fileRevOf(p);
    if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== cur) return { conflict: true, currentRev: cur };
    await store.set(`file:${p}`, String(text));
    await writeJSON(store, `filerev:${p}`, cur + 1);
    const idx = await readJSON(store, 'file-index', []);
    if (!idx.includes(p)) { idx.push(p); await writeJSON(store, 'file-index', idx); }
    return { rev: cur + 1 };
  };
  const listPresence = async () => {
    const windowMin = typeof caller.presenceMinutes === 'number' ? caller.presenceMinutes : 10;
    const idx = await readJSON(store, 'presence-index', []);
    const cutoff = Date.now() - windowMin * 60000;
    const agents = [];
    for (const name of idx) {
      const r = await readJSON(store, `presence:${name}`, null);
      if (r && Date.parse(r.lastSeen) >= cutoff) agents.push(r);
    }
    return { agents, windowMin };
  };

  const tools = {
    ghost_whoami: async () => textResult([
      `Assistant: ${ctx.profile.assistant || 'Mr.Ghosty'}`,
      `Owner: ${ctx.profile.owner || 'Ryan Cotten'}`,
      `Studio: ${ctx.profile.studio || 'Ghost Developer Studio'}`,
      '', `How to work with Ryan: ${ctx.profile.how_to_work_with_ryan || ''}`,
      '', 'Live relay: CONNECTED — this is the hosted Ghost Bridge relay. Tasks sent with ghost_handoff reach Mr.Ghosty within a couple of minutes (a watcher wakes him); results return in the task thread.'
    ].join('\n')),
    ghost_projects: async a => {
      let list = ctx.projects || [];
      if (a && a.status) list = list.filter(p => p.status.toLowerCase().includes(String(a.status).toLowerCase()));
      return textResult(list.length ? list.map(p => `- ${p.name} [${p.slug}] — ${p.status}\n  ${p.summary}`).join('\n') : 'No projects match.');
    },
    ghost_project_status: async a => {
      const p = findProject(ctx, a && a.project);
      return p ? textResult(`${p.name} [${p.slug}]\nStatus: ${p.status}\n\n${p.summary}`) : textResult(`No project found for "${a && a.project}".`, true);
    },
    ghost_rules: async () => textResult((ctx.rules || []).map((r, i) => `${i + 1}. ${r}`).join('\n')),
    ghost_search: async a => {
      const q = String((a && a.query) || '').toLowerCase();
      const words = q.split(/\s+/).filter(w => w.length > 2);
      const hits = [];
      for (const p of ctx.projects || []) { const hay = `${p.name} ${p.slug} ${p.status} ${p.summary}`.toLowerCase(); if (words.some(w => hay.includes(w))) hits.push(`PROJECT ${p.name} [${p.status}]: ${p.summary}`); }
      (ctx.rules || []).forEach((r, i) => { if (words.some(w => r.toLowerCase().includes(w))) hits.push(`RULE ${i + 1}: ${r}`); });
      return textResult(hits.length ? hits.join('\n') : `No matches for "${a && a.query}".`);
    },
    ghost_bridge_status: async () => {
      const tasks = await getTasks();
      const open = tasks.filter(t => t.type === 'task' && !['done', 'cancelled'].includes(t.status));
      const pres = await listPresence();
      const agentsLine = pres.agents.length
        ? `Online agents (seen in the last ${pres.windowMin} min): ${pres.agents.map(a => `${a.displayName || a.name}${a.displayName ? ` [${a.name}]` : ''} — ${a.status || 'online'}${(a.capabilities || []).length ? ` (${a.capabilities.join(', ')})` : ''}`).join('; ')}`
        : 'Online agents: none seen recently.';
      // Digest (v4.4): computed internally from the same store — the
      // hosted twin of GET /api/digest, folded into status so the tool
      // surface stays at 17.
      const allTasks = await getTasks(true);
      const evIdx = await readJSON(store, 'ev-index', []);
      const events = [];
      for (const seq of evIdx) { const e = await readJSON(store, `event:${seq}`, null); if (e) events.push(e); }
      const d = buildDigest({ tasks: allTasks, agents: pres.agents, events, hours: 24 });
      const digestLines = [
        '',
        'Digest (24h):',
        `- Completed: ${d.completed.length}${d.completed.length ? ' — ' + d.completed.slice(0, 5).map(t => `#${t.id} ${t.title}`).join('; ') : ''}`,
        `- Waiting on Ryan: ${d.waitingOnOwner.length}${d.waitingOnOwner.length ? ' — ' + d.waitingOnOwner.slice(0, 5).map(t => `#${t.id} ${t.title}`).join('; ') : ''}`,
        `- Overdue: ${d.overdue.length}${d.overdue.length ? ' — ' + d.overdue.slice(0, 5).map(t => `#${t.id} ${t.title}`).join('; ') : ''}`,
        `- Blocked: ${d.blocked.length}${d.blocked.length ? ' — ' + d.blocked.slice(0, 5).map(t => `#${t.id} ${t.title} (by ${t.blockedByUnfinished.map(i => '#' + i).join(', ')})`).join('; ') : ''}`,
        `- New notes: ${d.newNotes}`
      ];
      return textResult([
        `Ghost Bridge Relay v${RELAY_VERSION} (hosted)`,
        `Context: relay copy (snapshot dated ${ctx.updated || 'unknown'})`,
        `Open tasks: ${open.length} (${open.filter(t => t.status === 'queued').length} queued, ${open.filter(t => t.status === 'in-progress').length} in progress, ${open.filter(t => t.status === 'needs-approval').length} waiting on Ryan, ${open.filter(t => scheduleFlags(t).overdue).length} overdue)`,
        agentsLine,
        ...digestLines,
        'Pickup: a watcher checks the relay every couple of minutes and wakes Mr.Ghosty; scheduled sweeps back it up.'
      ].join('\n'));
    },
    ghost_handoff: async a => {
      const title = String((a && a.title) || 'Untitled task').trim();
      const taskText = String((a && a.task) || '').trim();
      if (!taskText) return textResult('A task description is required.', true);
      const tasks = await getTasks();
      const idemKey = a && (a.idempotencyKey || a.idempotency_key) ? String(a.idempotencyKey || a.idempotency_key).slice(0, 200) : null;
      if (idemKey) {
        const existing = tasks.find(t => t.idemKey && t.idemKey === idemKey && (t.createdBy || null) === (caller.keyName || null));
        if (existing) return textResult(`Duplicate suppressed — this idempotency key was already filed from this key as relay #${existing.id} "${existing.title}" (status: ${existing.status}). No second task was created. Follow it with ghost_task_result (task ${existing.id}).`);
      }
      const dup = tasks.find(t => t.type === 'task' && !['done', 'cancelled'].includes(t.status) && t.title.trim().toLowerCase() === title.toLowerCase());
      if (dup) return textResult(`Not sent — an open task with this exact title already exists: #${dup.id} "${dup.title}". Follow it with ghost_task_result or retitle.`, true);
      // Scheduling (v4.3): `due` -> dueAt, `schedule` -> notBefore.
      let dueAt = null, notBefore = null;
      const rawDue = a && (a.due !== undefined ? a.due : a.dueAt);
      const rawSched = a && (a.schedule !== undefined ? a.schedule : a.notBefore);
      if (rawDue) { const p = parseScheduleValue(rawDue, 'due'); if (p.error) return textResult(`Not sent — ${p.error}`, true); dueAt = p.val; }
      if (rawSched) { const p = parseScheduleValue(rawSched, 'schedule'); if (p.error) return textResult(`Not sent — ${p.error}`, true); notBefore = p.val; }
      // Dependencies (v4.4): blockedBy / dependsOn alias. Blockers must
      // exist (archived ones count — they are finished by construction).
      const deps = normalizeBlockedBy(a && (a.blockedBy !== undefined ? a.blockedBy : a.dependsOn));
      if (deps.error) return textResult(`Not sent — ${deps.error}`, true);
      if (deps.list.length) {
        const all = await getTasks(true);
        for (const id of deps.list) {
          if (!all.some(t => t.id === id)) return textResult(`Not sent — blockedBy task #${id} does not exist in the relay. File the blocker first, then the task that depends on it.`, true);
        }
      }
      const proj = a && a.project ? findProject(ctx, a.project) : null;
      const counter = (await readJSON(store, 'counter', 0)) + 1;
      await writeJSON(store, 'counter', counter);
      const now = new Date().toISOString();
      const body = [proj ? `Project: ${proj.name} [${proj.slug}] — ${proj.status}` : 'Project: (none specified)',
        ...(proj ? ['', '## Project context (from Mr.Ghosty)', proj.summary, '', `Project capsule: capsules/${proj.slug}.md — read before starting, update when state changes.`, '', '## Standing rules that apply', ...(ctx.rules || []).slice(0, 5).map(r => `- ${r}`)] : []),
        '', '## Task', taskText, '', '---', 'Queued via Ghost Bridge relay from Google Antigravity. Mr.Ghosty: execute under Ryan\'s standing rules; post the full result as a comment, then mark done.'].join('\n');
      const att = normalizeAttachments(a && a.attachments);
      if (att.error) return textResult(`Not sent — ${att.error}`, true);
      const task = { id: counter, type: 'task', title, body, project: proj ? proj.slug : (a && a.project) || null, priority: a && a.priority === 'urgent' ? 'urgent' : 'normal', status: 'queued', comments: [], attachments: att.list, result: null, createdBy: caller.keyName || 'hosted-mcp', claimedBy: null, claimExpiresAt: null, dueAt, notBefore, archived: false, archivedAt: null, ...(deps.list.length ? { blockedBy: deps.list } : {}), ...(idemKey ? { idemKey } : {}), createdAt: now, updatedAt: now, closedAt: null };
      tasks.push(task); await saveTasks(tasks);
      await emit('task.created', { taskId: task.id, title: task.title, taskType: task.type, priority: task.priority, via: 'hosted-mcp' });
      const schedLines = [
        ...(dueAt ? [`\nDue: ${dueAt}${Date.parse(dueAt) < Date.now() ? ' (already OVERDUE)' : ''}.`] : []),
        ...(notBefore ? [`\nScheduled: this task should NOT be picked up before ${notBefore} — pickup workers must skip it until then.`] : []),
        ...(deps.list.length ? [`\nBlocked by: ${deps.list.map(i => '#' + i).join(', ')} — this task cannot be claimed until every blocker is done or cancelled.`] : [])
      ];
      return textResult(`Task sent to Mr.Ghosty — relay #${task.id}${task.priority === 'urgent' ? ' (URGENT)' : ''}: ${task.title}${att.list.length ? `\nAttachments: ${att.list.map(x => x.name).join(', ')}` : ''}${schedLines.join('')}\nA watcher wakes him within a couple of minutes (or instantly, if an event watcher is connected). Follow it with ghost_inbox / ghost_task_result (task ${task.id}).`);
    },
    ghost_inbox: async a => {
      const limit = Math.min(Math.max(parseInt(a && a.limit, 10) || 10, 1), 30);
      const offset = Math.max(parseInt(a && a.offset, 10) || 0, 0);
      const all = await getTasks(true);
      const byId = taskIndex(all);
      const tasks = all.filter(t => !t.archived && t.type === 'task').sort((x, y) => y.id - x.id).slice(offset, offset + limit);
      return textResult(tasks.length ? tasks.map(t => statusLine(t, byId)).join('\n') : 'The queue is empty — no tasks have been sent yet.');
    },
    ghost_task_result: async a => {
      const n = parseInt(a && a.issue, 10);
      const all = await getTasks(true);
      const byId = taskIndex(all);
      const task = all.find(t => t.id === n && !t.archived) || all.find(t => t.id === n);
      if (!task) return textResult(`No task #${n} in the relay.`, true);
      const lines = [statusLine(task, byId), '', `Task:\n${task.body}`];
      const bi = blockedInfo(task, byId);
      if (bi) {
        lines.push('', bi.blocked
          ? `Blocked by: ${bi.blockedBy.map(i => `#${i}`).join(', ')} — still waiting on ${bi.blockedByUnfinished.map(i => `#${i}`).join(', ')}. This task cannot be claimed until every blocker is done or cancelled.`
          : `Blocked by: ${bi.blockedBy.map(i => `#${i}`).join(', ')} — all blockers finished, so this task is ready to claim.`);
      }
      if (task.dueAt) lines.push('', `Due: ${task.dueAt}${scheduleFlags(task).overdue ? ' (OVERDUE — still queued past its due time)' : ''}`);
      if (task.notBefore) lines.push('', `Scheduled: not before ${task.notBefore} — pickup workers should skip this task until then.`);
      if (task.archived) lines.push('', `Archived: ${task.archivedAt || 'yes'} (kept for the record; out of the working queue)`);
      if (task.claimedBy) lines.push('', `Claimed by: ${task.claimedBy}${task.claimExpiresAt ? ` (lease expires ${task.claimExpiresAt})` : ''}`);
      if ((task.attachments || []).length) {
        lines.push('', '--- Attachments ---');
        for (const at of task.attachments) lines.push(`- ${at.name} (${at.mime || 'application/octet-stream'}${at.size !== undefined ? `, ${at.size} bytes` : ''})${at.path ? ` — relay file: ${at.path}` : ''}${at.dataBase64 ? ' — inline data attached' : ''}`);
      }
      if (task.result) lines.push('', `--- Structured result ---\nStatus: ${task.result.status}\nSummary: ${task.result.summary || '(none)'}${(task.result.files || []).length ? `\nFiles: ${task.result.files.join(', ')}` : ''}`);
      if (task.comments.length) { lines.push('', '--- Thread ---'); for (const c of task.comments.slice(-10)) { lines.push(`\n@${c.author} (${c.at}):\n${c.body.length > 4000 ? c.body.slice(0, 4000) + '\n…[truncated]' : c.body}`); if (c.result) lines.push(`Structured result: status=${c.result.status}, summary=${c.result.summary || '(none)'}${(c.result.files || []).length ? `, files=${c.result.files.join(', ')}` : ''}`); } }
      else lines.push('', 'No comments yet — Mr.Ghosty has not picked this up yet (a watcher checks every couple of minutes).');
      return textResult(lines.join('\n'));
    },
    ghost_reply: async a => {
      const n = parseInt(a && a.issue, 10);
      const message = String((a && a.message) || '').trim();
      if (!n || !message) return textResult('Provide the issue number and the reply message.', true);
      const tasks = await getTasks();
      const task = tasks.find(t => t.id === n);
      if (!task) return textResult(`No task #${n}.`, true);
      task.comments.push({ author: 'ryan-via-antigravity', body: `Reply from Ryan (via Antigravity):\n\n${message}`, at: new Date().toISOString() });
      if (task.status === 'needs-approval') task.status = 'queued';
      task.updatedAt = new Date().toISOString();
      await saveTasks(tasks);
      await emit('task.comment', { taskId: task.id, title: task.title, author: 'ryan-via-antigravity', via: 'hosted-mcp' });
      return textResult(`Reply posted on task #${n}; any approval hold is cleared and the task is queued again. Mr.Ghosty resumes it on his next pickup.`);
    },
    ghost_cancel_task: async a => {
      const n = parseInt(a && a.issue, 10);
      const tasks = await getTasks();
      const task = tasks.find(t => t.id === n);
      if (!task) return textResult(`No task #${n}.`, true);
      task.comments.push({ author: 'antigravity', body: 'Cancelled from Antigravity via Ghost Bridge before completion.', at: new Date().toISOString() });
      task.status = 'cancelled'; task.closedAt = new Date().toISOString(); task.updatedAt = task.closedAt;
      await saveTasks(tasks);
      await emit('task.status', { taskId: task.id, title: task.title, status: 'cancelled', via: 'hosted-mcp' });
      return textResult(`Task #${n} cancelled.`);
    },
    ghost_new_results: async () => {
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const all = await getTasks();
      const byId = taskIndex(all);
      const tasks = all.filter(t => t.type === 'task' && new Date(t.updatedAt).getTime() > dayAgo).sort((x, y) => y.id - x.id).slice(0, 15);
      return textResult(tasks.length ? 'Ghost Bridge activity (last 24h):\n' + tasks.map(t => statusLine(t, byId)).join('\n') : 'No Ghost Bridge activity in the last 24 hours.');
    },
    ghost_search_tasks: async a => {
      const q = String((a && a.query) || '').toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      // Search is the one surface that also looks into the archive —
      // archived hits are marked so they are never mistaken for live work.
      const all = await getTasks(true);
      const byId = taskIndex(all);
      const hits = all.filter(t => t.type === 'task' && words.some(w => (t.title + ' ' + t.body + ' ' + (t.comments || []).map(c => c.body).join(' ')).toLowerCase().includes(w))).sort((x, y) => y.id - x.id).slice(0, 10);
      return textResult(hits.length ? hits.map(t => `${t.archived ? '[archived] ' : ''}${statusLine(t, byId)}`).join('\n') : `No tasks match "${a && a.query}".`);
    },
    ghost_capsule: async a => {
      const p = findProject(ctx, a && a.project);
      if (!p) return textResult(`No project found for "${a && a.project}".`, true);
      const key = `capsules/${p.slug}.md`;
      const existing = await store.get(`file:${key}`);
      if (existing === null || existing === undefined) {
        if (caller.scope === 'readonly') return textResult(capsuleTemplate(p) + '\n(Note: no capsule exists yet in the relay, and this read-only key cannot create one — showing the template a full key would create.)');
        const created = capsuleTemplate(p);
        await putFileWithRev(key, created, null);
        return textResult(`Capsule created for ${p.name}:\n\n${created}`);
      }
      return textResult(existing);
    },
    ghost_capsule_update: async a => {
      const p = findProject(ctx, a && a.project);
      if (!p) return textResult(`No project found for "${a && a.project}".`, true);
      if (!a.state && !a.decisions && !a.next && !a.note) return textResult('Provide at least one of: state, decisions, next, note.', true);
      const key = `capsules/${p.slug}.md`;
      const existing = await store.get(`file:${key}`);
      const revBefore = await fileRevOf(key);
      let md = existing !== null && existing !== undefined ? existing : capsuleTemplate(p);
      if (a.state) md = sectionReplace(md, 'State', String(a.state));
      if (a.decisions) md = sectionReplace(md, 'Decisions (locked)', String(a.decisions));
      if (a.next) md = sectionReplace(md, 'Next', String(a.next));
      if (a.note) md = md.replace(/\s*$/, '') + `\n- ${new Date().toISOString().slice(0, 10)} — ${String(a.note)}\n`;
      // note belongs in the log section; append at end is acceptable when the log is last (template order)
      const w = await putFileWithRev(key, md, revBefore);
      if (w.conflict) {
        return textResult(`Capsule for ${p.name} was NOT updated — revision conflict: another agent changed capsules/${p.slug}.md first (it is now at rev ${w.currentRev}; you read rev ${revBefore}). Nothing was overwritten. Re-read the capsule with ghost_capsule, merge your changes into the current text, then update again.`, true);
      }
      return textResult(`Capsule for ${p.name} updated (now rev ${w.rev}). Mr.Ghosty reads capsules on pickup, so he will work from this state.`);
    },
    ghost_publish_note: async a => {
      const title = String((a && a.title) || '').trim();
      const bodyText = String((a && a.body) || '').trim();
      if (!title || !bodyText) return textResult('A note needs a title and a body.', true);
      const tasks = await getTasks();
      const counter = (await readJSON(store, 'counter', 0)) + 1;
      await writeJSON(store, 'counter', counter);
      const now = new Date().toISOString();
      tasks.push({ id: counter, type: 'note', title: `[Note] ${title}`, body: bodyText, project: (a && a.project) || null, priority: 'normal', status: 'queued', comments: [], attachments: [], result: null, createdBy: caller.keyName || 'hosted-mcp', claimedBy: null, claimExpiresAt: null, createdAt: now, updatedAt: now, closedAt: null });
      await saveTasks(tasks);
      await emit('task.created', { taskId: counter, title: `[Note] ${title}`, taskType: 'note', via: 'hosted-mcp' });
      return textResult(`Note sent to Mr.Ghosty (#${counter}). He reads notes on his pickup sweep and folds them into memory and the project capsules.`);
    },
    ghost_board: async () => {
      const files = await getFiles();
      if (files['BOARD.md']) return textResult(files['BOARD.md']);
      const tasks = (await getTasks()).filter(t => t.type === 'task');
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const groups = [['Queued', tasks.filter(t => t.status === 'queued')], ['Working', tasks.filter(t => t.status === 'in-progress')], ['Waiting on Ryan', tasks.filter(t => t.status === 'needs-approval')], ['Done (last 7 days)', tasks.filter(t => t.status === 'done' && new Date(t.closedAt || t.updatedAt).getTime() > weekAgo)]];
      const lines = ['# Ghost Bridge Board (generated live)'];
      for (const [name, items] of groups) { lines.push('', `## ${name}`); if (!items.length) lines.push('- (none)'); for (const t of items) lines.push(`- #${t.id} ${t.title}`); }
      return textResult(lines.join('\n'));
    }
  };

  const toolDefs = [
    ['ghost_whoami', 'Who Mr.Ghosty and Ghost Developer Studio are, who Ryan Cotten is, how to work with him. Call first in a new session.', {}],
    ['ghost_projects', 'List all Ghost projects with status. Optional status filter.', { status: { type: 'string' } }],
    ['ghost_project_status', 'Full status for one project by slug or name.', { project: { type: 'string' } }, ['project']],
    ['ghost_rules', "Ryan's standing rules for all Ghost work.", {}],
    ['ghost_search', 'Keyword search across Ghost context.', { query: { type: 'string' } }, ['query']],
    ['ghost_bridge_status', 'Relay health: open task counts, context freshness, online agents, and a Digest (24h) section — completed, waiting on Ryan, overdue, blocked, new notes.', {}],
    ['ghost_handoff', 'Send a task to Mr.Ghosty via the hosted relay (he is woken within a couple of minutes, or instantly via the events stream). Optional attachments: [{name, mime?, size?, path? (relay file), dataBase64? (inline, max 256 KB each, max 5)}]. Optional idempotencyKey: re-filing the same key from the same bridge key returns the existing task instead of a duplicate. Optional scheduling (ISO dates): due (a due time — queued tasks past it are flagged OVERDUE) and schedule (a notBefore — pickup workers must SKIP the task until then). Optional blockedBy: [task numbers] (alias dependsOn) — the task cannot be claimed until every blocker is done or cancelled; blockers must already exist. Never include credentials.', { title: { type: 'string' }, task: { type: 'string' }, project: { type: 'string' }, priority: { type: 'string', enum: ['normal', 'urgent'] }, idempotencyKey: { type: 'string' }, due: { type: 'string' }, schedule: { type: 'string' }, blockedBy: { type: 'array', items: { type: 'number' } }, dependsOn: { type: 'array', items: { type: 'number' } }, attachments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'number' }, path: { type: 'string' }, dataBase64: { type: 'string' } }, required: ['name'] } } }, ['title', 'task']],
    ['ghost_inbox', 'Recent relay tasks + live status. limit (default 10, max 30) + offset page through the queue, newest first.', { limit: { type: 'number' }, offset: { type: 'number' } }],
    ['ghost_task_result', 'One task by number: status + full thread.', { issue: { type: 'number' } }, ['issue']],
    ['ghost_reply', "Post Ryan's reply on a task; clears an approval hold and re-queues it.", { issue: { type: 'number' }, message: { type: 'string' } }, ['issue', 'message']],
    ['ghost_cancel_task', 'Cancel a queued/waiting task.', { issue: { type: 'number' } }, ['issue']],
    ['ghost_new_results', 'Tasks with activity in the last 24 hours.', {}],
    ['ghost_search_tasks', 'Search relay tasks by keywords.', { query: { type: 'string' } }, ['query']],
    ['ghost_capsule', 'Read a project capsule (shared working memory). Auto-creates it.', { project: { type: 'string' } }, ['project']],
    ['ghost_capsule_update', 'Update capsule State/Decisions/Next sections and/or append a session-log note.', { project: { type: 'string' }, state: { type: 'string' }, decisions: { type: 'string' }, next: { type: 'string' }, note: { type: 'string' } }, ['project']],
    ['ghost_publish_note', 'Send Mr.Ghosty a note (decision/info, not a task).', { title: { type: 'string' }, body: { type: 'string' }, project: { type: 'string' } }, ['title', 'body']],
    ['ghost_board', 'The whole queue at a glance: queued / working / waiting / done.', {}]
  ];

  try {
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        return ok({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'ghost-bridge-relay', version: RELAY_VERSION } });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: toolDefs.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false } })) });
      case 'tools/call': {
        const fn = tools[params && params.name];
        if (!fn) return err(-32602, `Unknown tool: ${params && params.name}`);
        if (caller.scope === 'readonly' && MCP_WRITE_TOOLS.includes(params.name)) {
          return ok(textResult(`Not done — the bridge key "${caller.keyName}" is read-only (scope=readonly), and ${params.name} is a write tool. Reads work with this key; writes and key management need a full-scope key.`, true));
        }
        return ok(await fn((params && params.arguments) || {}));
      }
      case 'resources/list': return ok({ resources: [
        { uri: 'ghost://profile', name: 'Ghost Developer Studio profile', mimeType: 'application/json' },
        { uri: 'ghost://projects', name: 'Ghost projects and status', mimeType: 'application/json' },
        { uri: 'ghost://rules', name: "Ryan's standing rules", mimeType: 'text/plain' }
      ] });
      case 'resources/read': {
        const uri = params && params.uri;
        if (uri === 'ghost://profile') return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(ctx.profile || {}, null, 2) }] });
        if (uri === 'ghost://projects') return ok({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(ctx.projects || [], null, 2) }] });
        if (uri === 'ghost://rules') return ok({ contents: [{ uri, mimeType: 'text/plain', text: (ctx.rules || []).map((r, i) => `${i + 1}. ${r}`).join('\n') }] });
        return err(-32602, `Unknown resource: ${uri}`);
      }
      case 'prompts/list': return ok({ prompts: [{ name: 'work_like_mrghosty', description: 'Brief the agent to work the way Mr.Ghosty works for Ryan.', arguments: [{ name: 'task', description: 'The task to carry out', required: true }] }] });
      case 'prompts/get': {
        if (!params || params.name !== 'work_like_mrghosty') return err(-32602, `Unknown prompt: ${params && params.name}`);
        const task = (params.arguments && params.arguments.task) || '';
        return ok({ description: 'Work like Mr.Ghosty for Ryan Cotten', messages: [{ role: 'user', content: { type: 'text', text: `You are working in a Ghost Developer Studio workspace for Ryan Cotten, alongside Mr.Ghosty (his Muse agent). Before starting: call ghost_whoami, ghost_rules, and ghost_project_status for any named project. Follow those rules. If the work needs Muse-side access, send it with ghost_handoff. When picking up queued work, SKIP any task whose notBefore is in the future — it is scheduled, not ready, even though it sits in the queue.\n\nTask: ${task}` } }] });
      }
      default: return isNotification ? {} : err(-32601, `Method not found: ${method}`);
    }
  } catch (e) { return err(-32603, String(e && e.message || e)); }
}
