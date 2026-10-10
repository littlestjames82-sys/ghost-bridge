# Cursor

Cursor speaks MCP over stdio with the same `mcpServers` JSON shape as Antigravity. Config locations: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a repo (that project only).

## Setup

First get this machine its own bridge key (one per client keeps revocation clean — name it e.g. `cursor-laptop` when you mint it):

```bash
npx ghost-bridge setup --relay
```

## Config

```json
{
  "mcpServers": {
    "ghost-bridge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/ghost-bridge/mcp/server.js"],
      "env": { "GHOST_RELAY_URL": "https://YOUR-RELAY.example.com" }
    }
  }
}
```

The bridge key is read from `~/.ghost-bridge/credentials` (written by setup) — it does not belong in this file.

Restart Cursor (or toggle the server in Settings → MCP) and confirm `ghost-bridge` shows green with 17 tools.

## Verify

In Cursor chat, ask: *"Call ghost_bridge_status and tell me the queue counts."* Then hand off real work with `ghost_handoff` — include files with the `attachments` argument.

## Notes

- Project-level `.cursor/mcp.json` is committable *only* because it contains no secrets (just the relay URL and a path). Keep the path right per machine, or prefer the global file.
- The Antigravity pack's workflows don't apply here, but the tools behave identically — approval holds, capsules, and the board are all shared state on the relay, so Cursor and Antigravity see the same queue.
