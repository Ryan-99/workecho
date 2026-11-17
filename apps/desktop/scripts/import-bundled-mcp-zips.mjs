#!/usr/bin/env node
/**
 * Unpack MCP zip archives into apps/desktop/resources/mcp/<id>/.
 * Uses Python zipfile so Windows backslash paths extract correctly.
 *
 * Usage:
 *   node apps/desktop/scripts/import-bundled-mcp-zips.mjs \
 *     --channel-ops /path/to/channel-ops-mcp-v5.30.9.zip \
 *     --sangfor /path/to/sangfor-mcp-share-20261111.zip
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rename, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.join(__dirname, "..", "resources", "mcp");
const skillsRoot = path.join(__dirname, "..", "resources", "skills");

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

function unpackZipPython(zipPath, destDir) {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const script = `
import zipfile, shutil, os
from pathlib import Path
src = Path(${JSON.stringify(zipPath)})
dest = Path(${JSON.stringify(destDir)})
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        name = info.filename.replace('\\\\', '/').lstrip('/')
        if not name: continue
        if name.startswith('/') or (len(name) > 1 and name[1] == ':'):
            continue
        target = dest / name
        if name.endswith('/'):
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with z.open(info) as srcf, open(target, 'wb') as out:
            shutil.copyfileobj(srcf, out)
        os.chmod(target, 0o644)
`;
  const tmpPy = path.join(tmpdir(), `mcp-unzip-${process.pid}.py`);
  writeFileSync(tmpPy, script);
  try {
    execFileSync("python3", [tmpPy], { stdio: "inherit" });
  } finally {
    rmSync(tmpPy, { force: true });
  }
}

async function flattenSingleRoot(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const only = path.join(dir, entries[0].name);
  const staging = await mkdtemp(path.join(tmpdir(), "mcp-flat-"));
  for (const name of await readdir(only)) {
    await rename(path.join(only, name), path.join(staging, name));
  }
  await rm(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of await readdir(staging)) {
    await rename(path.join(staging, name), path.join(dir, name));
  }
  await rm(staging, { recursive: true, force: true });
}

async function importSangfor(zipPath) {
  const staging = await mkdtemp(path.join(tmpdir(), "sangfor-zip-"));
  try {
    unpackZipPython(zipPath, staging);
    const serverSrc = path.join(staging, "sangfor-mcp");
    const skillSrc = path.join(staging, "skill-sangfor-support");
    if (!existsSync(path.join(serverSrc, "server.mjs"))) {
      throw new Error("sangfor zip missing sangfor-mcp/server.mjs");
    }
    const serverDest = path.join(mcpRoot, "sangfor-mcp");
    rmSync(serverDest, { recursive: true, force: true });
    await cp(serverSrc, serverDest, { recursive: true });
    if (existsSync(path.join(skillSrc, "SKILL.md"))) {
      const skillDest = path.join(skillsRoot, "sangfor-support");
      rmSync(skillDest, { recursive: true, force: true });
      await cp(skillSrc, skillDest, { recursive: true });
      console.log("[import] skill → resources/skills/sangfor-support");
    }
    console.log("[import] sangfor-mcp → resources/mcp/sangfor-mcp");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function importChannelOps(zipPath) {
  const dest = path.join(mcpRoot, "channel-ops");
  unpackZipPython(zipPath, dest);
  await flattenSingleRoot(dest);
  console.log("[import] channel-ops → resources/mcp/channel-ops");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(mcpRoot, { recursive: true });
  mkdirSync(skillsRoot, { recursive: true });

  if (args["channel-ops"]) await importChannelOps(args["channel-ops"]);
  if (args.sangfor) await importSangfor(args.sangfor);

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
