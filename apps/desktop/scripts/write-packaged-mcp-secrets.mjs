#!/usr/bin/env node
/**
 * Build-time helper: write resources/mcp/secrets.packaged.json from env.
 * Never commit the output file. Used so channel-ops token can ship inside
 * installers without landing in the public git tree.
 *
 *   CHANNEL_OPS_MCP_TOKEN=... CHANNEL_OPS_MCP_URL=... \
 *     node apps/desktop/scripts/write-packaged-mcp-secrets.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, "..", "resources", "mcp", "secrets.packaged.json");

const token = process.env.CHANNEL_OPS_MCP_TOKEN?.trim() ?? "";
const url =
  process.env.CHANNEL_OPS_MCP_URL?.trim() ||
  "https://qdyy.sangforln.cloud:1443/api/mcp/channel-ops";

if (token.length < 24) {
  console.error(
    "[write-packaged-mcp-secrets] CHANNEL_OPS_MCP_TOKEN missing or too short (need ≥24 chars).",
  );
  process.exit(1);
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      CHANNEL_OPS_MCP_TOKEN: token,
      CHANNEL_OPS_MCP_URL: url,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(`[write-packaged-mcp-secrets] wrote ${outPath}`);
