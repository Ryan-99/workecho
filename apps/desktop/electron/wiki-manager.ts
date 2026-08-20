/**
 * Wiki 知识库管理器（统一知识层核心）。
 *
 * 职责：
 * 1. 目录结构创建（wiki/<category>/ + _sources/ + index.md + log.md）
 * 2. index.md 自动维护（按类别统计页面数）
 * 3. log.md append-only 操作日志
 * 4. 交叉引用（[[wikilink]] 语法、双向链接）
 * 5. lint 巡检（孤立页、死链）
 *
 * 路径约定：
 *   workspaceDir (=cwd)
 *     └─ workbench/
 *         ├─ wiki/
 *         │   ├─ okr/  todos/  maintenance/  ka/  projects/
 *         │   ├─ knowledge/  (cases/ concepts/ synthesis/)
 *         │   ├─ memory/
 *         │   ├─ index.md
 *         │   └─ log.md
 *         └─ _sources/  (inbox/ scanned/ web/)
 *
 * 参考 WIKI-DESIGN.md 第二节目录结构。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, renameSync, rmdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { parseEntity, stringifyFrontmatter, wikiCategoryDir, safeRelPath, resolveInside } from "./business-store";

/** workbench 根目录 */
export function workbenchRoot(workspaceDir: string): string {
  return path.join(workspaceDir, "workbench");
}
/** wiki 根目录 */
export function wikiRoot(workspaceDir: string): string {
  return path.join(workbenchRoot(workspaceDir), "wiki");
}
/** _sources 根目录 */
export function sourcesRoot(workspaceDir: string): string {
  return path.join(workbenchRoot(workspaceDir), "_sources");
}

/** 固定 wiki 类别（所有用户都有） */
export const FIXED_CATEGORIES = ["okr", "todos"] as const;
/** 默认动态类别（扫描发现或预置） */
export const DEFAULT_DYNAMIC_CATEGORIES = ["maintenance", "ka", "projects"] as const;
/** 知识子目录 */
export const KNOWLEDGE_SUBDIRS = ["cases", "concepts", "synthesis"] as const;

/**
 * 创建 wiki 完整目录结构 + 初始 index.md / log.md（幂等）。
 */
export function ensureWikiStructure(workspaceDir: string): void {
  const wiki = wikiRoot(workspaceDir);
  // 业务类别目录
  for (const cat of [...FIXED_CATEGORIES, ...DEFAULT_DYNAMIC_CATEGORIES]) {
    mkdirSync(path.join(wiki, cat), { recursive: true });
  }
  // 知识子目录
  for (const sub of KNOWLEDGE_SUBDIRS) {
    mkdirSync(path.join(wiki, "knowledge", sub), { recursive: true });
  }
  // 记忆目录
  mkdirSync(path.join(wiki, "memory"), { recursive: true });
  // _sources 目录
  for (const sub of ["inbox", "scanned", "web"]) {
    mkdirSync(path.join(sourcesRoot(workspaceDir), sub), { recursive: true });
  }

  // 初始化 index.md（不存在才写）
  const indexPath = path.join(wiki, "index.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, regenerateIndex(workspaceDir), "utf-8");
  }

  // 初始化 log.md（不存在才写）
  const logPath = path.join(wiki, "log.md");
  if (!existsSync(logPath)) {
    appendToLog(workspaceDir, "init | 知识库初始化完成");
  }
}

/* ============ log.md ============ */

/** 追加一条操作日志（append-only，自动加日期前缀）。
 * "- " 前缀使其成为 Markdown 列表项——逐行渲染不被段落折叠。 */
