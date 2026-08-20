/**
 * 知识库服务：收件箱监听 + 文档导入 + 案例搜索。
 *
 * 从原 workbench-app 移植。收件箱（_inbox/）里的新文件会被：
 * 1. 提取文本（目前只支持 .md/.txt，后续可加 docx/pdf）
 * 2. 分类（case/method/learning/tool/ignore）—— 用关键词规则分类（不依赖 LLM，避免每次都调 API）
 * 3. 生成知识条目写入 cases/，原始文件归档到 cases/<category>/
 *
 * 同时提供 search_cases 工具供 AI 检索知识库。
 */
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync, writeFileSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listEntities, type EntityData } from "./business-store";
import { slugify, regenerateIndex, appendToLog } from "./wiki-manager";

/** 扫描支持的文档扩展名 */
const SCAN_EXTS = new Set([".md", ".txt", ".docx", ".pptx", ".xlsx"]);
/** 扫描时跳过的目录名 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".superpowers", ".zcode", "dist", "out", "build",
  "workbench", ".pi", "sessions", ".cache", "__pycache__", ".vscode", ".idea",
  "AppData", "Library", "System32", "Windows", "Program Files", "Program Files (x86)",
  "ProgramData", "$Recycle.Bin", "cache", "Cache", ".npm", ".pnpm-store",
  "bak", "backup", "backups", ".history", ".trash", "Trash",
  // 凭据/密钥目录：即使显式指定 scanDir 也绝不读入（安全审核 KN-1）
  ".ssh", ".aws", ".gnupg", ".gpg", ".azure", ".gcloud", ".kube", ".docker",
  "Wallet", "Keychain", "MSWallet", "Trusted Platform Data",
]);
/** 跳过的路径片段（出现在路径任何位置都跳过） */
const SKIP_PATH_PARTS = [
  "/.git/", "/node_modules/", "/AppData/", "/.cache/", "/__pycache__/",
  // 凭据目录的路径级兜底（大小写不敏感处理见 shouldSkip）
  "/.ssh/", "/.aws/", "/.gnupg/", "/.kube/", "/.docker/",
];

/** 获取用户常用文档目录（桌面/文档/下载），自动适配 Win/Mac/Linux。
 * 注意：不扫盘符根目录——整盘递归会捞进大量备份/缓存垃圾（曾把 logseq 的
 * bak/journals 一口气导入 7000+ 空页）。要扫其他目录让用户通过 scanDir 显式指定。 */
export function getCommonDocDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  for (const d of ["Desktop", "Documents", "Downloads"]) {
    const p = path.join(home, d);
    if (existsSync(p)) dirs.push(p);
  }
  return dirs;
}

/** 路径是否应该跳过（黑名单检查） */
function shouldSkip(fullPath: string, dirName: string): boolean {
  if (SKIP_DIRS.has(dirName)) return true;
  const norm = fullPath.replace(/\\/g, "/");
  return SKIP_PATH_PARTS.some((p) => norm.includes(p));
}

export type Category = "case" | "method" | "learning" | "tool" | "ignore";

export interface ImportResult { id: string; category: Category; title: string; summary: string }

/** 收件箱目录（workbench/_sources/inbox/） */
export function inboxDir(cwd: string): string {
  return path.join(cwd, "workbench", "_sources", "inbox");
}

/** 案例归档目录（workbench/wiki/knowledge/cases/<category>/） */
export function casesCategoryDir(cwd: string, category: string): string {
  return path.join(cwd, "workbench", "wiki", "knowledge", "cases", category);
}

/** 提取文本：.md/.txt 直接读；.docx 用 mammoth；.pptx/.xlsx 用 jszip 读 XML */
function extractText(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".log") {
    return readFileSync(filePath, "utf-8");
  }
  // Office 文件需要异步解析，这里同步降级——实际提取在 importDocument 里异步处理
  return path.basename(filePath);
}

