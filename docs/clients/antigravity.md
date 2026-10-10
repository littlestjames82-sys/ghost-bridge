# Google Antigravity

The original Ghost Bridge client — the full toolset plus the Antigravity pack (global rules, `/handoff` + `/bridge-check` + session workflows, and the ghost-bridge skill).

## Easiest: the setup command

```bash
npx ghost-bridge setup --relay --pack
```

It generates this machine's bridge key, registers it with the relay using the pairing code Mr.Ghosty gives you, writes the config entry (with a timestamped backup), and installs the pack into your global `~/.gemini/AGENTS.md`. The key is saved to `~/.ghost-bridge/credentials` — never into the config. Restart Antigravity afterwards.

## Manual config

Antigravity reads `~/.gemini/config/mcp_config.json`:

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

The server finds your key in `~/.ghost-bridge/credentials` on its own.

## Legacy GitHub-queue mode

`node mcp/setup.mjs` (no `--relay`) configures the v1–v2 transport instead: `{"GHOST_QUEUE_REPO": "your-username/your-queue-repo", "GHOST_QUEUE_VIA_GH": "1"}` with a logged-in `gh` CLI, or a fine-grained `GITHUB_TOKEN`. The relay takes priority whenever both are configured.

## Verify

Ask Antigravity's agent: *"Call ghost_bridge_status."* Expect the hosted relay reachable with queue counts. Then try *"Use ghost_handoff to send Mr.Ghosty a task: say hello"*.
