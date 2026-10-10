# Claude Code

Two equivalent ways to register the bridge with Claude Code.

## Setup

```bash
npx ghost-bridge setup --relay   # registers this machine's key, stores it in ~/.ghost-bridge/credentials
```

## Option A — CLI

```bash
claude mcp add ghost-bridge -- node /ABSOLUTE/PATH/ghost-bridge/mcp/server.js
```

Then set the relay URL for the server's environment (edit the entry Claude Code writes, or re-add with `-e`):

```bash
claude mcp add ghost-bridge -e GHOST_RELAY_URL=https://YOUR-RELAY.example.com -- node /ABSOLUTE/PATH/ghost-bridge/mcp/server.js
```

The bridge key is *not* passed here — the server reads `~/.ghost-bridge/credentials` itself.

## Option B — `.mcp.json` (project scope)

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

## Verify

Run `/mcp` in Claude Code — `ghost-bridge` should list 17 tools. Ask it to call `ghost_bridge_status`.

## Notes

- This is the mirror image of how Mr.Ghosty works the same queue from inside Muse: both sides read and write the same relay, so a task handed off from Claude Code lands in exactly the queue Mr.Ghosty is woken for.
