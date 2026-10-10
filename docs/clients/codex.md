# Codex

Codex configures MCP servers in TOML, in `~/.codex/config.toml`.

## Setup

```bash
npx ghost-bridge setup --relay   # registers this machine's key into ~/.ghost-bridge/credentials
```

## Config

```toml
[mcp_servers.ghost-bridge]
command = "node"
args = ["/ABSOLUTE/PATH/ghost-bridge/mcp/server.js"]

[mcp_servers.ghost-bridge.env]
GHOST_RELAY_URL = "https://YOUR-RELAY.example.com"
```

The bridge key stays out of this file: the server reads `~/.ghost-bridge/credentials` (written by setup, mode `0600`).

## Verify

Start Codex and ask it to call `ghost_bridge_status` — expect the hosted relay reachable, 17 `ghost_*` tools available.

## Notes

- Use an absolute path in `args` — Codex does not expand `~` there.
- Everything is shared state on the relay: tasks, capsules, approvals, and the board are identical no matter which client you're looking from.
