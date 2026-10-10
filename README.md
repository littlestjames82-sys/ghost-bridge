# Ghost Bridge

**An MCP bridge between AI coding agents and Mr.Ghosty — Ryan Cotten's Muse agent at [Ghost Developer Studio](https://github.com/your-username).**

Ghost Bridge lets a second agent (Google Antigravity, Cursor, Claude Code, Codex…) work *with* a personal Muse agent instead of next to it: shared studio context, shared per-project working memory ("capsules"), and a real, governed task queue with attachments, structured results, and instant wake events — every task an auditable thread, every consequential action gated on Ryan's approval.

Zero runtime dependencies. Node 18+. MIT.

## What this is — and what it isn't

Muse has **no public personal-agent API**: there is no endpoint that lets another app chat with a live Muse agent carrying its memory, files, accounts and tools. (Meta offers Muse *models* via the Model API — that is the raw model, not Mr.Ghosty.) Ghost Bridge is the closest real integration:

1. **Context bridge** — the second agent pulls Ghost Developer Studio's profile, real project statuses, and Ryan's standing rules while it works, from a `context.json` the bridge keeps fresh.
2. **Hosted relay** — a small server (Netlify Functions + Blobs, or local/Docker) holding the live queue: tasks, notes, capsules, a board, and the context itself. `ghost_handoff` files a real task; Mr.Ghosty is woken by an event watcher (seconds, not sweeps), does the work under Ryan's rules, and posts the result back in the thread.
3. **Governance is built in** — tasks needing paid spend, a public post/send, or anything destructive are never executed silently: they are parked as `needs-approval` with an explanation, and Ryan answers the hold from either side (`ghost_reply`).

## What's new in v4.4.0

- **`ghost-bridge doctor`** — a read-only diagnostic subcommand: Node version, version consistency across the 3 packages, context-file state (real vs example), relay reachability + version match + key scope + offline-outbox count when a relay is configured, and MCP config sanity via `--config`. Every check PASS/WARN/FAIL with a plain-language fix; exit 1 only on FAIL; `--json` mode; credentials are never printed.
- **Task dependencies** — `ghost_handoff` (and REST) accept `blockedBy: [task numbers]` (alias `dependsOn`). Blockers must exist; a task with an unfinished blocker is **blocked** (badge on the board, markers in inbox/results) and **claiming it returns 409** naming the blockers. Finishing or cancelling a blocker unblocks dependents automatically — the state is computed, never stored. Archived blockers count as satisfied (archive only takes finished tasks).
- **Digest** — `GET /api/digest?hours=24` (any key, readonly included): counts by status, what completed, what's **waiting on the owner**, what's overdue, new notes, agents seen — as JSON, or Markdown with `?format=md`. `ghost_bridge_status` shows a **Digest (24h)** section (no new tool — still 17), and the board grows a dismissible digest banner when anything waits on the owner or is overdue.
- **`/metrics`** — unauthenticated Prometheus text: task gauges by status, key count, event-log size, overdue + archived counts, version info. Counts only — no titles, no key material, no event bodies.
- **Context history** — every context publish is versioned (`contextVersion`, additive on reads); the last 10 versions are kept and any of them can be read back via `GET /api/context/history[/<n>]`.

## What's new in v4.3.0

- **Capsule concurrency** — relay files carry a revision counter (`rev`, also sent as an `ETag`). `PUT /api/files` accepts an optional `expectedRev`: a mismatch returns **409** with the current rev and a merge hint, and nothing is written — no more silent last-write-wins clobbering when two agents edit the same capsule. `ghost_capsule_update` (local MCP + hosted MCP) passes the rev it read automatically and surfaces a clear conflict message. Files written before v4.3 report rev 1.
- **Agent presence** — every named key gets a presence record: `POST /api/presence` heartbeats, `GET /api/presence` lists who's been seen in the last `GHOST_BRIDGE_PRESENCE_MINUTES` (default 10) with display name, capabilities, and status — never any key material. The local MCP heartbeats automatically on `ghost_bridge_status` / `ghost_handoff`, status shows the online agents, and the board grows an **Agents strip**. Readonly keys may heartbeat and read presence.
- **Task scheduling** — tasks accept `dueAt` / `notBefore` (handoff tools take `due` / `schedule`). A queued task past its due time is flagged **overdue** everywhere (board badge, inbox marker, `/health` count); a task whose `notBefore` is in the future is flagged **scheduled**, and pickup workers are told — in the prompt and the handoff result text — to skip it until then. No timer service: flags are computed on every read.
- **Pagination + search at scale** — `GET /api/tasks` gains `limit`/`offset` (response adds `total` when paging params are used) and a `q=` text filter over title/body/comments; `ghost_inbox` gains matching `limit`/`offset` arguments.
- **Archive + retention** — `POST /api/tasks/archive` (full-scope only, explicit call only — never a timer) moves done/cancelled tasks older than `GHOST_BRIDGE_ARCHIVE_DAYS` (default 30; 0 disables) into the archive: out of the board, default lists, and `/probe` counts, still in exports, readable via `?archived=1`, and found by `ghost_search_tasks` marked `[archived]`. `ghost-bridge archive` CLI included.