export function appendToLog(workspaceDir: string, message: string): void {
  const logPath = path.join(wikiRoot(workspaceDir), "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date} ${message}\n`;
  appendFileSync(logPath, line, "utf-8");
}

/** 读取完整日志内容 */
export function readLog(workspaceDir: string): string {
  const logPath = path.join(wikiRoot(workspaceDir), "log.md");
  if (!existsSync(logPath)) return "";
  return readFileSync(logPath, "utf-8");
}

/* ============ index.md ============ */

/** 统计某类别目录下的 .md 文件数 */
export function countPagesInCategory(workspaceDir: string, category: string): number {
  const dir = path.join(wikiRoot(workspaceDir), category);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

/** 统计所有类别 */
function allCategoryCounts(workspaceDir: string): Array<{ category: string; count: number }> {
  const wiki = wikiRoot(workspaceDir);
  const entries: Array<{ category: string; count: number }> = [];
  if (!existsSync(wiki)) return entries;
  for (const name of readdirSync(wiki, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const subPath = path.join(wiki, name.name);
    // 直接类别目录（okr/todos/maintenance...）
    const mdCount = readdirSync(subPath).filter((f) => f.endsWith(".md")).length;
    if (mdCount > 0) entries.push({ category: name.name, count: mdCount });
    // knowledge/ 下的子目录单独统计
    if (name.name === "knowledge") {
      for (const sub of readdirSync(subPath, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const c = readdirSync(path.join(subPath, sub.name)).filter((f) => f.endsWith(".md")).length;
        if (c > 0) entries.push({ category: `knowledge/${sub.name}`, count: c });
      }
    }
  }
  return entries;
}

/** 根据实际页面分布重建 index.md 内容并写回，返回内容 */
/** 精炼区块标记：标记之间的内容由 LLM/导入维护，regenerateIndex 不覆盖 */
const CURATED_START = "<!-- curated-index-start -->";
const CURATED_END = "<!-- curated-index-end -->";

export function regenerateIndex(workspaceDir: string): string {
  const counts = allCategoryCounts(workspaceDir);
  const lines: string[] = ["# 知识目录", ""];

  // 保留已存在的精炼区块（旧库导入/LLM 精炼的主题化目录）
  const existing = readIndex(workspaceDir);
  const curatedMatch = existing.match(new RegExp(`${CURATED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)${CURATED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (curatedMatch?.[1]) {
    lines.push(CURATED_START, curatedMatch[1].trim(), CURATED_END, "");
  }

  const fixed = counts.filter((c) => (FIXED_CATEGORIES as readonly string[]).includes(c.category));
  const dynamic = counts.filter(
    (c) => !(FIXED_CATEGORIES as readonly string[]).includes(c.category) && !c.category.startsWith("knowledge/"),
  );
  const knowledge = counts.filter((c) => c.category.startsWith("knowledge/"));

  lines.push("## 固定类型");
  if (fixed.length === 0) lines.push("（暂无）");
  for (const c of fixed) lines.push(`- ${c.category}/ (${c.count} 条)`);

  lines.push("", "## 动态类型");
  if (dynamic.length === 0) lines.push("（暂无，后续自动发现或用户创建）");
  for (const c of dynamic) lines.push(`- ${c.category}/ (${c.count} 条)`);

  if (knowledge.length > 0) {
    lines.push("", "## 知识");
    for (const c of knowledge) lines.push(`- ${c.category}/ (${c.count} 条)`);
  }

  const content = lines.join("\n") + "\n";
  writeFileSync(path.join(wikiRoot(workspaceDir), "index.md"), content, "utf-8");
  return content;
}

/** 读取 index.md 内容 */
export function readIndex(workspaceDir: string): string {
  const p = path.join(wikiRoot(workspaceDir), "index.md");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8");
}

/* ============ 交叉引用 ============ */

/** 从正文中提取所有 [[wikilink]] 引用标题 */
export function extractLinks(body: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) links.push(m[1].trim());
  }
  return links;
}

/** 从整个 markdown（frontmatter + body）中提取所有引用（含 related 字段） */
function extractAllLinks(text: string): string[] {
  const links = extractLinks(text);
  // related 字段里的引用也可能是 "[[xxx]]" 格式，extractLinks 已覆盖
  return links;
}

/**
 * 给源页面添加到目标标题的交叉引用。
 * 在源页 frontmatter 的 related 数组里加 "[[targetTitle]]"（去重）。
 * @param sourceRelPath 相对 wiki/ 的路径，如 "todos/follow.md"
 * @returns 是否成功修改
 */
export function addCrossReference(
  workspaceDir: string,
  sourceRelPath: string,
  targetTitle: string,
): boolean {
  const filePath = resolveInside(wikiRoot(workspaceDir), safeRelPath(sourceRelPath, "页面路径"));
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseEntity(raw);
  const ref = `[[${targetTitle}]]`;
  const related = Array.isArray(frontmatter.related) ? [...(frontmatter.related as string[])] : [];
  if (related.includes(ref)) return true; // 已存在
  related.push(ref);
  frontmatter.related = related;
  frontmatter.updated = new Date().toISOString().slice(0, 10);
  const newText = stringifyFrontmatter(frontmatter) + "\n" + body + "\n";
  writeFileSync(filePath, newText, "utf-8");
  return true;
}

/* ============ lint 巡检 ============ */

export interface LintReport {
  orphans: string[]; // 孤立页标题（没有任何页面引用它）
  deadLinks: Array<{ page: string; link: string }>; // 死链（引用了不存在的页面）
}

/** 遍历 wiki 所有 .md 页面，返回 { relPath, title, text, links } */
interface WikiPage {
  relPath: string; // 相对 wiki/
  title: string;
  text: string;
  links: string[];
}

function scanAllPages(workspaceDir: string): WikiPage[] {
  const wiki = wikiRoot(workspaceDir);
  if (!existsSync(wiki)) return [];
  const pages: WikiPage[] = [];
  function walk(dir: string, relBase: string) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const childPath = path.join(dir, name.name);
      const childRel = relBase ? `${relBase}/${name.name}` : name.name;
      if (name.isDirectory()) {
        walk(childPath, childRel);
      } else if (name.name.endsWith(".md") && name.name !== "index.md") {
        const text = readFileSync(childPath, "utf-8");
        const { frontmatter } = parseEntity(text);
        const title = String(frontmatter.title ?? path.basename(name.name, ".md"));
        pages.push({ relPath: childRel, title, text, links: extractAllLinks(text) });
      }
    }
  }
  walk(wiki, "");
  return pages;
}

/** 标准化引用：去掉 [[ ]] 和可能的 "type：" 前缀，用于匹配标题 */
function normalizeRef(ref: string): string {
  let s = ref.replace(/^\[\[|\]\]$/g, "").trim();
  // 去掉 "todo：" 这类类型前缀
  const colonIdx = s.indexOf("：");
  if (colonIdx > 0) s = s.slice(colonIdx + 1).trim();
  return s;
}

/**
 * 巡检 wiki：找孤立页（无人引用）和死链（引用了不存在页面）。
 */
export function lintWiki(workspaceDir: string): LintReport {
  const pages = scanAllPages(workspaceDir);
  const allTitles = new Set(pages.map((p) => p.title));

  // 被引用的标题集合
  const referencedTitles = new Set<string>();
  const deadLinks: Array<{ page: string; link: string }> = [];

  for (const page of pages) {
    for (const link of page.links) {
      const normalized = normalizeRef(link);
      referencedTitles.add(normalized);
      referencedTitles.add(link); // 原始形式也记录
      // 如果引用的标题不在所有标题中，且不在 index.md/log.md 中 → 死链
      if (!allTitles.has(normalized) && !allTitles.has(link)) {
        deadLinks.push({ page: page.relPath, link });
      }
    }
  }

  // 孤立页：标题既没有被任何其他页引用
  // （自引用不算，排除 index.md 这种系统页）
  const orphans = pages
    .filter((p) => {
      // related 中引用自己的不算
      const othersRefer = pages.some(
        (o) => o.relPath !== p.relPath && (o.links.some((l) => normalizeRef(l) === p.title || l === p.title)),
      );
      return !othersRefer;
    })
    .map((p) => p.title);

  return { orphans, deadLinks };
}

/* ============ Wiki 页面 CRUD ============ */

export interface CreatePageResult {
  created: boolean;
  relPath: string;   // 相对 wiki/
  fileName: string;
  id: string;
}

/** 生成文件名 slug：中文保留，空格/特殊字符替换为 - */
export function slugify(text: string): string {
  return text
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\s]+/g, "-")
    .slice(0, 60) || `page-${Date.now().toString(36)}`;
}

/**
 * 在 wiki 中创建一个新页面（统一入口）。
 * @param category 类别（okr/todos/maintenance/.../knowledge/cases/memory/...）
 * @param title 页面标题（也是 h1 和 frontmatter.title）
 * @param extraFm 额外 frontmatter 字段
 * @param body 正文
 */
export function createWikiPage(
  workspaceDir: string,
  category: string,
  title: string,
  extraFm: Record<string, unknown> = {},
  body = "",
): CreatePageResult {
  const wiki = wikiRoot(workspaceDir);
  const dir = resolveInside(wiki, safeRelPath(category, "wiki 分类"));
  mkdirSync(dir, { recursive: true });

  const fileName = `${slugify(title)}.md`;
  const fullPath = path.join(dir, fileName);
  const relPath = `${category}/${fileName}`;
  const id = extraFm.id as string ?? `${category.replace(/\//g, "-")}-${Date.now().toString(36)}`;
  const today = new Date().toISOString().slice(0, 10);

  const fm: Record<string, unknown> = {
    id,
    title,
    type: extraFm.type ?? "entity",
    category: extraFm.category ?? category,
    created: today,
    updated: today,
    ...extraFm,
  };
  // 确保 id/title/type/category 不被 extraFm 覆盖关键值
  fm.id = id;
  fm.title = title;
  if (!fm.type) fm.type = "entity";

  const content = stringifyFrontmatter(fm) + (body ? `\n${body}\n` : "\n");
  writeFileSync(fullPath, content, "utf-8");

  appendToLog(workspaceDir, `create_page | ${relPath} | ${title}`);
  regenerateIndex(workspaceDir);

  return { created: true, relPath, fileName, id: String(id) };
}

export interface UpdatePageOptions {
  appendBody?: string;        // 追加到 body（不覆写）
  frontmatterUpdates?: Record<string, unknown>;  // 更新 frontmatter 字段
}

/**
 * 更新 wiki 页面（append 模式 + frontmatter 更新）。
 * @param relPath 相对 wiki/ 的路径（如 "todos/task.md"）
 */
export function updateWikiPage(
  workspaceDir: string,
  relPath: string,
  appendBody = "",
  frontmatterUpdates: Record<string, unknown> = {},
): boolean {
  const fullPath = resolveInside(wikiRoot(workspaceDir), safeRelPath(relPath, "页面路径"));
  if (!existsSync(fullPath)) return false;

  const raw = readFileSync(fullPath, "utf-8");
  const { frontmatter, body } = parseEntity(raw);

  const updatedFm = { ...frontmatter, ...frontmatterUpdates, updated: new Date().toISOString().slice(0, 10) };
  let newBody = body;
  if (appendBody) newBody = body ? `${body}\n${appendBody}` : appendBody;

  const content = stringifyFrontmatter(updatedFm) + "\n" + newBody + "\n";
  writeFileSync(fullPath, content, "utf-8");

  appendToLog(workspaceDir, `update_page | ${relPath}`);
  return true;
}

/** 按标题查找页面（全 wiki 搜索） */
export function findPageByTitle(workspaceDir: string, title: string): { relPath: string; frontmatter: Record<string, unknown>; body: string } | null {
  const pages = scanAllPages(workspaceDir);
  const found = pages.find((p) => p.title === title);
  if (!found) return null;
  const { frontmatter, body } = parseEntity(readFileSync(path.join(wikiRoot(workspaceDir), found.relPath), "utf-8"));
  return { relPath: found.relPath, frontmatter, body };
}

/* ============ Memory 系统 ============ */

export interface MemoryBundle {
  userProfile: string;
  workingContext: string;
  insights: string;
}

/** 读取所有记忆页面 */
export function readMemory(workspaceDir: string): MemoryBundle {
  const memDir = path.join(wikiRoot(workspaceDir), "memory");
  const read = (name: string): string => {
    const p = path.join(memDir, name);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  };
  return {
    userProfile: read("user-profile.md"),
    workingContext: read("working-context.md"),
    insights: read("insights.md"),
  };
}

/**
 * 更新记忆页面。如果文件不存在则创建。
 * @param mode "replace" = 完全替换 body，"append" = 追加
 */
export function updateMemory(
  workspaceDir: string,
  pageName: string,
  newBody: string,
  mode: "replace" | "append" = "append",
): boolean {
  // pageName 来自模型/IPC，压成纯文件名防止逃逸 memory/ 目录
  const fileName = path.basename(
    pageName.endsWith(".md") ? pageName : `${pageName}.md`,
  ).replace(/\.md$/, (m) => m); // basename 保留 .md 后缀
  const memDir = path.join(wikiRoot(workspaceDir), "memory");
  mkdirSync(memDir, { recursive: true });
  const fullPath = resolveInside(memDir, safeRelPath(fileName, "memory 页名"));

  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(fullPath)) {
    // 文件不存在 → 创建
    const title = pageName.replace(/\.md$/, "").replace(/-/g, " ");
    const fm: Record<string, unknown> = {
      title,
      type: "memory",
      category: "memory",
      created: today,
      updated: today,
    };
    writeFileSync(fullPath, stringifyFrontmatter(fm) + "\n" + newBody + "\n", "utf-8");
    appendToLog(workspaceDir, `create_memory | memory/${fileName}`);
    return true;
  }

  const raw = readFileSync(fullPath, "utf-8");
  const { frontmatter, body } = parseEntity(raw);
  const updatedFm = { ...frontmatter, updated: today };
  const finalBody = mode === "replace" ? newBody : body ? `${body}\n${newBody}` : newBody;

  writeFileSync(fullPath, stringifyFrontmatter(updatedFm) + "\n" + finalBody + "\n", "utf-8");
  appendToLog(workspaceDir, `update_memory | memory/${fileName}`);
  return true;
}

/* ============ Goal 子系统（附录 A3） ============ */

export type GoalStatus = "active" | "paused" | "blocked" | "complete";
const VALID_GOAL_STATUSES = new Set<GoalStatus>(["active", "paused", "blocked", "complete"]);

export interface CreateGoalResult {
  relPath: string;
  id: string;
}

/**
 * 创建一个目标页面（type=goal），包含步骤列表。
 * 初始状态 active，currentStep=0。
 */
export function createGoal(
  workspaceDir: string,
  title: string,
  steps: string[],
  extraFm: Record<string, unknown> = {},
): CreateGoalResult {
  const today = new Date().toISOString().slice(0, 10);
  const result = createWikiPage(workspaceDir, "goals", title, {
    ...extraFm,
    type: "goal",
    status: "active" as GoalStatus,
    currentStep: 0,
    steps,
    created: today,
    updated: today,
  });

  // 生成步骤 checklist body
  const checklist = steps.map((s, i) => `- [${i === 0 ? " " : " "}] ${s}`).join("\n");
  const body = `# 目标：${title}\n\n## 进展\n${checklist}\n\n## 上下文\n（Agent 自动维护）\n`;
  updateWikiPage(workspaceDir, result.relPath, body);

  appendToLog(workspaceDir, `create_goal | ${result.relPath} | ${title}`);
  return { relPath: result.relPath, id: result.id };
}

/**
 * 推进目标：标记当前步骤完成，currentStep+1。
 * 如果 currentStep 超过最后一步 → status=complete。
 */
export function advanceGoal(workspaceDir: string, relPath: string): boolean {
  const fullPath = path.join(wikiRoot(workspaceDir), relPath);
  if (!existsSync(fullPath)) return false;
  const { frontmatter } = parseEntity(readFileSync(fullPath, "utf-8"));
  if (frontmatter.type !== "goal") return false;

  const steps = Array.isArray(frontmatter.steps) ? (frontmatter.steps as string[]) : [];
  const current = typeof frontmatter.currentStep === "number" ? frontmatter.currentStep : 0;
  const next = current + 1;
  const isComplete = next >= steps.length;

  const updates: Record<string, unknown> = {
    currentStep: isComplete ? steps.length : next,
    updated: new Date().toISOString().slice(0, 10),
  };
  if (isComplete) updates.status = "complete" as GoalStatus;

  // 重建 checklist body
  const checklist = steps.map((s, i) => `- [${i < (isComplete ? steps.length : next) ? "x" : " "}] ${s}`).join("\n");
  updateWikiPage(workspaceDir, relPath, `## 进展\n${checklist}\n`, updates);

  appendToLog(workspaceDir, `advance_goal | ${relPath} | step ${next}/${steps.length}${isComplete ? " COMPLETE" : ""}`);
  return true;
}

/**
 * 改变目标状态（active/paused/blocked/complete）。
 */
export function updateGoalStatus(workspaceDir: string, relPath: string, status: GoalStatus): boolean {
  if (!VALID_GOAL_STATUSES.has(status)) return false;
  const fullPath = path.join(wikiRoot(workspaceDir), relPath);
  if (!existsSync(fullPath)) return false;
  const { frontmatter } = parseEntity(readFileSync(fullPath, "utf-8"));
  if (frontmatter.type !== "goal") return false;

  updateWikiPage(workspaceDir, relPath, "", { status, updated: new Date().toISOString().slice(0, 10) });
  appendToLog(workspaceDir, `goal_status | ${relPath} | ${status}`);
  return true;
}

export interface ActiveGoal {
  relPath: string;
  title: string;
  status: string;
  currentStep: number;
  steps: string[];
}

/**
 * 获取所有活动目标（status=active 或 blocked）。
 * 会话启动时调用以恢复"上次做到哪了"。
 */
export function getActiveGoals(workspaceDir: string): ActiveGoal[] {
  const pages = scanAllPages(workspaceDir);
  const goals: ActiveGoal[] = [];
  for (const p of pages) {
    if (p.title === undefined) continue;
    const raw = readFileSync(path.join(wikiRoot(workspaceDir), p.relPath), "utf-8");
    const { frontmatter } = parseEntity(raw);
    if (frontmatter.type !== "goal") continue;
    const status = String(frontmatter.status ?? "");
    if (status !== "active" && status !== "blocked") continue;
    goals.push({
      relPath: p.relPath,
      title: String(frontmatter.title ?? p.title),
      status,
      currentStep: typeof frontmatter.currentStep === "number" ? frontmatter.currentStep : 0,
      steps: Array.isArray(frontmatter.steps) ? (frontmatter.steps as string[]) : [],
    });
  }
  return goals;
}

/* ============ 知识摄取（Phase 3） ============ */

/** 分类子类型 */
export type IngestSubcategory = "case" | "method" | "learning" | "tool" | "concept";

/** 关键词规则分类（零成本，不依赖 LLM）。具体类型优先于通用 case。 */
const CLASSIFY_RULES: Array<{ subcategory: IngestSubcategory; wikiSubdir: string; keywords: string[] }> = [
  // 具体/窄类型优先检查
  { subcategory: "method", wikiSubdir: "knowledge/concepts", keywords: ["sop", "流程", "规范", "方法论", "规则", "标准", "procedure", "process", "workflow"] },
  { subcategory: "learning", wikiSubdir: "knowledge/concepts", keywords: ["学习", "教程", "笔记", "培训", "learn", "tutorial", "guide", "how-to"] },
  { subcategory: "tool", wikiSubdir: "knowledge/concepts", keywords: ["工具", "脚本", "tool", "script", "utility", "自动化"] },
  // case 最宽泛，最后检查
  { subcategory: "case", wikiSubdir: "knowledge/cases", keywords: ["故障", "排障", "问题", "案例", "交付", "方案", "处置", "报错", "异常", "case", "bug", "issue", "fault"] },
];

function classifyText(text: string): { subcategory: IngestSubcategory; wikiSubdir: string } {
  const lower = text.slice(0, 3000).toLowerCase();
  for (const r of CLASSIFY_RULES) {
    if (r.keywords.some((k) => lower.includes(k))) {
      return { subcategory: r.subcategory, wikiSubdir: r.wikiSubdir };
    }
  }
  return { subcategory: "concept", wikiSubdir: "knowledge/concepts" };
}

export interface IngestResult {
  relPath: string;
  id: string;
  subcategory: IngestSubcategory;
  summary: string;
  crossRefs: string[]; // 建立的交叉引用目标标题
}

/**
 * 摄取一段文本到 wiki（核心逻辑）。
 * 流程：分类 → 生成摘要 → 写知识页 → 检测相关实体建交叉引用 → 更新 index/log。
 */
export function ingestText(
  workspaceDir: string,
  text: string,
  title: string,
  options: { source?: string; extraFm?: Record<string, unknown>; autoCrossRef?: boolean } = {},
): IngestResult {
  const { subcategory, wikiSubdir } = classifyText(text);
  const summary = text.slice(0, 80).replace(/\n/g, " ").trim() || title;
  const today = new Date().toISOString().slice(0, 10);
  const doCrossRef = options.autoCrossRef !== false; // 默认 true，可被配置关闭

  // 检测文本中提到的已有 wiki 实体，建立交叉引用
  const crossRefs: string[] = [];
  if (doCrossRef) {
    const pages = scanAllPages(workspaceDir);
    for (const p of pages) {
      // 跳过 index/log/memory/goals 等系统页
      if (p.relPath.startsWith("memory/") || p.relPath === "index.md" || p.relPath === "log.md") continue;
      if (!p.title || p.title === title) continue;
      // 匹配策略：精确标题 或 标题的核心部分出现在文本中
      if (text.includes(p.title)) {
        crossRefs.push(p.title);
      } else if (p.title.length >= 4) {
        const core = p.title.replace(/(维保|续费|防火墙|客户|项目|记录|报告|方案)$/u, "");
        if (core.length >= 3 && text.includes(core)) {
          crossRefs.push(p.title);
        }
      }
    }
  }

  const extraFm = options.extraFm ?? {};
  const fm: Record<string, unknown> = {
    ...extraFm,
    type: subcategory === "case" ? "case" : "concept",
    subcategory,
    summary,
    source: options.source ?? "未知来源",
    tags: crossRefs.length > 0 ? crossRefs.slice(0, 5) : [],
    related: crossRefs.length > 0 ? crossRefs.map((t) => `[[${t}]]`) : [],
    confidence: "medium",
    created: today,
    updated: today,
  };

  const result = createWikiPage(workspaceDir, wikiSubdir, title, fm, text);

  // 反向引用：给被引用的实体页也添加 related 指向新知识页
  for (const ref of crossRefs) {
    const targetPage = findPageByTitle(workspaceDir, ref);
    if (targetPage) {
      addCrossReference(workspaceDir, targetPage.relPath, title);
    }
  }

  appendToLog(workspaceDir, `ingest | ${result.relPath} | ${title} | ${subcategory} | refs:${crossRefs.length}`);
  regenerateIndex(workspaceDir);

  return { relPath: result.relPath, id: result.id, subcategory, summary, crossRefs };
}

export interface BatchIngestResult {
  ingested: number;
  results: IngestResult[];
  failed: string[];
}

/**
 * 批量摄取 _sources/inbox/ 下的文件。
 * 支持 .md/.txt（直接读取），其他格式暂用文件名作为文本。
 * 摄取后原文件归档到 _sources/scanned/。
 */
export function ingestDocuments(workspaceDir: string): BatchIngestResult {
  const inboxDir = path.join(sourcesRoot(workspaceDir), "inbox");
  if (!existsSync(inboxDir)) return { ingested: 0, results: [], failed: [] };

  const scannedDir = path.join(sourcesRoot(workspaceDir), "scanned");
  mkdirSync(scannedDir, { recursive: true });

  const results: IngestResult[] = [];
  const failed: string[] = [];

  for (const name of readdirSync(inboxDir)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const full = path.join(inboxDir, name);
    try {
      if (!statSync(full).isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      let text: string;
      if (ext === ".md" || ext === ".txt" || ext === ".log") {
        text = readFileSync(full, "utf-8");
      } else {
        // Office 文件等：用文件名降级（实际提取在异步工具中处理）
        text = name;
      }
      const title = name.replace(/\.[^.]+$/, "");
      const result = ingestText(workspaceDir, text, title, { source: `inbox/${name}` });

      // 归档原文件到 scanned/
      const dest = path.join(scannedDir, name);
      try {
        renameSync(full, dest);
      } catch {
        /* ignore rename failure */
      }

      results.push(result);
    } catch (e) {
      failed.push(name);
      console.warn(`[wiki-ingest] 导入失败 ${name}:`, (e as Error).message);
    }
  }

  return { ingested: results.length, results, failed };
}

export interface DomainSuggestion {
  keyword: string;
  count: number;
  suggestedType: string;
}

/**
 * 扫描 _sources/ 下的文件，统计关键词频次。
 * 频次超过阈值的 → 建议创建动态类型 + 卡片。
 * 用于初始化领域自动发现（WIKI-DESIGN.md 第八节）。
 */
export function discoverDomains(
  workspaceDir: string,
  keywords: string[],
  options: { threshold?: number; suggestedTypeMap?: Record<string, string>; extraDirs?: string[]; extraFiles?: string[] } = {},
): DomainSuggestion[] {
  const threshold = options.threshold ?? 3;
  const MAX_FILES = 500;            // 安全上限：最多读 500 个文件
  const MAX_FILE_SIZE = 64 * 1024;  // 单文件最大 64KB（关键词统计只需开头部分）

  // 收集所有源文件文本（_sources/ + wiki/knowledge/ + 额外文件列表）
  const texts: string[] = [];
  let fileCount = 0;
  function readFileSafe(p: string) {
    if (fileCount >= MAX_FILES) return;
    try {
      if (statSync(p).size > MAX_FILE_SIZE) return;
      texts.push(readFileSync(p, "utf-8"));
      fileCount++;
    } catch { /* ignore */ }
  }
  function collectText(dir: string) {
    if (!existsSync(dir) || fileCount >= MAX_FILES) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (fileCount >= MAX_FILES) return;
      const childPath = path.join(dir, name.name);
      if (name.isDirectory()) {
        collectText(childPath);
      } else if (name.name.endsWith(".md") || name.name.endsWith(".txt")) {
        readFileSafe(childPath);
      }
    }
  }
  collectText(sourcesRoot(workspaceDir));
  collectText(path.join(wikiRoot(workspaceDir), "knowledge"));
  // 优先用明确的文件列表（有界），避免遍历整个盘符
  for (const f of options.extraFiles ?? []) readFileSafe(f);
  for (const d of options.extraDirs ?? []) collectText(d);
  if (texts.length === 0) return [];

  const allText = texts.join("\n");
  const suggestions: DomainSuggestion[] = [];
  for (const kw of keywords) {
    // 统计出现次数
    let count = 0;
    let idx = allText.indexOf(kw);
    while (idx !== -1) {
      count++;
      idx = allText.indexOf(kw, idx + kw.length);
    }
    if (count >= threshold) {
      const suggestedType = options.suggestedTypeMap?.[kw] ?? kw;
      suggestions.push({ keyword: kw, count, suggestedType });
    }
  }

  return suggestions.sort((a, b) => b.count - a.count);
}

/* ============ 知识查询 + 存回（Phase 3b） ============ */

export interface SearchResult {
  relPath: string;
  title: string;
  snippet: string;   // 匹配片段
  score: number;     // 相关度（标题匹配更高）
  frontmatter: Record<string, unknown>;
}

/**
 * 全文搜索 wiki（标题/frontmatter/正文），按相关度排序。
 * 标题匹配 score=10，标签匹配 score=5，正文匹配 score=1。
 */
export function searchWiki(
  workspaceDir: string,
  query: string,
  options: { limit?: number } = {},
): SearchResult[] {
  const limit = options.limit ?? 10;
  const q = query.toLowerCase();
  const pages = scanAllPages(workspaceDir);
  const results: SearchResult[] = [];

  for (const p of pages) {
    if (p.relPath === "index.md" || p.relPath === "log.md") continue;
    let score = 0;
    const titleLower = p.title.toLowerCase();
    const textLower = p.text.toLowerCase();

    // 标题匹配（最高权重）
    if (titleLower.includes(q)) score += 10;
    // 标签匹配
    const tags = Array.isArray((p as any).frontmatter?.tags) ? (p as any).frontmatter.tags : [];
    // 从 text 中解析 frontmatter 检查 tags
    const parsedFm = parseEntity(p.text).frontmatter;
    const fmTags = Array.isArray(parsedFm.tags) ? (parsedFm.tags as string[]) : [];
    if (fmTags.some((t) => String(t).toLowerCase().includes(q))) score += 5;
    // 正文匹配
    if (textLower.includes(q)) score += 1;

    if (score > 0) {
      // 生成 snippet：匹配位置前后各 40 字
      const matchIdx = textLower.indexOf(q);
      let snippet = "";
      if (matchIdx >= 0) {
        const start = Math.max(0, matchIdx - 40);
        snippet = p.text.slice(start, start + 100).replace(/\n/g, " ").trim();
      } else {
        snippet = p.text.slice(0, 80).replace(/\n/g, " ").trim();
      }
      results.push({ relPath: p.relPath, title: p.title, snippet, score, frontmatter: parsedFm });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export interface SynthesisResult {
  relPath: string;
  id: string;
}

/**
 * 把查询/分析产生的洞察存为 synthesis 页（write-back 能力）。
 * @param title 综合分析标题
 * @param content 分析内容
 * @param sources 引用来源标题列表
 */
export function saveSynthesis(
  workspaceDir: string,
  title: string,
  content: string,
  sources: string[] = [],
): SynthesisResult {
  const today = new Date().toISOString().slice(0, 10);
  const fm: Record<string, unknown> = {
    type: "synthesis",
    category: "knowledge/synthesis",
    tags: sources.slice(0, 5),
    related: sources.map((s) => `[[${s}]]`),
    sources,
    confidence: "medium",
    created: today,
    updated: today,
  };
  const result = createWikiPage(workspaceDir, "knowledge/synthesis", title, fm, content);
  appendToLog(workspaceDir, `synthesis | ${result.relPath} | ${title} | sources:${sources.length}`);
  return { relPath: result.relPath, id: result.id };
}

/* ============ Wiki 统计 + 图谱数据（Phase 5） ============ */

export interface WikiStats {
  totalPages: number;
  categories: Record<string, number>;
  crossReferences: number;
  recentUpdates: number; // 最近7天更新的页面数
}

/** 统计 wiki 整体状况 */
/** 页面摘要（知识库浏览页用） */
export interface WikiPageSummary {
  relPath: string;
  title: string;
  category: string;
  updatedAt: string;
}

/** 列出全部 wiki 页面摘要（排除 index.md），按更新时间倒序 */
export function listWikiPages(workspaceDir: string): WikiPageSummary[] {
  return scanAllPages(workspaceDir)
    .map((p) => {
      const m = p.text.match(/^updated:\s*(.+)$/m);
      return {
        relPath: p.relPath,
        title: p.title,
        category: p.relPath.includes("/") ? p.relPath.slice(0, p.relPath.lastIndexOf("/")) : "根目录",
        updatedAt: (m?.[1] ?? "").trim(),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 读取单页内容（浏览页用）。relPath 相对 wiki/ 根，带路径穿越防护。 */
export function readWikiPage(workspaceDir: string, relPath: string): { relPath: string; title: string; content: string } | null {
  const wiki = wikiRoot(workspaceDir);
  if (!relPath.endsWith(".md") || relPath === "index.md") return null;
  const full = path.resolve(wiki, relPath);
  const wikiPrefix = path.resolve(wiki) + path.sep;
  if (!full.startsWith(wikiPrefix)) return null; // 防穿越
  if (!existsSync(full)) return null;
  const text = readFileSync(full, "utf-8");
  const title = text.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? relPath;
  return { relPath, title, content: text };
}

export function getWikiStats(workspaceDir: string): WikiStats {
  const pages = scanAllPages(workspaceDir);
  const categories: Record<string, number> = {};
  let crossReferences = 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const p of pages) {
    // 类别统计
    const cat = p.relPath.split("/")[0] ?? "other";
    categories[cat] = (categories[cat] ?? 0) + 1;
    // 交叉引用数
    crossReferences += p.links.length;
    // 最近更新（通过 frontmatter.updated 判断）
    const { frontmatter } = parseEntity(p.text);
    const updated = String(frontmatter.updated ?? "");
    if (updated) {
      const ts = new Date(updated).getTime();
      if (!isNaN(ts) && ts >= weekAgo) {
        // 在 recentUpdates 统计中计入
      }
    }
  }

  // 最近更新统计
  const recentUpdates = pages.filter((p) => {
    const { frontmatter } = parseEntity(p.text);
    const updated = String(frontmatter.updated ?? "");
    if (!updated) return false;
    const ts = new Date(updated).getTime();
    return !isNaN(ts) && ts >= weekAgo;
  }).length;

  return {
    totalPages: pages.length,
    categories,
    crossReferences,
    recentUpdates,
  };
}

export interface GraphNode {
  id: string;
  title: string;
  category: string;
  relPath: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface WikiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 生成知识图谱数据（节点+边），供 graph view 渲染 */
export function getWikiGraph(workspaceDir: string): WikiGraph {
  const pages = scanAllPages(workspaceDir);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 构建标题→节点ID映射
  const titleToId = new Map<string, string>();
  for (const p of pages) {
    const id = p.relPath;
    nodes.push({ id, title: p.title, category: p.relPath.split("/")[0] ?? "other", relPath: p.relPath });
    titleToId.set(p.title, id);
  }

  // 构建边（交叉引用）
  for (const p of pages) {
    const sourceId = p.relPath;
    for (const link of p.links) {
      const normalized = normalizeRef(link);
      const targetId = titleToId.get(normalized) ?? titleToId.get(link);
      if (targetId && targetId !== sourceId) {
        edges.push({ source: sourceId, target: targetId });
      }
    }
  }

  return { nodes, edges };
}

/* ============ 数据迁移（旧路径 → wiki/） ============ */

export interface MigrationResult {
  migrated: number; // 迁移的文件数
  details: Array<{ from: string; to: string }>;
}

/**
 * 旧路径 → 新路径映射规则（WIKI-DESIGN.md 第十节）。
 * value 为 null 表示直接同名迁移到 wiki/ 下。
 */
const MIGRATION_MAP: Record<string, string | null> = {
  okr: null, // → wiki/okr/
  todos: null, // → wiki/todos/
  maintenance: null, // → wiki/maintenance/
  ka: null, // → wiki/ka/
  projects: null, // → wiki/projects/
  cases: "knowledge/cases", // → wiki/knowledge/cases/
};

/**
 * 把旧路径 workbench/<type>/ 的数据迁移到 workbench/wiki/<...>/。
 * 幂等：目标已有则跳过该文件。
 * 调用前应先 ensureWikiStructure。
 */
export function migrateLegacyData(workspaceDir: string): MigrationResult {
  const wb = workbenchRoot(workspaceDir);
  const details: Array<{ from: string; to: string }> = [];
  let migrated = 0;

  // 1. 业务实体类型迁移
  for (const [type, subPath] of Object.entries(MIGRATION_MAP)) {
    const oldDir = path.join(wb, type);
    if (!existsSync(oldDir)) continue;
    const newDir = subPath ? path.join(wikiRoot(workspaceDir), subPath) : wikiCategoryDir(workspaceDir, type);
    mkdirSync(newDir, { recursive: true });
    for (const file of readdirSync(oldDir)) {
      const oldFile = path.join(oldDir, file);
      const newFile = path.join(newDir, file);
      if (existsSync(newFile)) continue; // 幂等：目标已有则跳过
      renameSync(oldFile, newFile);
      migrated++;
      details.push({ from: `workbench/${type}/${file}`, to: `workbench/wiki/${subPath ?? type}/${file}` });
    }
    // 清理空旧目录
    try {
      if (readdirSync(oldDir).length === 0) {
        removeDirIfEmpty(oldDir);
      }
    } catch { /* ignore */ }
  }

  // 2. _inbox/ → _sources/inbox/
  const inboxOld = path.join(wb, "_inbox");
  if (existsSync(inboxOld)) {
    const inboxNew = path.join(sourcesRoot(workspaceDir), "inbox");
    mkdirSync(inboxNew, { recursive: true });
    for (const file of readdirSync(inboxOld)) {
      const oldFile = path.join(inboxOld, file);
      const newFile = path.join(inboxNew, file);
      if (existsSync(newFile)) continue;
      renameSync(oldFile, newFile);
      migrated++;
      details.push({ from: `workbench/_inbox/${file}`, to: `workbench/_sources/inbox/${file}` });
    }
    removeDirIfEmpty(inboxOld);
  }

  if (migrated > 0) {
    appendToLog(workspaceDir, `migrate | 迁移 ${migrated} 个文件到 wiki/ 结构`);
    regenerateIndex(workspaceDir);
  }

  return { migrated, details };
}

/** 删除空目录（跨平台安全） */
function removeDirIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // 非空或不存在则忽略
  }
}

/* ============ 初始种子数据 ============ */

const today = () => new Date().toISOString().slice(0, 10);

/**
 * 写入初始种子数据：记忆模板 + 示例 OKR/待办（幂等）。
 * 参考 WIKI-DESIGN.md 第四节记忆系统 + 第八节初始化流程。
 */
export function seedWikiDefaults(workspaceDir: string): void {
  const wiki = wikiRoot(workspaceDir);
  let seeded = 0;

  // user-profile.md
  const profilePath = path.join(wiki, "memory", "user-profile.md");
  if (!existsSync(profilePath)) {
    writeFileSync(profilePath, stringifyFrontmatter({
      title: "用户画像",
      type: "memory",
      category: "memory",
      created: today(),
      updated: today(),
    }) + `
# 用户画像

> Agent 跨会话维护的用户认知。对话中发现偏好/习惯时自动更新。

## 基本信息
- 姓名：（待补充）
- 职位：（待补充）
- 沟通风格：（待补充）

## 工作习惯
- （待补充）

## 关键客户
- （待补充）
`, "utf-8");
    seeded++;
  }

  // working-context.md
  const ctxPath = path.join(wiki, "memory", "working-context.md");
  if (!existsSync(ctxPath)) {
    writeFileSync(ctxPath, stringifyFrontmatter({
      title: "当前工作上下文",
      type: "memory",
      category: "memory",
      created: today(),
      updated: today(),
    }) + `
# 当前工作上下文

> 每次会话结束时自动更新。记录正在进行的工作和近期决策。

## 本周重点
- （待补充）

## 待跟进
- （待补充）

## 近期决策
- （待补充）
`, "utf-8");
    seeded++;
  }

  // insights.md
  const insightsPath = path.join(wiki, "memory", "insights.md");
  if (!existsSync(insightsPath)) {
    writeFileSync(insightsPath, stringifyFrontmatter({
      title: "对话洞察",
      type: "memory",
      category: "memory",
      created: today(),
      updated: today(),
    }) + `
# 对话洞察

> 对话中提炼的有价值结论，可跨会话复用。
`, "utf-8");
    seeded++;
  }

  // 示例 OKR
  const okrPath = path.join(wiki, "okr", "example-okr.md");
  if (!existsSync(okrPath)) {
    writeFileSync(okrPath, stringifyFrontmatter({
      id: "example-okr",
      title: "示例：Q3 业务目标（可编辑或删除）",
      type: "entity",
      category: "okr",
      tags: ["示例"],
      progress: 0,
      status: "active",
      owner: "Ryan",
      created: today(),
      updated: today(),
    }) + `
## 关键结果
- KR1: ...
- KR2: ...
`, "utf-8");
    seeded++;
  }

  // 示例待办
  const todoPath = path.join(wiki, "todos", "example-todo.md");
  if (!existsSync(todoPath)) {
    writeFileSync(todoPath, stringifyFrontmatter({
      id: "example-todo",
      title: "示例待办：配置好 Provider 后删除这些示例",
      type: "todo",
      category: "todos",
      tags: ["示例"],
      status: "todo",
      created: today(),
      updated: today(),
    }) + "\n", "utf-8");
    seeded++;
  }

  if (seeded > 0) {
    appendToLog(workspaceDir, `seed | 写入 ${seeded} 个初始页面`);
    regenerateIndex(workspaceDir);
  }
}

/* ============ 旧知识库导入（Karpathy 式精炼库 → 统一 wiki） ============ */

export interface LegacyImportResult {
  imported: number; // 导入的文件数
  details: string[];
}

/** 递归复制目录下的 .md 文件到目标（已存在则跳过，幂等） */
function copyMarkdownTree(srcDir: string, destDir: string, details: string[], prefix: string): number {
  if (!existsSync(srcDir)) return 0;
  let count = 0;
  for (const name of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, name.name);
    const destPath = path.join(destDir, name.name);
    if (name.isDirectory()) {
      count += copyMarkdownTree(srcPath, destPath, details, prefix);
    } else if (name.name.endsWith(".md")) {
      mkdirSync(path.dirname(destPath), { recursive: true });
      if (existsSync(destPath)) continue; // 幂等
      copyFileSync(srcPath, destPath);
      count++;
      details.push(`${prefix}${path.relative(srcDir, srcPath)}`);
    }
  }
  return count;
}

/**
 * 导入旧版 Karpathy 式知识库（如 D:\Workspace\Workspace）到统一 wiki：
 *   wiki/concepts/        → wiki/knowledge/concepts/
 *   wiki/entities/<type>/ → wiki/<type>/（customers 等动态类型，可出卡片）
 *   journals/             → wiki/journals/
 *   pages/                → wiki/pages/
 *   raw/                  → _sources/raw/（不可变源）
 *   wiki/index.md         → 精炼区块并入 index.md（不被 regenerateIndex 覆盖）
 */
export function importLegacyWiki(workspaceDir: string, sourceDir: string): LegacyImportResult {
  const details: string[] = [];
  if (!existsSync(sourceDir)) return { imported: 0, details };
  let imported = 0;
  const wiki = wikiRoot(workspaceDir);

  // 1. 概念页
  imported += copyMarkdownTree(path.join(sourceDir, "wiki", "concepts"), path.join(wiki, "knowledge", "concepts"), details, "concepts/");
  // 2. 实体目录（customers/projects/... → wiki/<type>/）
  const entitiesDir = path.join(sourceDir, "wiki", "entities");
  if (existsSync(entitiesDir)) {
    for (const name of readdirSync(entitiesDir, { withFileTypes: true })) {
      if (name.isDirectory()) {
        imported += copyMarkdownTree(path.join(entitiesDir, name.name), path.join(wiki, name.name), details, `${name.name}/`);
      }
    }
  }
  // 3. 日志 / pages
  imported += copyMarkdownTree(path.join(sourceDir, "journals"), path.join(wiki, "journals"), details, "journals/");
  imported += copyMarkdownTree(path.join(sourceDir, "pages"), path.join(wiki, "pages"), details, "pages/");
  // 4. raw 源（不可变）
  imported += copyMarkdownTree(path.join(sourceDir, "raw"), path.join(workbenchRoot(workspaceDir), "_sources", "raw"), details, "raw/");

  // 5. 旧 index 并入精炼区块
  const legacyIndex = path.join(sourceDir, "wiki", "index.md");
  if (existsSync(legacyIndex)) {
    const legacyText = readFileSync(legacyIndex, "utf-8").trim();
    const existing = readIndex(workspaceDir);
    if (!existing.includes(CURATED_START)) {
      const curated = `${CURATED_START}\n${legacyText}\n${CURATED_END}`;
      // 精炼区块放在标题后
      const newContent = existing
        ? existing.replace(/^# 知识目录\s*\n/, `# 知识目录\n\n${curated}\n`)
        : `# 知识目录\n\n${curated}\n`;
      writeFileSync(path.join(wiki, "index.md"), newContent, "utf-8");
    }
  }

  if (imported > 0) {
    appendToLog(workspaceDir, `legacy_import | 从 ${sourceDir} 导入 ${imported} 个页面`);
    regenerateIndex(workspaceDir);
  }
  return { imported, details };
}
