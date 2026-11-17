# Bundled MCP packages

## Present

- `sangfor-mcp/` — from `sangfor-mcp-share-20261111.zip` (entry: `server.mjs`)
- companion skill: `../skills/sangfor-support/`

## Pending

- `channel-ops/` — from `channel-ops-mcp-v5.30.9.zip` (upload still required)

```bash
node apps/desktop/scripts/import-bundled-mcp-zips.mjs \
  --channel-ops /path/to/channel-ops-mcp-v5.30.9.zip \
  --sangfor /path/to/sangfor-mcp-share-20261111.zip
```

## Token (public-repo safe)

`CHANNEL_OPS_MCP_TOKEN` must **not** be committed to this public repository.

Options:

1. Copy `secrets.local.json.example` → `secrets.local.json` (gitignored) and fill the token locally.
2. Or export `CHANNEL_OPS_MCP_TOKEN` in the process environment before launching Workecho.

Startup merges missing server entries into `~/.pi/agent/mcp-servers.json` without overwriting user edits.