## What's new in v4.2.0

- **Signed webhooks** — set `GHOST_BRIDGE_WEBHOOK_SECRET` and webhook deliveries carry `x-ghost-signature: sha256=<hmac of the raw body>`; a verify helper + verified receiver example ship in `scripts/`. Unsigned mode (no secret) works exactly as before.
- **Backup / restore** — `GET /api/export` snapshots a whole relay (keys as names+scopes+hashes, tasks, files, context) into one JSON document; `POST /api/import` restores it into an empty relay (non-empty targets are refused unless forced with an explicit confirm). `ghost-bridge backup` / `ghost-bridge restore` CLI included.
- **Board task detail + owner actions** — click any task on the relay board for the full thread (comments, structured result, attachments, lease state); with a full-scope key, reply, approve a `needs-approval` hold, or cancel right from the board. Read-only keys get a view-only detail.
- **MCP offline outbox** — if the relay is unreachable, `ghost_handoff` queues the task locally with a queue-time idempotency key and says QUEUED, not delivered; the next successful bridge call flushes the outbox so it lands exactly once.
- **Packaging proof** — `npm run pack-audit` (also in CI, alongside a Node 18/20/22 test matrix) packs the real tarball and asserts it contains no private data, no secret files, and every runtime essential.

## What's new in v4.1.0

- **Scoped keys** — mint `readonly` keys for dashboards/watchers: full read access, every write and all key management refused with a clear error.
- **Claim leases** — claiming a task leases it to your key for 15 minutes; a second agent gets a 409 naming the holder instead of double-working the task. Expired leases can be re-claimed.
- **Idempotent handoffs** — pass an `idempotencyKey` and retries are safe: the same filing returns the existing task, never a duplicate.
- **Live board** — the relay's board page updates itself over the events long-poll, shows claim holders with lease countdowns and 📎 attachments, and manages keys (full-scope keys only).
- **Self-protection** — per-key rate limiting (429 + `Retry-After`), a capped event log, and a richer `/health` (counts by status, key count, log size).

## What's new in v4.0.0

- **Multi-client keys** — named keys per machine/client (`primary`, `cursor-laptop`, …), sha256-hashed at rest, list/revoke individually. A v3 single-key relay upgrades in place: the old key becomes `primary` and keeps working, no re-setup.
- **Push wake** — an event log + SSE stream (local/Docker) and a long-poll endpoint (serverless-safe), plus an optional outbound webhook on every task event. Polling still works as fallback.
- **Attachments + structured results** — send files with a task (inline up to 256 KB each, or by relay-file path); results come back as `{status, summary, files[]}`, not just prose.
- **One-command install** — `npx ghost-bridge setup`, a unified repo, Docker compose, a Netlify deploy button, CI on every push.
- **More clients, actually documented** — verified-format configs for Antigravity, Cursor, Claude Code, and Codex in [`docs/clients/`](docs/clients/).

## Quickstart

```bash
# Hosted-relay setup (recommended) — pairing code from Mr.Ghosty, no GitHub token:
npx ghost-bridge setup --relay --pack

# Prove the whole loop locally in one command (boots its own relay):
npx ghost-bridge demo
```

From a clone:

```bash
git clone https://github.com/your-username/ghost-bridge
cd ghost-bridge
npm test        # both suites — MCP 122 checks, relay 192 checks
npm run demo    # self-proving end-to-end demo
```

Manual per-client configs live in [`docs/clients/`](docs/clients/).

## The tools (17)

