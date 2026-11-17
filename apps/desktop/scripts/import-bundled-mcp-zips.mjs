#!/usr/bin/env node
/**
 * Unpack MCP zip archives into apps/desktop/resources/mcp/<id>/.
 *
 * Usage:
 *   node apps/desktop/scripts/import-bundled-mcp-zips.mjs \
 *     --channel-ops /path/to/channel-ops-mcp-v5.30.9.zip \
 *     --sangfor /path/to/sangfor-mcp-share-20261111.zip
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.join(__dirname, "..", "resources", "mcp");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel-ops" || a === "--sangfor") {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

async function unpackZip(zipPath, destDir) {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  // Prefer system unzip for nested zip layouts.
  execFileSync("unzip", ["-qo", zipPath, "-d", destDir], { stdio: "inherit" });
}

async function flattenSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const only = path.join(dir, entries[0].name);
  const staging = await mkdtemp(path.join(tmpdir(), "mcp-flat-"));
  for (const name of await readdir(only)) {
    await rename(path.join(only, name), path.join(staging, name));
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of await readdir(staging)) {
    await rename(path.join(staging, name), path.join(dir, name));
  }
  rmSync(staging, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(mcpRoot, { recursive: true });

  if (args["channel-ops"]) {
    const dest = path.join(mcpRoot, "channel-ops");
    console.log(`[import] channel-ops ← ${args["channel-ops"]}`);
    await unpackZip(args["channel-ops"], dest);
    await flattenSingleRoot(dest);
  }
  if (args.sangfor) {
    const dest = path.join(mcpRoot, "sangfor-mcp");
    console.log(`[import] sangfor-mcp ← ${args.sangfor}`);
    await unpackZip(args.sangfor, dest);
    await flattenSingleRoot(dest);
  }

  if (!args["channel-ops"] && !args.sangfor) {
    console.error("Provide --channel-ops and/or --sangfor zip paths.");
    process.exit(1);
  }
  console.log("[import] done. Review resources/mcp/manifest.json entrypoints.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
