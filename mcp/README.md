# Ghost Bridge MCP — v4.4

> This is the `mcp/` package of the unified Ghost Bridge repo — see the root `README.md` for the full picture (relay self-hosting, client configs for Cursor/Claude Code/Codex, events, keys).
>
> **New in v4.4:** `ghost_handoff` accepts `blockedBy` (alias `dependsOn`) — task numbers that must finish before the new task can be claimed (the relay refuses dangling blockers with a "Not sent", and claiming a blocked task is a 409 over REST); blocked tasks are marked `[BLOCKED by #n]` in `ghost_inbox` and explained in `ghost_task_result`. `ghost_bridge_status` gains a **Digest (24h)** section from the relay's `GET /api/digest` (completed / waiting on Ryan / overdue / blocked / new notes) — no new tool; the surface stays at 17. `ghost_whoami` / `ghost_bridge_status` show the relay's **context version** when it provides one (context publishes are versioned; history lives at `GET /api/context/history`). And there's a doctor in the house: `npx ghost-bridge doctor` runs read-only install diagnostics (versions, context file, relay reachability + key scope, outbox, `--config` sanity) with plain-language fixes.
> **New in v4.3:** capsule writes are revision-checked — `ghost_capsule_update` passes the rev it read and a conflicting edit comes back as a clear "NOT updated — revision conflict" (re-read and merge) instead of silently overwriting another agent; `ghost_handoff` accepts `due` / `schedule` (ISO) for overdue/scheduled tasks; `ghost_inbox` accepts `offset` paging; `ghost_search_tasks` also searches archived tasks (marked `[archived]`, and it now works on relay-only setups); and the client heartbeats its presence automatically on `ghost_bridge_status` / `ghost_handoff`, with the online agents listed in `ghost_bridge_status`. Set `GHOST_AGENT_NAME` to change the display name it announces.

> **New in v4.2:** offline outbox — if the hosted relay is *unreachable* (a transport failure, not an HTTP error), `ghost_handoff` queues the task locally in `~/.ghost-bridge/outbox.json` (override: `GHOST_OUTBOX_PATH`) with a queue-time idempotency key, says clearly that it was QUEUED and NOT delivered, and later `ghost_bridge_status` / `ghost_handoff` calls flush the outbox in order so it lands exactly once. `ghost_bridge_status` reports the pending count and the last flush result. Relay HTTP errors (401/403/429/500) are never queued — the relay answered, and the answer was no.

> **New in v4.1:** scoped keys (`readonly` keys are refused — clearly — on write tools by the hosted MCP), claim leases surfaced in `ghost_task_result`, and `ghost_handoff` accepts an `idempotencyKey` for duplicate-safe retries over the relay transport.
>
> **New in v4:** named multi-client relay keys (v3 keys migrate automatically), push wake via relay events (long-poll/SSE/webhook), `ghost_handoff` attachments + structured results surfaced by `ghost_task_result`, and `npx ghost-bridge setup` as the one-command install. If `context.json` doesn't exist yet, the server falls back to the shipped `context.example.json` template so a fresh install still answers.

A small, zero-dependency MCP server that connects **Google Antigravity** (or any
MCP client — Cursor, Claude Code, etc.) to **Mr.Ghosty**, Ryan Cotten's Muse
agent, for Ghost Developer Studio work.

## What this is — and what it isn't

Muse has **no public personal-agent API**: there is no endpoint that lets
another app chat with a live Muse agent carrying its memory, files, accounts
and tools. (Meta offers Muse *models* to developers via the Model API — that
is the raw model, not Mr.Ghosty.)

Ghost Bridge is the closest real integration, in two layers:

1. **Context bridge — now self-updating.** Antigravity's agent pulls Ryan's
   studio profile, real project statuses, and his standing rules while it
   codes. The freshest context is published by Mr.Ghosty into the queue repo
   (`context.json`); the bridge fetches it automatically (5-minute cache) and
   falls back to the bundled snapshot if the repo is unreachable — so statuses
   no longer go stale between zip downloads.
2. **Live relay.** `ghost_handoff` files a real task into a private GitHub
   queue repo. A lightweight watcher checks the queue **every couple of
   minutes** and wakes Mr.Ghosty when tasks land (scheduled pickup sweeps run
   as backup and re-sync the live context). He does the work under Ryan's
   standing rules and posts the result back on the task. Antigravity reads
   status/results with `ghost_inbox` / `ghost_task_result`, Ryan gets a
   summary in Muse, and the repo is a full audit trail.