| Tool | What it does |
|---|---|
| `ghost_whoami` | Studio + Mr.Ghosty profile, how to work with Ryan, relay + context status |
| `ghost_bridge_status` | Health check: relay reachable? queue counts? context fresh? which agents are online? plus a Digest (24h) — completed / waiting on Ryan / overdue / blocked (heartbeats automatically) |
| `ghost_projects` | All projects + statuses (optional status filter) |
| `ghost_project_status` | One project by slug/name, full status |
| `ghost_rules` | Ryan's standing rules (spend, publishing, parked work…) |
| `ghost_search` | Keyword search across all context |
| `ghost_handoff` | Send a task to Mr.Ghosty (optional `attachments`, `due` / `schedule`, `blockedBy` dependencies), urgent flag, duplicate-title guard |
| `ghost_inbox` | Recent queue tasks + live status (`limit` / `offset` paging; `[OVERDUE]` / `[scheduled]` / `[BLOCKED by #n]` markers) |
| `ghost_task_result` | One task's thread, attachments, and structured results |
| `ghost_reply` | Answer a task (e.g. approve a `needs-approval` hold) — clears the hold |
| `ghost_cancel_task` | Cancel a queued/waiting task |
| `ghost_new_results` | Tasks with activity since your last check — each surfaces once |
| `ghost_search_tasks` | Search past/current tasks by keyword — archived tasks included, marked `[archived]` |
| `ghost_capsule` | Read a project's shared capsule; auto-creates it |
| `ghost_capsule_update` | Update capsule sections and/or append a session-log line (revision-checked — a conflicting edit is reported, never silently overwritten) |
| `ghost_publish_note` | Send a note (decision, info) — not a task |
| `ghost_board` | The whole queue at a glance: queued / working / waiting on Ryan / done |

Resources: `ghost://profile`, `ghost://projects`, `ghost://rules`.
Prompt: `work_like_mrghosty`.

The same 17 tools are served two ways: by the local MCP server (`mcp/server.js`, stdio + HTTP) and by the relay's hosted `/mcp` endpoint for clients that support remote MCP with header auth.

**Live board:** the relay also serves a self-updating board page (`relay/public/index.html`) — paste your key, watch Queued / Working / Waiting on owner / Done move in real time over the events long-poll, see who holds each claim and for how long, and (with a full-scope key) mint and revoke keys. Click any task (v4.2) to open its full thread — comments, structured result, attachments, lease state — and, with a full-scope key, reply, approve a `needs-approval` hold, or cancel it right there (the same REST endpoints and reply semantics the MCP tools use; nothing parallel). Read-only keys get the full thread, view-only, with the actions explained away. New in v4.3: an **Agents strip** shows which bridge clients are online (presence heartbeats, green when fresh), queued tasks carry **OVERDUE** / **scheduled** badges with due times, and the header stats count overdue and archived tasks. New in v4.4: a **digest banner** under the header flags what's waiting on the owner and what's overdue (dismissible until the counts change), and blocked tasks carry a ⛓ **BLOCKED by #n** badge naming the unfinished blockers. One static file, no build step.

## Self-hosting the relay

**Netlify (persistent, recommended):**

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/your-username/ghost-bridge)

Deploy the `relay/` directory as the site base. Set env vars `BRIDGE_SETUP_SECRET` (your bootstrap secret) and, for durable Blobs access, `BRIDGE_BLOBS_SITE_ID` + `BRIDGE_BLOBS_TOKEN` from *your own* Netlify account. Then register your first key with `POST /setup`.

**Docker (local/self-hosted):**

```bash
docker compose up --build   # relay on http://127.0.0.1:8877, store volume-backed
```

**Plain local:**

```bash
BRIDGE_SETUP_SECRET=pick-something-long node relay/local-server.mjs 8877
```

> **SSE note:** Netlify Functions can't hold a stream open, so on Netlify the wake path is long-poll (`GET /api/events?since=<seq>&wait=20`) or the webhook. The SSE stream (`GET /api/events/stream`) works on the local/Docker servers. See [`docs/events.md`](docs/events.md).

## Keys

```bash
# First key — bootstrap, gated by the setup secret:
curl -X POST $RELAY/setup -d '{"key":"<long-random>","setupSecret":"<secret>","name":"primary"}'
# More keys — requires any valid key; omit "key" to have one generated (shown once):
curl -X POST $RELAY/api/keys -H 'x-bridge-key: <key>' -d '{"name":"cursor-laptop"}'
curl $RELAY/api/keys -H 'x-bridge-key: <key>'            # names + timestamps only, never hashes
curl -X DELETE $RELAY/api/keys/cursor-laptop -H 'x-bridge-key: <key>'   # revoke one client
```

