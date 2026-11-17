# Bundled MCP packages

## Present

- `channel-ops/` — from `channel-ops-mcp-v5.30.9.zip` (entry: `server.mjs`)
  - requires `CHANNEL_OPS_MCP_TOKEN` + `CHANNEL_OPS_MCP_URL`
- `sangfor-mcp/` — from `sangfor-mcp-share-20261111.zip` (entry: `server.mjs`)
- companion skill: `../skills/sangfor-support/`

```bash
node apps/desktop/scripts/import-bundled-mcp-zips.mjs \
  --channel-ops /path/to/channel-ops-mcp-v5.30.9.zip \
  --sangfor /path/to/sangfor-mcp-share-20261111.zip
```

## Secrets (public-repo safe)

Do **not** commit live tokens.

- Dev: copy `secrets.local.json.example` → `secrets.local.json` (gitignored, never packaged).
- Installers: build machine runs `node apps/desktop/scripts/write-packaged-mcp-secrets.mjs` to create gitignored `secrets.packaged.json`, which **is** copied into the app package.

```json
{
  "CHANNEL_OPS_MCP_TOKEN": "...",
  "CHANNEL_OPS_MCP_URL": "https://qdyy.sangforln.cloud:1443/api/mcp/channel-ops"
}
```

Or export the same variables in the process environment before launching Workecho.

Startup merges missing server entries into `~/.pi/agent/mcp-servers.json` without overwriting user edits.