/** 异步提取文本（支持 Office 文件） */
async function extractTextAsync(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".log") {
    return readFileSync(filePath, "utf-8");
  }
  if (ext === ".docx") {
    try {
      const mammoth = await import("mammoth");
      const r = await mammoth.extractRawText({ path: filePath });
      return r.value;
    } catch { return path.basename(filePath); }
  }
  if (ext === ".pptx") {
    try {
      const JSZip = (await import("jszip")).default;
      const buf = readFileSync(filePath);
      const zip = await JSZip.loadAsync(buf);
      const slides = Object.keys(zip.files).filter((n) => /ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
      const texts: string[] = [];
      for (const s of slides) {
        const slideEntry = zip.files[s];
        if (!slideEntry) continue;
        const xml = await slideEntry.async("string");
        const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
        texts.push(matches.map((m) => m.replace(/<\/?a:t>/g, "")).join(" "));
      }
      return texts.join("\n");
    } catch { return path.basename(filePath); }
  }
  if (ext === ".xlsx") {
    try {
      const JSZip = (await import("jszip")).default;
      const buf = readFileSync(filePath);
      const zip = await JSZip.loadAsync(buf);
      const sheets = Object.keys(zip.files).filter((n) => /xl\/sharedStrings\.xml$/.test(n));
      const sheetEntry = sheets[0] ? zip.files[sheets[0]] : undefined;
      if (!sheetEntry) return path.basename(filePath);
      const xml = await sheetEntry.async("string");
      const matches = xml.match(/<t[^>]*>([^<]*)<\/t>/g) ?? [];
      return matches.map((m: string) => m.replace(/<[^>]+>/g, "")).join(" ");
    } catch { return path.basename(filePath); }
  }
  return path.basename(filePath);
}

/** 关键词规则分类（不依赖 LLM，零成本） */
function classifyByText(fileName: string, text: string): { category: Category; summary: string } {
  const lower = (fileName + " " + text.slice(0, 2000)).toLowerCase();
  const rules: Array<{ category: Category; keywords: string[] }> = [
    { category: "case", keywords: ["故障", "排障", "问题", "案例", "交付", "方案", "处置", "报错", "异常", "case", "bug", "issue", "fault"] },
    { category: "method", keywords: ["sop", "流程", "规范", "方法论", "规则", "标准", "procedure", "process", "workflow"] },
    { category: "learning", keywords: ["学习", "教程", "笔记", "培训", "learn", "tutorial", "guide", "how-to"] },
    { category: "tool", keywords: ["工具", "脚本", "tool", "script", "utility", "自动化"] },
  ];
  for (const r of rules) {
    if (r.keywords.some((k) => lower.includes(k))) {
      return { category: r.category, summary: text.slice(0, 80).replace(/\n/g, " ").trim() || fileName };
    }
  }
  return { category: "ignore", summary: fileName };
}

/** 分类 → wiki 知识子目录：案例进 cases，方法论/学习/工具进 concepts */
function knowledgeWikiDir(category: Category): string {
  return category === "case" ? "knowledge/cases" : "knowledge/concepts";
}

/** 正文过短判定阈值（字符）：低于此值视为空壳文件（如日志备份占位）跳过 */
const MIN_CONTENT_CHARS = 50;
/** 单页正文上限（字符），防止巨型文档拖垮 wiki */
const MAX_BODY_CHARS = 64_000;

/**
 * 写一篇知识页（直接写文件，不走 createWikiPage——批量导入时
 * 逐页 regenerateIndex 是 O(n²)，这里由调用方在批次结束后统一重建一次）。
 */