Only sha256 hashes are stored. Revoking one key never touches the others. `POST /setup/reset` (current key + setup secret) clears all keys.

**Scopes (v4.1):** a key is `full` (default) or `readonly`. Readonly keys can read everything (tasks, files, context, board, events, the read-only MCP tools) but every write — task create/comment/status, file/context writes, capsule updates, archiving — and all key management is refused with a 403 (REST) or a clear `isError` (hosted MCP). One deliberate exception (v4.3): readonly keys may heartbeat and read **presence**, because a heartbeat only ever writes the caller's own presence record — see *Agent presence* below. Mint one with `"scope": "readonly"` in the `POST /api/keys` body; `GET /api/keys` shows each key's scope. Use readonly keys for boards, watchers, and anything that should never be able to act.

## Claiming work (leases, v4.1)

Claiming prevents two agents double-working one task. `PATCH /api/tasks/:id` to `in-progress` (or `{claim: true}`) records a lease on the task: `claimedBy` = your key's name, `claimExpiresAt` = now + 15 minutes (`GHOST_BRIDGE_CLAIM_MINUTES`, or `claimMinutes` per claim). While the lease is active, a claim from a *different* key returns **409** with the holder and expiry; the holder re-claiming renews it. An expired lease can be re-claimed by anyone. Releasing (back to `queued`), finishing (`done`/`cancelled`), or parking (`needs-approval`) clears the lease. `ghost_task_result` shows who holds a task.

## Idempotent handoffs (v4.1)

Retries happen — timeouts, double-clicks, agent restarts. Pass an `idempotencyKey` with `ghost_handoff` (or `POST /api/tasks`) and re-filing the same key **from the same bridge key** returns the existing task instead of creating a duplicate: REST answers `200` with `duplicateSuppressed: true`; the MCP tools answer with a "Duplicate suppressed" note and the original task number. Keys are stored on the task but never shown in normal reads. Without an idempotency key, the v3 duplicate-title guard still applies.

## Rate limits & retention (v4.1)

Authenticated calls are rate-limited per key: `GHOST_BRIDGE_RATE_PER_MIN` (default **600/min/key** — far above normal agent traffic; it exists to stop a runaway loop). Over the limit you get **429** with a `Retry-After` header. `/probe` and `/health` share a light unauthenticated bucket. The event log keeps the newest `GHOST_BRIDGE_EVENT_CAP` events (default **500**). `GET /health` reports counts by status, how many keys exist, and the event-log size — never any key material.

## Attachments & structured results

```jsonc
// ghost_handoff arguments
{ "title": "Check this log", "task": "Find the failure.",
  "attachments": [{ "name": "run.log", "mime": "text/plain", "dataBase64": "…" }] }
// → or { "name": "shot.png", "path": "uploads/shot.png" } for a file already in the relay.
// Caps: 5 attachments/task, 256 KB decoded per inline attachment.

// A result comment on the REST API (the MCP thread surfaces it):
POST /api/tasks/3/comments
{ "author": "mrghosty", "body": "Done.", "result": { "status": "done", "summary": "Failure was a bad token.", "files": ["reports/run-3.md"] } }
```

## Backup & restore (v4.2)

```bash
# Export a whole relay to one JSON document (full-scope key required):
GHOST_RELAY_URL=$RELAY GHOST_BRIDGE_KEY=<full key> npx ghost-bridge backup --out backup.json
# Restore it into a FRESH relay (register a bootstrap key there first):
GHOST_RELAY_URL=$NEW_RELAY GHOST_BRIDGE_KEY=<bootstrap key> npx ghost-bridge restore backup.json
```

`GET /api/export` returns `{format, version, exportedAt, keys, tasks, files, context, counter}` — keys as names + scopes + **sha256 hashes only** (plaintext keys are never stored), tasks complete (comments, attachments, and the internal idempotency keys, so a restored relay keeps suppressing duplicates), files, and context; add `?events=1` to include the event log. `POST /api/import` restores into an **empty** relay and refuses a non-empty one with 409 — overwriting requires `?force=true` **and** `{"confirm": "OVERWRITE"}` in the body (`restore --force` sends both, after warning you). Imported keys replace the target's key list, except the key you restore *with* is preserved (renamed `<name>-preimport` on a collision) so a restore can never lock you out. After import, the exported keys authenticate and tasks/files/context match. **Treat backup files as sensitive** — they're your whole queue and working memory in one document (the CLI writes them mode `0600`).

