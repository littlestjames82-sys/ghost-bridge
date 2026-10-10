# Events: push wake for watchers

Polling sweeps were v3's wake-up: check the queue every few minutes, do nothing most of the time. v4 adds an **event log** on the relay. Every mutation appends an event:

| Type | When |
|---|---|
| `task.created` | a task or note is filed (REST or hosted MCP) |
| `task.comment` | a comment lands on a task |
| `task.status` | a task's status changes (claim, approval hold, done, cancelled) |
| `key.registered` / `key.revoked` | a named key is minted or revoked |

Event shape: `{seq, type, at, taskId?, title?, status?, …}`. `seq` is a monotonic cursor — remember the last one you saw.

**Retention (v4.1):** the log keeps only the newest `GHOST_BRIDGE_EVENT_CAP` events (default 500). A watcher that falls behind the cap simply misses the trimmed middle — re-sync from the task list (`ghost_inbox` / `GET /api/tasks`) if your cursor returns nothing for a long while. `task.status` events for claims also carry `claimedBy` + `claimExpiresAt` when a lease is set.

## Option 1 — Long-poll (works everywhere, including Netlify)

```
GET /api/events?since=<lastSeq>&wait=20     (x-bridge-key header required)
→ { "events": [ … ], "lastSeq": 42 }
```

`wait` (seconds, max 25) makes the relay hold the request until at least one event lands or the window expires — near-instant wake with zero held connections, which is why it survives serverless. `since` also accepts an ISO timestamp.

Ready-made watcher: [`scripts/watch.mjs`](../scripts/watch.mjs) (`npm run watch`, or `ghost-bridge watch`) — prints each event and keeps its cursor across reconnects.

## Option 2 — SSE stream (local / Docker relays)

```
GET /api/events/stream?since=<seq>          (x-bridge-key header, or ?key= as a fallback)
Content-Type: text/event-stream
```

Each event arrives as `event: <type>\ndata: <json>`. Netlify Functions cannot hold a response open, so this endpoint only exists on the Node local server — on Netlify, use long-poll or the webhook. `scripts/watch.mjs --stream` is a complete consuming client (~40 lines: fetch, read chunks, split on blank lines, parse `data:`).

## Option 3 — Outbound webhook (signed, v4.2)

Set `GHOST_BRIDGE_WEBHOOK_URL` in the relay's environment and every event is also POSTed to that URL as JSON. Delivery is best-effort with a 3 s timeout and **never blocks or fails the request that caused the event** — the event log remains the store of record, so a missed webhook is recoverable by long-polling from your last `seq`.

**Signing:** also set `GHOST_BRIDGE_WEBHOOK_SECRET` on the relay and every delivery carries two extra headers:

```
x-ghost-event:     task.created
x-ghost-signature: sha256=<hmac-sha256 hex of the raw request body, keyed with the secret>
```

Verify on the receiver before trusting anything. A ready-made helper ships in [`scripts/webhook-verify.mjs`](../scripts/webhook-verify.mjs), and [`scripts/webhook-receiver.mjs`](../scripts/webhook-receiver.mjs) is a complete verified receiver you can run as-is:

```js
import { verifyGhostSignature } from './webhook-verify.mjs';

// Collect the RAW body (string or Buffer) — never a re-stringified parse.
const ok = verifyGhostSignature(rawBody, req.headers['x-ghost-signature'], process.env.GHOST_BRIDGE_WEBHOOK_SECRET);
if (!ok) { res.writeHead(401); return res.end('bad signature'); }
```

With no secret set on the relay, deliveries are sent unsigned (v4.0 behavior) and the helper returns `false` — in that mode, put the receiver behind a secret path and treat events as hints, not proof. Either way: respond 2xx fast, do the real work async, verify the shape (`type` + `seq`), and remember the bridge's own rule: consequential work still goes through the `needs-approval` gate, webhook or not.
