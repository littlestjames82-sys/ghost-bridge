# Security Policy

## Reporting a vulnerability

Email **Ghost Developer Studio** via the contact on the studio's GitHub profile, with "Ghost Bridge security" in the subject. Please do not open a public issue for a vulnerability. We aim to acknowledge reports within a few days; Ghost Bridge is maintained by a one-person studio, best-effort.

## How Ghost Bridge handles secrets

- **Bridge keys are bearer credentials.** The relay stores only a **sha256 hash** of each key — a database leak does not expose usable keys. Keys are never written into MCP client configs by the setup tooling; they live in `~/.ghost-bridge/credentials` (mode `0600`) or your own secret handling.
- **One key per machine/client (v4).** Keys are named, timestamped, and individually revocable (`DELETE /api/keys/:name`). Revoke a key the moment a machine leaves your control; revoking never affects other clients.
- **Scope keys down (v4.1).** Keys are `full` or `readonly`. Anything that only watches — boards, dashboards, event tails — should hold a readonly key: it can read tasks/files/context/events but every write and all key management is refused server-side. Claim leases and per-key rate limits (429 + `Retry-After`, `GHOST_BRIDGE_RATE_PER_MIN`) bound what even a full key can do by accident.
- **The setup secret is a bootstrap gate only.** `BRIDGE_SETUP_SECRET` is required to register the *first* key (`POST /setup`) and — together with a current bridge key — to reset all keys (`POST /setup/reset`). After bootstrap, day-to-day auth is by bridge key alone.
- **Unauthenticated endpoints expose counts only.** `GET /probe` and `GET /health` return queue counts and the version — no titles, bodies, or keys — so wake-hooks can poll cheaply. `GET /metrics` (v4.4) follows the same rule in Prometheus format: `GET /api/digest` is *not* unauthenticated (it names the tasks waiting on the owner), so it requires any valid bridge key, readonly included.
- **Context history is context (v4.4).** `GET /api/context/history[/<n>]` returns earlier published contexts to any key holder, readonly included — treat snapshots with the same care as the live context, and remember a restore via `POST /api/import` restarts history at version 1 rather than carrying snapshots over.
- **The doctor never prints credentials (v4.4).** `ghost-bridge doctor` reports key *presence and scope* only, is fully read-only, and flags (as a WARN) any bridge key it finds sitting in an MCP config file — keys belong in `~/.ghost-bridge/credentials`, not in configs that get pasted into chats.
- **Never put credentials in tasks.** Tasks, comments, capsules, and handoffs are visible to every holder of a bridge key. The tool descriptions say so, and so do we: secrets in a task are secrets shared.
- **Your context is yours.** `context.json` describes the operator and their projects. A filled-in copy must never be committed to a public repo (it is in `.gitignore`); the repo ships a blank `context.example.json` template. The CI privacy scan fails the build if known private markers appear in the tree.
- **Webhooks can be signed (v4.2).** Set `GHOST_BRIDGE_WEBHOOK_SECRET` on the relay and every `GHOST_BRIDGE_WEBHOOK_URL` delivery carries `x-ghost-event` + `x-ghost-signature: sha256=<hmac-sha256 of the raw body>`; verify it on the receiver (`scripts/webhook-verify.mjs`, example `scripts/webhook-receiver.mjs`). With no secret set, deliveries stay unsigned — then keep the receiver behind a secret path. Events are notifications only — the relay remains the store of record.
- **Presence shows identities, never credentials (v4.3).** `GET /api/presence` lists agent key *names*, self-chosen display names, capabilities, status, and last-seen times for agents active within the presence window — nothing else. No hashes, no key material, ever. Because a heartbeat only writes the caller's own record, readonly keys are allowed to heartbeat and read presence; every other write (including archiving) stays full-scope only. If a display name would be sensitive in your setup, don't set one — the key name alone is announced.
- **Backups are sensitive (v4.2).** `GET /api/export` / `scripts/backup.mjs` produce one JSON document with your whole queue: task bodies, comments, files, context — plus key names/scopes/hashes (never plaintext keys; those don't exist server-side). Full-scope keys only. Store backups like credentials (the CLI writes them mode `0600`), and restore only into relays you control.

## Supported versions

Only the latest major (v4.x) receives security fixes.