## Offline outbox (v4.2, MCP client)

Relays go down; tasks shouldn't vanish with them. On the relay transport, if `ghost_handoff` can't reach the relay at all (connection refused / DNS / timeout — a *transport* failure), the handoff is written to `~/.ghost-bridge/outbox.json` (override: `GHOST_OUTBOX_PATH`) with an idempotency key minted at queue time, and the tool result says plainly that it was **QUEUED locally, NOT delivered**. The next `ghost_bridge_status` or `ghost_handoff` that reaches the relay flushes the outbox in order; the idempotency key makes delivery land exactly once, and `ghost_bridge_status` reports the pending count + the last flush result. Relay HTTP errors (a 401 is an answer, not an outage) are never queued. The GitHub-queue and local-file transports are unchanged.

## Capsule revisions (v4.3)

Capsules are shared working memory — two agents can legitimately edit the same capsule in overlapping sessions, and before v4.3 the second write silently won. Now every relay file carries a revision counter, stored alongside the file and exposed on reads:

```bash
curl $RELAY/api/files?path=capsules/ghostcut.md -H 'x-bridge-key: <key>'
# → { "path": "capsules/ghostcut.md", "text": "…", "rev": 3 }   (also: ETag: "rev-3")

curl -X PUT $RELAY/api/files -H 'x-bridge-key: <key>' \
  -d '{"path":"capsules/ghostcut.md","text":"…","expectedRev":3}'
# → 200 { "ok": true, "rev": 4 }            — your base was current
# → 409 { "error": "revision conflict … merge hint …", "currentRev": 5 }
#    when someone else wrote first. NOTHING is written on a 409.
```

`expectedRev` is **optional**: leave it out and writes stay last-write-wins, exactly as before (scripts and older clients keep working). `ghost_capsule_update` — in both the local MCP and the hosted MCP — always reads the current rev first and passes it, so an agent whose edit collides gets a clear "was NOT updated — revision conflict" result telling it to re-read and merge, instead of quietly clobbering a teammate's work. Files written before v4.3 have no stored rev; they read as **rev 1**, and their first v4.3 write lands at rev 2.

## Agent presence (v4.3)

Named keys double as agent identities. A client heartbeats to say "I'm here":

```bash
curl -X POST $RELAY/api/presence -H 'x-bridge-key: <key>' \
  -d '{"displayName":"Cursor on the laptop","capabilities":["code","review"],"status":"online"}'
curl $RELAY/api/presence -H 'x-bridge-key: <key>'
# → { "agents": [ { "name": "primary", "displayName": "…", "capabilities": […],
#                   "status": "online", "lastSeen": "…" } ], "windowMinutes": 10 }
```

The list only includes agents seen within `GHOST_BRIDGE_PRESENCE_MINUTES` (default **10**), and it never contains key material or hashes — names, display names, capabilities, status, last seen, that's all. Presence is deliberately a *read-ish* surface: a heartbeat only ever writes the caller's **own** record, so **readonly keys may heartbeat and read presence** (a dashboard key can announce itself without gaining any write power). The local MCP heartbeats automatically on `ghost_bridge_status` and `ghost_handoff` (throttled, best-effort — a failed heartbeat never fails the tool), `ghost_bridge_status` prints the online agents, and the board's Agents strip shows them with a freshness dot.

## Task scheduling (v4.3)

