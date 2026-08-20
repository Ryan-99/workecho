/**
 * Wiki 单元测试的共享辅助函数。
 *
 * 用 node 内置的 node:test + node:assert，配合 --experimental-strip-types
 * 直接 import .ts 源码（无需编译），实现快速 TDD 循环。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 创建一个临时 workspace 目录，结构为 <tmp>/workbench。
 * 返回 workspace 根路径（业务代码的 cwd 参数）。
 */
export function makeTempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "wb-wiki-"));
  return root;
}

/** 清理临时 workspace */
export function cleanupWorkspace(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 在 workspace 下写入一个实体 .md 文件（旧路径或新路径皆可）。
 * relativePath 是相对 workspace 根的路径，例如 "workbench/wiki/todos/x.md"。
 */
export function writeFile(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
  return full;
}

/** 读取 workspace 下相对路径的文件内容 */
export function readFile(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf-8");
}

/** 文件是否存在 */
export function exists(root, relativePath) {
  return existsSync(join(root, relativePath));
}

/** 构造一段 frontmatter + body 的 markdown 文本 */
export function page(frontmatter, body = "") {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((i) => `"${i}"`).join(", ")}]`;
      if (v === null || v === undefined) return `${k}:`;
      return `${k}: ${v}`;
    })
    .join("\n");
  return `---\n${fm}\n---\n${body}\n`;
}
