# Client configs

Ghost Bridge works with any MCP client. Two connection styles:

- **Local server (stdio)** — the client spawns `mcp/server.js`. Works everywhere, supports every transport the server has (hosted relay, GitHub queue, local files).
- **Hosted relay (remote MCP)** — the client points at the relay's `/mcp` endpoint with an `x-bridge-key` header. Only for clients whose remote-MCP support allows custom headers.

Whichever style you pick, run setup once so your machine gets its own named bridge key (keys never go in the client config in relay mode):

```bash
npx ghost-bridge setup --relay --pack
```

Then verify from inside the client: ask its agent to **call `ghost_bridge_status`** — it should report the hosted relay reachable.

| Client | Config file | Doc |
|---|---|---|
| Google Antigravity | `~/.gemini/config/mcp_config.json` | [antigravity.md](antigravity.md) |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) | [cursor.md](cursor.md) |
| Claude Code | `.mcp.json` (project) or `claude mcp add` | [claude-code.md](claude-code.md) |
| Codex | `~/.codex/config.toml` | [codex.md](codex.md) |

Replace `/ABSOLUTE/PATH/ghost-bridge` and `https://YOUR-RELAY.example.com` with your real values everywhere below.
