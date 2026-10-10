# Contributing to Ghost Bridge

Ghost Bridge is built and maintained by **Ghost Developer Studio** (Ryan Cotten, with Mr.Ghosty). Issues and pull requests are welcome; this guide is short because the codebase is deliberately small.

## Ground rules

- **Zero runtime dependencies.** The MCP server and the relay core run on Node's standard library alone (the Netlify function is the only place a platform SDK appears, and it's injected by the host). PRs that add a runtime dependency will be declined — that's a feature, not an oversight.
- **Branding stays.** Ghost Developer Studio / Mr.Ghosty naming is the product's identity; generic-operator PRs are out of scope. Operator-specific *values* (relay URL, queue repo, context contents) belong in config and examples, never hardcoded.
- **Private data never lands in the tree.** No real `context.json` (template only: `mcp/context.example.json`), no keys, no personal contact details, no production relay URLs. CI runs a private-data scan and will fail the build.
- **Backward compatibility is sacred.** The 17 tool names and their behavior, the REST routes, and v3 single-key configs (auto-migrating to the `primary` named key) must keep working.

## Running the tests

```bash
npm test                    # both suites from the repo root
cd mcp && node test.mjs     # MCP suite (spawns stub GitHub + stub relay servers)
cd relay && node test.mjs   # relay suite (spawns the local server; imports core.mjs for migration checks)
npm run demo                # end-to-end proof against a throwaway local relay
```

Both suites must be fully green before a PR is reviewed. If you add a behavior, add checks for it in the same style (black-box against a spawned server, stub over mocks).

## Layout

- `mcp/server.js` — the local MCP server (CommonJS, stdio + HTTP).
- `mcp/setup.mjs` — one-command client setup (GitHub-queue mode and `--relay` mode).
- `relay/core.mjs` — the whole relay, transport-agnostic: `createHandler(store, env)` → `({method, path, query, headers, bodyText})`. New relay behavior goes here, not in the wrappers.
- `relay/local-server.mjs` — HTTP wrapper for local/Docker (also adds the SSE stream).
- `relay/netlify/functions/relay.mjs` — Netlify wrapper (Blobs store).

## Style

Match the file you're in: plain Node, no build step, comments that explain *why* (especially around consistency and auth). Keep functions transport-agnostic where the existing code is.
