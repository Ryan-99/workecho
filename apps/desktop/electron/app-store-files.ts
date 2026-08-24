import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFilePreview } from "../src/ipc";
import { resolveExistingWorkspacePath } from "./workspace-paths";

/** 目录遍历兜底要跳过的目录 */
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "dist", "build"]);

/** git 不可用（非 git 工作区）时的有界目录遍历 */
async function walkFiles(root: string, maxDepth = 4, maxFiles = 500): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), depth + 1, prefix + e.name + "/");
      } else {
        out.push(prefix + e.name);
      }
    }
  };
  await walk(root, 0, "");
  return out;
}

const fileCache = new Map<string, { files: string[]; timestamp: number }>();
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 20;
const MAX_PREVIEW_BYTES = 200 * 1024;

export function listWorkspaceFiles(workspacePath: string, options: { readonly force?: boolean } = {}): Promise<string[]> {
  const cached = fileCache.get(workspacePath);
  if (!options.force && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.files);
  }

  const cacheAnd = (files: string[]): string[] => {
    if (fileCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = fileCache.keys().next().value;
      if (oldest !== undefined) {
        fileCache.delete(oldest);
      }
    }
    fileCache.set(workspacePath, { files, timestamp: Date.now() });
    return files;
  };

  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: workspacePath, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          // 非 git 工作区：目录遍历兜底（跳过 node_modules 等，限深 4 层/500 个）
          void walkFiles(workspacePath).then((files) => resolve(cacheAnd(files)));
          return;
        }
        const files = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort();
        resolve(cacheAnd(files));
      },
    );
  });
}

export async function readWorkspaceFile(workspacePath: string, filePath: string): Promise<WorkspaceFilePreview> {
  const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
  const handle = await open(resolved, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return {
        path: filePath,
        content: "",
        truncated: false,
        binary: true,
        sizeBytes: stats.size,
      };
    }

    const readLength = Math.min(stats.size, MAX_PREVIEW_BYTES + 1);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
    const previewBytes = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES));
    const binary = previewBytes.includes(0);

    return {
      path: filePath,
      content: binary ? "" : new TextDecoder("utf-8", { fatal: false }).decode(previewBytes),
      truncated: bytesRead > MAX_PREVIEW_BYTES || stats.size > MAX_PREVIEW_BYTES,
      binary,
      sizeBytes: stats.size,
    };
  } finally {
    await handle.close();
  }
}