Governance, built in: tasks that need paid spend, a public post/send, or
anything destructive are **not** executed — Mr.Ghosty labels them
`needs-approval`, explains what's needed, and waits for Ryan. Ryan can answer
the hold **without leaving Antigravity**: `ghost_reply` posts his answer and
clears the hold, and the task resumes on the next pickup. Tasks can also be
sent as `urgent` or cancelled from Antigravity, and `ghost_new_results`
catches Ryan up on anything that changed since his last check — each result
surfaces once, not forever. Handoffs automatically carry a context pack
(project summary + the standing rules that apply), and `ghost_bridge_status`
warns when a newer Ghost Bridge version exists.

3. **Hosted relay (v3.0, Level 3).** The queue moved off GitHub onto a small
   hosted relay (Netlify Functions + Blobs) at
   `YOUR-RELAY.example.com`. Setup is one command — `node setup.mjs
   --relay` — with a pairing code from Mr.Ghosty: the script generates this
   machine's bridge key, registers it with the relay, and saves it to
   `~/.ghost-bridge/credentials` (never in the MCP config, never in chat).
   Antigravity can also skip the local server entirely where its remote-MCP
   config supports header auth: `serverUrl` = the relay's `/mcp`, header
   `x-bridge-key` = the same key. The relay is the single live store now;
   the GitHub repo remains as the v1–v2 archive.

4. **Shared brain (v2.0).** Each project has a **capsule** in the queue repo
   (`capsules/<slug>.md`): state, locked decisions, next steps, session log —
   maintained by *both* agents, so context survives sessions on either side.
   Antigravity sends non-task information with `ghost_publish_note` (Ryan's
   decisions, things learned) and Mr.Ghosty folds it into his memory and the
   capsules. `BOARD.md` in the repo (read via `ghost_board`) shows the whole
   queue at a glance. The Antigravity pack adds `/session-start` and
   `/session-end` workflows that run this ritual automatically.

## The Antigravity pack (make every workspace behave Ghost)

The `antigravity-pack/` folder turns the bridge from a tool into the default
way Antigravity works in Ryan's projects:

- `AGENTS.md` — the master rule set (studio, rules, handoff etiquette).
  Install globally with `node setup.mjs --pack` (merges a marked Ghost
  section into `~/.gemini/AGENTS.md`, safe to re-run), or drop it at a repo
  root for per-project rules.
- `.agents/rules/ghost-bridge.md` — compact always-on workspace rule.
- `.agents/workflows/` — `/handoff` and `/bridge-check` slash commands.
- `.agents/skills/ghost-bridge/SKILL.md` — on-demand deep guide to the
  bridge tools and flows.

Copy the `.agents` folder into any repo Ryan works in; it versions with the
project.

## Requirements

- Node.js 18 or newer (`node --version`)
- No `npm install` needed — zero dependencies.
- GitHub auth for the relay, **either** way:
  - **GitHub CLI (easiest):** `gh` installed and logged in (`gh auth login`).
    The bridge uses that session — *no token to create, paste, or store*.
  - **Or** a fine-grained token from Ryan (setup below).
  Without either, context tools use the bundled snapshot and handoffs fall
  back to local files in `handoffs/`.

## Setup (one command)

**Recommended — hosted relay (Level 3).** No GitHub account or token needed:

```bash
node setup.mjs --relay --pack
```

It asks for the **pairing code** Mr.Ghosty gave you in Muse, generates this
machine's bridge key, registers it with the relay
(`YOUR-RELAY.example.com`), saves the key to
`~/.ghost-bridge/credentials` (mode 600, never in the config or chat), writes
the Antigravity entry with only the relay URL, and (with `--pack`) installs
the Ghost rules/workflows. Then restart Antigravity. One follow-up: Mr.Ghosty
sends a secure card in Muse — paste the same key from
`~/.ghost-bridge/credentials` into it so he can work the queue from his side.

**Legacy — GitHub queue (v1–v2).** The original transport still works: run
`node setup.mjs` and either use a logged-in `gh` CLI or a fine-grained token
(repo `your-username/your-queue-repo` only; Issues Read+Write,
Contents Read, Metadata Read). The relay takes priority whenever both are
configured; the GitHub repo is kept as the archive of the v1–v2 era.