function writeKnowledgePage(
  cwd: string,
  category: Category,
  title: string,
  extra: { id: string; source: string; summary: string },
  body: string,
): string {
  const rel = knowledgeWikiDir(category);
  const dir = path.join(cwd, "workbench", "wiki", rel);
  mkdirSync(dir, { recursive: true });
  let fileName = `${slugify(title)}.md`;
  if (existsSync(path.join(dir, fileName))) {
    fileName = `${slugify(title)}-${Math.random().toString(36).slice(2, 6)}.md`;
  }
  const today = new Date().toISOString().slice(0, 10);
  const fm = {
    id: extra.id,
    title,
    type: "knowledge",
    category: rel,
    created: today,
    updated: today,
    source: extra.source,
    summary: extra.summary,
    imported: today,
    // 原料标记：扫描/收件箱导入未经 AI 消化（关键词分类+归档），
    // AI 可后续渐进消化提升为正式知识页（见 AGENTS.md 消化指引）
    quality: "raw",
  };
  const fmText = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  const capped = body.length > MAX_BODY_CHARS
    ? body.slice(0, MAX_BODY_CHARS) + "\n\n…（正文超长，已截断，全文见 source 原文件）"
    : body;
  writeFileSync(path.join(dir, fileName), `---\n${fmText}\n---\n\n# ${title}\n\n${capped}\n`, "utf-8");
  appendToLog(cwd, `create_page | ${rel}/${fileName} | ${title}`);
  return `${rel}/${fileName}`;
}

/** 收集 wiki 里所有页面的标题（用于按标题去重，只读 frontmatter，代价低） */
export function collectExistingTitles(cwd: string): Set<string> {
  const titles = new Set<string>();
  const wikiRoot = path.join(cwd, "workbench", "wiki");
  if (!existsSync(wikiRoot)) return titles;
  (function walk(dir: string) {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) {
        try {
          const m = readFileSync(full, "utf-8").match(/^title:\s*(.+)$/m);
          if (m?.[1]) titles.add(m[1].trim());
        } catch { /* 单文件读取失败忽略 */ }
      }
    }
  })(wikiRoot);
  return titles;
}

