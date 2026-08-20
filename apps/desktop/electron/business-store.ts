/**
 * 业务数据存储（共享层）。
 *
 * business-runtime.ts 的工具和 IPC handler（给 renderer 状态面板用）都读这里。
 * 数据模型：实体是 Markdown 文件（front-matter + body），存在 wiki/<type>/ 下。
 *
 * 路径解析（迁移过渡期）：
 *   新路径 workbench/wiki/<type>/   （wiki 统一架构，目标）
 *   旧路径 workbench/<type>/        （迁移前，向后兼容）
 * entityDir 优先用新路径，不存在则回退旧路径。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** 默认实体类型（固定 + 常见动态类型）。实际可用类型通过 listEntityTypes 动态发现。 */
export const DEFAULT_ENTITY_TYPES = ["okr", "todos", "maintenance", "ka", "projects", "cases"] as const;
/** @deprecated 用 DEFAULT_ENTITY_TYPES 代替（保留向后兼容） */
export const ENTITY_TYPES = DEFAULT_ENTITY_TYPES;

export interface EntityData {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function workbenchDir(cwd: string): string {
  return path.join(cwd, "workbench");
}

/**
 * 路径安全防护：实体 type/id、wiki category/relPath 等来自模型/IPC 的
 * 不可信输入，禁止绝对路径与 .. 逃逸（见安全审核 F-08/F-31）。
 */
export function safeRelPath(seg: string, label = "路径"): string {
  if (typeof seg !== "string" || !seg || seg.includes("\u0000")) {
    throw new Error(`非法${label}: ${seg}`);
  }
  const normalized = path.normalize(seg).replace(/\\/g, "/");
  if (path.isAbsolute(seg) || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`${label}不允许逃逸工作区: ${seg}`);
  }
  return normalized;
}

/** 解析 rel 到 root 内并断言不越界，返回绝对路径 */
export function resolveInside(root: string, rel: string): string {
  const absRoot = path.resolve(root);
  const full = path.resolve(root, rel);
  if (full !== absRoot && !full.startsWith(absRoot + path.sep)) {
    throw new Error(`路径不在 ${root} 内: ${rel}`);
  }
  return full;
}

/** wiki 根目录（统一知识层） */
export function wikiDir(cwd: string): string {
  return path.join(workbenchDir(cwd), "wiki");
}

/**
 * 特殊类别映射：某些实体类型在 wiki/ 下不是同名子目录。
 * 例如 cases → wiki/knowledge/cases/（知识子目录）。
 */
const WIKI_CATEGORY_MAP: Record<string, string> = {
  cases: "knowledge/cases",
  concepts: "knowledge/concepts",
  synthesis: "knowledge/synthesis",
};

/** 始终返回新路径 workbench/wiki/<type>/（不管是否存在） */
export function wikiCategoryDir(cwd: string, type: string): string {
  const mapped = WIKI_CATEGORY_MAP[type] ?? type;
  return path.join(wikiDir(cwd), safeRelPath(mapped, "实体类型"));
}

/** 旧路径 workbench/<type>/（迁移前用） */
function legacyEntityDir(cwd: string, type: string): string {
  return path.join(workbenchDir(cwd), type);
}

/**
 * 智能解析实体目录：wiki 路径存在则用新路径，否则回退旧路径。
 * 迁移完成后只有 wiki 路径存在。
 */
export function entityDir(cwd: string, type: string): string {
  const wikiPath = wikiCategoryDir(cwd, type);
  if (existsSync(wikiPath)) return wikiPath;
  const legacyPath = legacyEntityDir(cwd, type);
  if (existsSync(legacyPath)) return legacyPath;
  // 都不存在 → 默认新路径（创建时用新路径）
  return wikiPath;
}

export function entityFile(cwd: string, type: string, id: string): string {
  return path.join(entityDir(cwd, type), `${safeRelPath(id, "实体 id")}.md`);
}

/**
 * 动态发现可用的实体类型：扫描 wiki/ 目录 + 旧路径目录，合并去重。
 * 这样自定义类型（如 visits/proposals）也能被发现。
 */
export function listEntityTypes(cwd: string): string[] {
  const types = new Set<string>(DEFAULT_ENTITY_TYPES as readonly string[]);
  const wiki = wikiDir(cwd);
  if (existsSync(wiki)) {
    for (const name of readdirSync(wiki, { withFileTypes: true })) {
      if (name.isDirectory() && name.name !== "knowledge" && name.name !== "memory") {
        types.add(name.name);
      }
    }
  }
  // 也扫描旧路径（过渡期）
  const wb = workbenchDir(cwd);
  if (existsSync(wb)) {
    for (const name of readdirSync(wb, { withFileTypes: true })) {
      if (
        name.isDirectory() &&
        !name.name.startsWith("_") &&
        name.name !== "wiki" &&
        name.name !== ".pi"
      ) {
        types.add(name.name);
      }
    }
  }
  return [...types];
}

export function parseEntity(text: string): EntityData {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: text.trim() };
  const fm: Record<string, unknown> = {};
  const lines = m[1]!.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // 块序列：key: 后面跟着若干 "  - item" 行
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      i++;
      continue;
    }
    const key = kvMatch[1]!;
    const rest = kvMatch[2]!.trim();
    // 内联值（标量或内联数组）
    if (rest !== "") {
      fm[key] = parseScalar(rest);
      i++;
      continue;
    }
    // rest 为空 → 检查后续是否是块序列（缩进的 "- xxx"）
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const itemLine = lines[j]!;
      const itemMatch = itemLine.match(/^\s+-\s+(.*)$/);
      if (!itemMatch) break;
      items.push(unquote(itemMatch[1]!.trim()));
      j++;
    }
    fm[key] = items.length > 0 ? items : "";
    i = j;
  }
  return { frontmatter: fm, body: (m[2] ?? "").trim() };
}