Tasks can carry two optional ISO timestamps: `dueAt` (a due time) and `notBefore` (don't start before). The handoff tools accept them as `due` / `schedule`; REST accepts both the canonical names and the aliases; `PATCH /api/tasks/:id` can set or clear them on their own (a schedule-only patch never touches status or a claim lease). Malformed dates are a **400** with a clear error, everywhere.

- **Overdue** — a task still `queued` after its `dueAt` is flagged on every read (`overdue: true`), badged on the board, marked `[OVERDUE]` in `ghost_inbox`, and counted in `GET /health` (`overdue`).
- **Scheduled** — a queued task whose `notBefore` is in the future is flagged `scheduled`, badged on the board, and marked `[scheduled — not before …]` in the inbox.

There is deliberately **no timer service**: nothing fires when a time passes — flags are computed fresh on every read, so they're never stale. Scheduling only works if pickup workers honor it, so the rule is written where workers see it: the `work_like_mrghosty` prompt and every scheduled handoff's result text say to **skip tasks whose `notBefore` is in the future**, and `scripts/watch.mjs` consumers see the same flags in task reads. Events still fire at creation, as before.

## Pagination & search (v4.3)

`GET /api/tasks` scales past a demo-sized queue now:

```bash
curl "$RELAY/api/tasks?state=all&limit=5&offset=10" -H 'x-bridge-key: <key>'
# → { "tasks": […], "total": 42, "limit": 5, "offset": 10 }
curl "$RELAY/api/tasks?state=all&q=invoice" -H 'x-bridge-key: <key>'
# → tasks whose title, body, or comments mention "invoice" (any-word match,
#    same semantics as ghost_search_tasks)
```

Backward compatible by construction: with **no** paging params the response is exactly the v4.2 shape (`{tasks}` — the `total`/`limit`/`offset` fields only appear when you pass `limit` or `offset`), and the default page size stays 50 (max 200). `ghost_inbox` takes matching `limit` / `offset` arguments, so an agent can walk a long queue five at a time with no dupes or gaps.

## Archive & retention (v4.3)

Finished work shouldn't bury the live queue forever — but nothing is ever deleted, and nothing moves on a timer. Archiving is an **explicit call**, full-scope keys only:

```bash
GHOST_RELAY_URL=$RELAY GHOST_BRIDGE_KEY=<full key> npx ghost-bridge archive [--days 30]
# or: POST /api/tasks/archive  { "days": 30 }   (days optional — see below)
```

Eligible = `done` / `cancelled` tasks whose close time is older than the cutoff. The cutoff is the body's `days` when given, else the relay's `GHOST_BRIDGE_ARCHIVE_DAYS` (default **30**); **0 disables** archiving (the call becomes a documented no-op). The response says exactly what moved: `{archived, archivedIds, days}`. Archived tasks:

- disappear from the board, default task lists, `/api/meta`, and `/probe` counts (the board is a working surface, not an archive);
- stay fully readable via `GET /api/tasks?archived=1` and `GET /api/tasks/:id`;
- are found by `ghost_search_tasks` (local + hosted), always marked `[archived]`;
- remain in `GET /api/export`, so backups lose nothing;
- are counted in `GET /health` (`archived`).

## Doctor (v4.4)

Something feels off with a bridge install? Ask the doctor before digging:

```bash
npx ghost-bridge doctor                      # human-readable, plain-language fixes
npx ghost-bridge doctor --json               # machine-readable
npx ghost-bridge doctor --config ~/.gemini/config/mcp_config.json
```

Read-only checks: Node version; version consistency across the three `package.json` files and both code constants; the context file (a real `context.json` vs the EXAMPLE template, and whether it parses); the relay when one is configured (`/health` + `/probe` reachability, relay-vs-local version comparison, whether your key is accepted and its **scope** — learned from harmless authed reads — and the offline-outbox pending count); and, with `--config`, a client MCP config's sanity. Each check is PASS / WARN / FAIL / SKIP with a fix line for anything that isn't a PASS. **Exit code is 1 only on a FAIL** — warnings never fail a script. Credentials are never printed, only presence and scope.

## Task dependencies (v4.4)

Some work can't start until other work lands. File the blocker first, then the dependent:

```bash
# REST: POST /api/tasks { "title": "Ship it", "body": "…", "blockedBy": [12] }
# ghost_handoff takes blockedBy too (dependsOn is an accepted alias),
# and PATCH /api/tasks/:id can add, change, or clear blockedBy later.
```

Rules, all enforced by the relay:

- Every blocker must already exist — a dangling number is a **400** (REST) / "Not sent" (MCP), and a task can never block itself.
- A task with any blocker not `done`/`cancelled` is **blocked**: it reads back with `blocked: true` + `blockedByUnfinished`, wears a ⛓ BLOCKED badge on the board, and shows `[BLOCKED by #n]` in `ghost_inbox` / `ghost_task_result`.
- **Claiming a blocked task is a 409** naming the unfinished blockers (`PATCH` to `in-progress`, or `{claim: true}`).
- Blocked state is *computed on every read* — completing or cancelling a blocker unblocks its dependents automatically; nothing is mutated and nothing can drift.
- **Archived blockers count as satisfied.** Archive only ever takes done/cancelled tasks, so an archived blocker is a finished blocker by construction.

## Digest (v4.4)

One call that answers "what happened, and what needs me?":

```bash
curl -H "x-bridge-key: $KEY" "$RELAY/api/digest?hours=24"            # JSON
curl -H "x-bridge-key: $KEY" "$RELAY/api/digest?hours=24&format=md"   # Markdown, paste-ready
```

Any authed key works, readonly included. The digest carries: counts by status; tasks **completed** in the window (with `completedBy` when the event log can attribute them); the **waiting-on-owner** list (every `needs-approval` task, oldest first — this is the list that matters); the **overdue** list; the **blocked** list; new task/note counts for the window; and agents seen. Waiting/overdue/blocked are current state, never windowed out — an old approval wait matters more, not less. The same digest shows up as the **Digest (24h)** section of `ghost_bridge_status` (no new MCP tool — the surface stays at 17), and the board's digest banner is fed by this endpoint.

## Ops endpoints — /probe vs /health vs /metrics (v4.4)

Three unauthenticated, counts-only surfaces; pick by who's asking:

| Endpoint | Format | Use it for |
|---|---|---|
| `GET /probe` | JSON | **Agents/pickup watchers** — "is there work for me?" `queued` / `urgent` / `notes` counts + the actionable task ids + the relay version. |
| `GET /health` | JSON | **Humans and uptime checks** — the full snapshot: `ok`, version, task totals, `byStatus`, `overdue`, `archived`, key count, event-log size. |
| `GET /metrics` | Prometheus text | **Monitoring stacks** (Prometheus/Grafana/alerts) — `ghost_bridge_tasks{status="…"}`, `ghost_bridge_keys`, `ghost_bridge_events_total`, `ghost_bridge_overdue`, `ghost_bridge_archived`, `ghost_bridge_version_info{version="4.4.0"} 1`. Point your scraper at it; alert on `ghost_bridge_overdue > 0` or a growing `needs-approval` gauge. |

All three are deliberately safe to leave unauthenticated: counts and version only — no titles, no key material, no event bodies, ever.

## Context history (v4.4)

The published context is the bridge's shared brain, so its changes are kept. Every `PUT /api/context` bumps a **context version** (monotonic, starting at 1) and archives the outgoing context as a snapshot:

```bash
curl -X PUT -H "x-bridge-key: $KEY" "$RELAY/api/context" -d @context.json
# → { "ok": true, "version": 7, "contextVersion": 7 }
curl -H "x-bridge-key: $KEY" "$RELAY/api/context"            # the context + "contextVersion": 7 (additive)
curl -H "x-bridge-key: $KEY" "$RELAY/api/context/history"    # [{n, at, projects, current?}, …]
curl -H "x-bridge-key: $KEY" "$RELAY/api/context/history/3"  # the version-3 snapshot itself
```

History endpoints accept any authed key, readonly included. Retention is the **last 10 versions in total** (the current version plus up to 9 snapshots); older snapshots are pruned as new ones land. Restoring a backup (`POST /api/import`) restarts history at version 1 — snapshots are not carried over. The local MCP shows the relay's context version in `ghost_whoami` / `ghost_bridge_status` when the relay provides one.

## Repo layout

```
ghost-bridge/
├── mcp/            local MCP server (stdio/HTTP), setup.mjs, Antigravity pack
├── relay/          relay core (transport-agnostic), Netlify function, local server, board page
├── bin/            the `ghost-bridge` CLI (npx entrypoint)
├── scripts/        demo.mjs (self-proving loop), watch.mjs (event tail),
│                   doctor.mjs (read-only diagnostics),
│                   backup.mjs / restore.mjs, archive.mjs (retention),
│                   webhook-verify.mjs + webhook-receiver.mjs,
│                   pack-audit.mjs (tarball proof)
├── docs/clients/   verified MCP config examples per client
└── docs/events.md  SSE / long-poll / webhook watcher guide
```

## Security

Keys are bearer credentials — treat them like passwords: one per machine, revoke freely, never commit them (or a filled-in `context.json`) to a repo. The shipped `context.example.json` is a blank template on purpose; Ryan's real context, relay, and keys are **not** in this repository and never leave his private instance. See [SECURITY.md](SECURITY.md).

## License

MIT © Ryan Cotten / Ghost Developer Studio. Built by Mr.Ghosty with Ryan Cotten.