/** 导入单个文档（收件箱流程：归档原文件 + 写知识页） */
export async function importDocument(cwd: string, srcPath: string): Promise<ImportResult> {
  const text = await extractTextAsync(srcPath);
  const fileName = path.basename(srcPath);
  const trimmed = text.trim();
  const { category, summary } = classifyByText(fileName, text);
  const title = fileName.replace(/\.[^.]+$/, "");
  const id = `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // 收件箱是用户主动投放，即使分类 ignore / 内容短也导入（保留原文件归档）
  const effectiveCategory: Category = category === "ignore" ? "learning" : category;
  writeKnowledgePage(cwd, effectiveCategory, title, { id, source: srcPath, summary }, trimmed || fileName);

  // 归档原始文件到 cases/<category>/
  const targetDir = casesCategoryDir(cwd, category);
  mkdirSync(targetDir, { recursive: true });
  try { renameSync(srcPath, path.join(targetDir, fileName)); } catch { /* 归档失败不影响导入 */ }
  regenerateIndex(cwd);

  return { id, category: effectiveCategory, title, summary };
}

/** 处理收件箱所有文件 */
export async function processInbox(cwd: string): Promise<{ total: number; results: ImportResult[] }> {
  const dir = inboxDir(cwd);
  if (!existsSync(dir)) return { total: 0, results: [] };
  const results: ImportResult[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    try {
      if (statSync(full).isFile()) {
        results.push(await importDocument(cwd, full));
      }
    } catch (e) {
      console.warn(`[knowledge] 导入失败 ${name}:`, (e as Error).message);
    }
  }
  return { total: results.length, results };
}

/** 搜索知识库（按关键词匹配 title/summary/body） */
export function searchCases(cwd: string, query: string, limit = 10): EntityData[] {
  const all = listEntities(cwd, "cases");
  const q = query.toLowerCase();
  const matched = all.filter((e) => {
    const title = String(e.frontmatter.title ?? "").toLowerCase();
    const summary = String(e.frontmatter.summary ?? "").toLowerCase();
    const category = String(e.frontmatter.category ?? "").toLowerCase();
    return title.includes(q) || summary.includes(q) || category.includes(q) || e.body.toLowerCase().includes(q);
  });
  return matched.slice(0, limit);
}

/** 递归扫描目录下的文档文件（.md/.txt）。maxDepth 限制递归深度（默认 5 层）。
 * maxFiles 限制收集文件总数（防止误入超大目录时灌入几千个文件）。 */
export function scanDocs(rootDir: string, maxDepth = 5, opts: { maxFiles?: number } = {}): string[] {
  const maxFiles = opts.maxFiles ?? 500;
  const out: string[] = [];
  (function walk(dir: string, depth: number) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      if (name.startsWith("~$") || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (shouldSkip(full, name)) continue;
        walk(full, depth + 1);
      } else {
        const ext = path.extname(name).toLowerCase();
        if (SCAN_EXTS.has(ext)) out.push(full);
      }
    }
  })(rootDir, 0);
  return out;
}

/** 预览扫描：只列出文件+预判分类，不导入。让用户/AI 确认范围后再正式导入 */
export interface PreviewResult {
  total: number;
  categories: Record<string, number>;
  samples: Array<{ file: string; category: string; title: string }>;
  scannedDirs: string[];
}

export function previewScan(scanDirs: string[]): PreviewResult {
  const allFiles: Array<{ file: string; category: string; title: string }> = [];
  const categories: Record<string, number> = {};

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;
    const files = scanDocs(dir, 5);
    for (const f of files) {
      const text = extractText(f);
      const fileName = path.basename(f);
      const { category } = classifyByText(fileName, text);
      allFiles.push({ file: f, category, title: fileName.replace(/\.[^.]+$/, "") });
      categories[category] = (categories[category] ?? 0) + 1;
    }
  }

  return {
    total: allFiles.length,
    categories,
    samples: allFiles.slice(0, 30),  // 只返回前 30 个给 AI 看，避免太长
    scannedDirs: scanDirs,
  };
}

/** 正式导入（配合 previewScan 用）：传入确认的文件列表。
 *
 * 质量门槛（修复"导入一堆空页"问题）：
 * - 正文 < 50 字符的空壳文件跳过（skipped.empty）
 * - 分类为 ignore 的跳过（skipped.ignore）
 * - 标题已存在的跳过（skipped.dup，幂等）
 * - 知识页正文写入文档全文（上限 64K 字符），不再只写 80 字 summary
 * - 页面文件名用标题 slug，可读可检索
 */
export interface SkippedStats { dup: number; ignore: number; empty: number }
export interface InitScanResult {
  total: number; ok: number; failed: string[];
  categories: Record<string, number>;
  skipped?: SkippedStats;
}

export async function importFiles(
  cwd: string,
  files: string[],
  opts: { existingTitles?: Set<string> } = {},
): Promise<InitScanResult> {
  let ok = 0;
  const failed: string[] = [];
  const categories: Record<string, number> = {};
  const skipped: SkippedStats = { dup: 0, ignore: 0, empty: 0 };
  const existingTitles = opts.existingTitles ?? collectExistingTitles(cwd);

  for (const f of files) {
    try {
      const text = await extractTextAsync(f);
      const trimmed = text.trim();
      if (trimmed.length < MIN_CONTENT_CHARS) { skipped.empty++; continue; }
      const fileName = path.basename(f);
      const { category, summary } = classifyByText(fileName, text);
      if (category === "ignore") { skipped.ignore++; continue; }
      const title = fileName.replace(/\.[^.]+$/, "");
      if (existingTitles.has(title)) { skipped.dup++; continue; }
      const id = `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      writeKnowledgePage(cwd, category, title, { id, source: f, summary }, trimmed);
      existingTitles.add(title);
      ok++;
      categories[category] = (categories[category] ?? 0) + 1;
    } catch (e) {
      failed.push(`${path.basename(f)}: ${(e as Error).message}`);
    }
  }
  if (ok > 0) regenerateIndex(cwd);
  return { total: files.length, ok, failed, categories, skipped };
}

export async function initScan(cwd: string, scanDir: string): Promise<InitScanResult> {
  if (!existsSync(scanDir)) {
    return { total: 0, ok: 0, failed: [`目录不存在: ${scanDir}`], categories: {} };
  }
  const files = scanDocs(scanDir);
  return importFiles(cwd, files);
}