/** 解析单个标量值：去引号、推断布尔/数字/数组 */
function parseScalar(raw: string): unknown {
  const s = raw.trim();
  // 内联数组 [a, b, c] 或 [] 或 ["a", "b"]
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((p) => unquote(p.trim()));
  }
  const v = unquote(s);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** 去除首尾引号 + 类型推断（布尔/数字） */
function unquote(s: string): string {
  let v = s;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** 把 frontmatter 序列化为 `---\n...\n---\n` 文本 */
export function stringifyFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined || v === "") {
      lines.push(`${k}:`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
      }
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${v}`);
    } else {
      // 字符串：含特殊字符（冒号/井号/方括号）时加引号
      const str = String(v);
      if (/[:#\[\]{}]/.test(str) || str.includes(", ")) {
        lines.push(`${k}: "${str.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${k}: ${str}`);
      }
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

export function readEntity(cwd: string, type: string, id: string): EntityData | null {
  const file = path.join(entityDir(cwd, type), `${id}.md`);
  if (!existsSync(file)) return null;
  return parseEntity(readFileSync(file, "utf-8"));
}

export function listEntities(cwd: string, type: string): EntityData[] {
  const dir = entityDir(cwd, type);
  if (!existsSync(dir)) return [];
  const out: EntityData[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    out.push(parseEntity(readFileSync(path.join(dir, name), "utf-8")));
  }
  return out;
}

/** 状态面板用的汇总数据（给 renderer） */
export interface BusinessSummary {
  okrs: Array<{ id: string; title: string; progress: number | string; status: string }>;
  maintenance: Array<{ id: string; customer: string; product: string; expireDate: string; status: string; amount: number | string }>;
  todos: Array<{ id: string; title: string; status: string; dueDate?: string }>;
  ka: Array<{ id: string; name: string; tier: string; status: string }>;
  projects: Array<{ id: string; title: string; status: string }>;
}

/** 读取汇总（供 IPC handler 调用）— 保留向后兼容 */
export function getBusinessSummary(cwd: string): BusinessSummary {
  return {
    okrs: listEntities(cwd, "okr").map((e) => ({
      id: String(e.frontmatter.id ?? e.frontmatter.title ?? ""),
      title: String(e.frontmatter.title ?? ""),
      progress: typeof e.frontmatter.progress === "number" ? e.frontmatter.progress : String(e.frontmatter.progress ?? "—"),
      status: String(e.frontmatter.status ?? ""),
    })),
    maintenance: listEntities(cwd, "maintenance").map((e) => ({
      id: String(e.frontmatter.id ?? ""),
      customer: String(e.frontmatter.customer ?? e.frontmatter.title ?? ""),
      product: String(e.frontmatter.product ?? ""),
      expireDate: String(e.frontmatter.expireDate ?? e.frontmatter.expire ?? ""),
      status: String(e.frontmatter.status ?? ""),
      amount: typeof e.frontmatter.amount === "number" ? e.frontmatter.amount : String(e.frontmatter.amount ?? 0),
    })),
    todos: listEntities(cwd, "todos").map((e) => ({
      id: String(e.frontmatter.id ?? ""),
      title: String(e.frontmatter.title ?? ""),
      status: String(e.frontmatter.status ?? ""),
      dueDate: e.frontmatter.dueDate as string | undefined,
    })),
    ka: listEntities(cwd, "ka").map((e) => ({
      id: String(e.frontmatter.id ?? ""),
      name: String(e.frontmatter.name ?? e.frontmatter.title ?? ""),
      tier: String(e.frontmatter.tier ?? ""),
      status: String(e.frontmatter.status ?? ""),
    })),
    projects: listEntities(cwd, "projects").map((e) => ({
      id: String(e.frontmatter.id ?? ""),
      title: String(e.frontmatter.title ?? ""),
      status: String(e.frontmatter.status ?? ""),
    })),
  };
}

/**
 * 通用卡片数据查询：按卡片配置动态读取实体数据。
 * 返回 Record<cardId, EntityData[]>。
 */
export function getCardData(cwd: string, cards: Array<{
  id: string;
  entityType: string;
  filter?: Record<string, unknown>;
  sortBy?: string;
  sortDesc?: boolean;
  limit?: number;
}>): Record<string, EntityData[]> {
  const result: Record<string, EntityData[]> = {};
  for (const card of cards) {
    let entities = listEntities(cwd, card.entityType);
    // 过滤
    if (card.filter) {
      entities = entities.filter((e) =>
        Object.entries(card.filter!).every(([k, v]) => e.frontmatter[k] === v),
      );
    }
    // 排序
    if (card.sortBy) {
      entities.sort((a, b) => {
        const av = a.frontmatter[card.sortBy!];
        const bv = b.frontmatter[card.sortBy!];
        if (typeof av === "number" && typeof bv === "number") {
          return card.sortDesc ? bv - av : av - bv;
        }
        const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        return card.sortDesc ? -cmp : cmp;
      });
    }
    // 截断
    if (card.limit && card.limit > 0) {
      entities = entities.slice(0, card.limit);
    }
    result[card.id] = entities;
  }
  return result;
}