Manual config (if you prefer not to run the script): paste the entry from
`antigravity-mcp_config.json` into the same global config file, replacing the
path and token placeholders.

## Tools (17)

| Tool | What it does |
|---|---|
| `ghost_whoami` | Studio + Mr.Ghosty profile, how to work with Ryan, relay + context status |
| `ghost_bridge_status` | Health check: relay reachable? queue counts? context fresh? likely fixes; online agents (heartbeats first) |
| `ghost_projects` | All projects + statuses (optional status filter) |
| `ghost_project_status` | One project by slug/name, full status |
| `ghost_rules` | Ryan's standing rules (spend, publishing, parked work…) |
| `ghost_search` | Keyword search across all context |
| `ghost_handoff` | Send a task to Mr.Ghosty (live queue, or local file fallback); `priority: "urgent"` jumps the queue; optional `due` / `schedule` (ISO) for due times and not-before scheduling; duplicate open titles are blocked |
| `ghost_inbox` | Recent queue tasks + live status; `limit` / `offset` paging; `[OVERDUE]` / `[scheduled]` markers |
| `ghost_task_result` | One task's thread, including Mr.Ghosty's result (plus Due/Scheduled lines when set) |
| `ghost_reply` | Answer a task (e.g. approve a `needs-approval` hold) — clears the hold, task resumes next pickup |
| `ghost_cancel_task` | Cancel a queued/waiting task from Antigravity |
| `ghost_new_results` | Tasks with activity since your last check — each surfaces once |
| `ghost_search_tasks` | Search past/current tasks by keyword — archived tasks included, marked `[archived]` |
| `ghost_capsule` | Read a project's shared capsule (state / decisions / next / session log); auto-creates it |
| `ghost_capsule_update` | Update capsule sections and/or append a session-log line (revision-checked — conflicts are reported, never silently overwritten) |
| `ghost_publish_note` | Send Mr.Ghosty a note (decision, info) — not a task; he folds it into memory + capsules |
| `ghost_board` | The whole queue at a glance: queued / working / waiting on Ryan / done |

Resources: `ghost://profile`, `ghost://projects`, `ghost://rules`
Prompt: `work_like_mrghosty` — briefs the agent to follow Ryan's rules and to
hand off (not fake) work that needs Muse-side access.

Env vars: `GHOST_QUEUE_REPO`, `GITHUB_TOKEN` (or `GHOST_GITHUB_TOKEN`),
`GHOST_HANDOFF_DIR`, `GHOST_CONTEXT_PATH`, `GHOST_GITHUB_API_URL` (testing),
`GHOST_RELAY_URL`, `GHOST_BRIDGE_KEY`, `GHOST_KEY_FILE`, `GHOST_OUTBOX_PATH`
(v4.2 offline outbox, default `~/.ghost-bridge/outbox.json`), `GHOST_STATE_PATH`,
`GHOST_AGENT_NAME` (v4.3: display name announced in presence heartbeats).

## Test it yourself

```bash
cd ghost-bridge-mcp
node test.mjs        # 107 checks: local mode, relay + live context vs a stub
                     # GitHub API in BOTH auth modes (token and a fake gh
                     # binary), duplicate guard, reply/cancel/search/
                     # new-results, update notices, handoff context packs,
                     # capsules, notes, board, the setup script (token + gh
                     # modes, --remove, --pack), resources, prompts, the
                     # v4.2 offline outbox against a dead then real relay,
                     # and the v4.3 pass against a real relay: presence
                     # heartbeats, capsule revision lifecycle + conflict
                     # surfacing, scheduled/overdue handoffs, inbox paging,
                     # archived search
node server.js --http --port 8767   # optional HTTP mode; GET /health, POST /mcp
```

## Honesty notes

- Pickup is polling, not instant: about every 15 minutes. In a hurry? Tell
  Mr.Ghosty in Muse "check the bridge" and he'll run the queue immediately.
- Anyone claiming an MCP "is Muse" without Meta shipping an agent API is
  wrapping a raw model with none of Mr.Ghosty's memory or tools.
- `context.json` contains only public studio info + project statuses.
  No personal data, no prospect lists, no credentials anywhere in this package.
