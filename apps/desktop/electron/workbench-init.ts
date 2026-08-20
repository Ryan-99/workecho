/**
 * 首次启动初始化。
 *
 * 安装后第一次打开时：
 * 1. 在 userData 下创建默认 workspace 目录（Workbench/）
 * 2. 初始化统一 Wiki 知识库结构（wiki/<category>/ + _sources/ + memory/）
 * 3. 迁移旧路径数据（workbench/<type>/ → workbench/wiki/<type>/）
 * 4. 写入示例数据 + 记忆模板
 *
 * 这个目录路径会作为 initialWorkspacePath 传给 DesktopAppStore，
 * 这样首次启动就有一个 workspace 可用，不用用户手动选文件夹。
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importFiles, getCommonDocDirs, scanDocs, collectExistingTitles, type SkippedStats } from "./knowledge-service";
import { ensureWikiStructure, migrateLegacyData, seedWikiDefaults, discoverDomains, regenerateIndex, appendToLog, importLegacyWiki, type DomainSuggestion } from "./wiki-manager";
import { ensureScheduleFile } from "./schedule-service";
import { getActiveWikiConfig } from "./wiki-config";
import { ensureHooksFile } from "./hooks-service";

const INIT_SCAN_SENTINEL = ".init-scan-done";

/**
 * 确保默认 workspace 存在并初始化 wiki 知识库结构。
 * 返回 workspace 的绝对路径（供 DesktopAppStore 用作 initialWorkspacePath）。
 * 幂等：已存在则跳过创建。
 *
 * userDataDir: Electron userData 目录。workspace 建在 userData/Workbench 下。
 */
export function ensureDefaultWorkspace(userDataDir: string): string {
  const workspaceDir = path.join(userDataDir, "Workbench");
  initWorkspaceDir(workspaceDir);
  return workspaceDir;
}

/**
 * 在指定目录初始化 wiki 知识库结构（幂等）。
 *
 * 流程：
 * 1. ensureWikiStructure — 创建 wiki/ 目录树 + index.md + log.md
 * 2. migrateLegacyData — 旧路径数据迁移到 wiki/（如有）
 * 3. seedWikiDefaults — 示例数据 + 记忆模板
 *
 * workspaceDir 本身就是 workspace 根目录（不是 userData）。
 */
export function initWorkspaceDir(workspaceDir: string): void {
  // Wiki 统一架构初始化（所有操作幂等，每次启动安全运行）
  ensureWikiStructure(workspaceDir);
  migrateLegacyData(workspaceDir);
  seedWikiDefaults(workspaceDir);
  ensureScheduleFile(workspaceDir);

  // sentinel 仅标记"首次初始化已完成"（供其他逻辑判断，如是否弹引导）
  const sentinel = path.join(workspaceDir, ".workbench-initialized");
  if (!existsSync(sentinel)) {
    writeFileSync(sentinel, new Date().toISOString(), "utf-8");
    console.log(`[workbench-init] 工作区初始化完成: ${workspaceDir}`);
  }
}

/**
 * 初始化文档扫描：自动扫描用户电脑常用目录（桌面/文档 + 额外目录），
 * 把 .md/.txt 文档分类后全量导入知识库。
 *
 * 幂等：有 .init-scan-done 标记则跳过。
 * 异步执行（不阻塞 app 启动），过程中打 progress 日志。
 */
export async function runInitScan(workspaceDir: string): Promise<{ total: number; ok: number; categories: Record<string, number> }> {
  const sentinel = path.join(workspaceDir, INIT_SCAN_SENTINEL);

  if (existsSync(sentinel)) {
    console.log("[init-scan] 已扫描过，跳过");
    return { total: 0, ok: 0, categories: {} };
  }

  const dirs = getCommonDocDirs();
  console.log(`[init-scan] 开始扫描: ${dirs.join(", ")}`);

  // 收集所有文件
  const allFiles: string[] = [];
  for (const d of dirs) {
    const files = scanDocs(d, 5);
    allFiles.push(...files);
    console.log(`[init-scan] ${d}: 找到 ${files.length} 个文档`);
  }

  if (allFiles.length === 0) {
    console.log("[init-scan] 没有找到文档，跳过");
    writeFileSync(sentinel, new Date().toISOString(), "utf-8");
    return { total: 0, ok: 0, categories: {} };
  }

  // 导入（关键词分类，零 token 成本）
  console.log(`[init-scan] 开始导入 ${allFiles.length} 篇文档...`);
  const result = await importFiles(workspaceDir, allFiles);
  const catLine = Object.entries(result.categories).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`[init-scan] 完成：导入 ${result.ok}/${result.total} 篇 [${catLine}]`);

  writeFileSync(sentinel, new Date().toISOString(), "utf-8");
  return { total: result.total, ok: result.ok, categories: result.categories };
}

/* ============ 一键初始化（用户说"帮我初始化工作环境"时触发） ============ */

export interface InitWorkspaceResult {
  wikiReady: boolean;
  /** 扫描导入统计 */
  scanned: { total: number; ok: number; categories: Record<string, number>; skipped?: SkippedStats };
  /** 领域发现建议（高频关键词 → 建议动态类型） */
  domainSuggestions: DomainSuggestion[];
  /** 旧知识库导入统计 */
  legacyImported?: number;
}

/**
 * 一键初始化整个工作环境（含知识库）。全部幂等，可重复执行：
 * 1. wiki 结构 + 数据迁移 + 种子数据（记忆模板/示例）+ schedule + hooks
 * 2. 扫描文档目录 → 导入知识库（wiki/knowledge/，源文件归档 _sources/scanned/）
 * 3. 领域发现（关键词频次统计 → 建议动态类型+卡片）
 * 4. 重建 index.md + 记 log
 *
 * @param options.scanDirs 要扫描的目录（默认用户文档区：桌面/文档/下载+盘符）
 * @param options.doScan   false 时跳过扫描只建结构
 */
export interface InitProgressEvent {
  phase: "structure" | "scan" | "legacy" | "import" | "domains" | "done";
  current: number;
  total: number;
  message?: string;
}

export async function initializeWorkspace(
  workspaceDir: string,
  options: { scanDirs?: string[]; doScan?: boolean; signal?: AbortSignal; onProgress?: (e: InitProgressEvent) => void } = {},
): Promise<InitWorkspaceResult> {
  const aborted = () => options.signal?.aborted === true;
  const progress = (phase: InitProgressEvent["phase"], current: number, total: number, message?: string) => {
    try { options.onProgress?.({ phase, current, total, message }); } catch { /* 进度回调失败不影响初始化 */ }
  };

  // 1. 结构 + 种子 + 定时 + hooks（全部幂等）
  progress("structure", 0, 5, "创建 Wiki 结构");
  ensureWikiStructure(workspaceDir);
  progress("structure", 1, 5, "数据迁移");
  migrateLegacyData(workspaceDir);
  progress("structure", 2, 5, "种子数据");
  seedWikiDefaults(workspaceDir);
  progress("structure", 3, 5, "定时配置");
  ensureScheduleFile(workspaceDir);
  progress("structure", 4, 5, "Hooks 配置");
  ensureHooksFile(workspaceDir);
  progress("structure", 5, 5, "结构就绪");
  const wikiReady = true;

  // 2. 扫描导入（按标题去重：已有同标题知识页的文件跳过，保证幂等；逐文件处理以支持中止）
  let scanned = { total: 0, ok: 0, categories: {} as Record<string, number>, skipped: { dup: 0, ignore: 0, empty: 0 } as SkippedStats };
  let scannedFiles: string[] = [];
  let wasAborted = false;
  if (options.doScan !== false) {
    const dirs = options.scanDirs ?? getCommonDocDirs();
    for (let di = 0; di < dirs.length; di++) {
      if (aborted()) break;
      try {
        scannedFiles.push(...scanDocs(dirs[di]!, 5));
      } catch { /* 单个目录不可读/不存在：跳过不中断 */ }
      progress("scan", di + 1, dirs.length, "扫描 " + dirs[di]);
    }
    if (scannedFiles.length > 0 && !aborted()) {
      // 全库标题集合：预过滤 + 传给 importFiles 复用（避免逐文件重扫 wiki）
      const existingTitles = collectExistingTitles(workspaceDir);
      const newFiles = scannedFiles.filter((f) => {
        const title = path.basename(f).replace(/\.[^.]+$/, "");
        return !existingTitles.has(title);
      });
      // 预过滤掉的即重复标题（幂等跳过），计入 skipped.dup
      const skipped: SkippedStats = { dup: scannedFiles.length - newFiles.length, ignore: 0, empty: 0 };
      // 逐文件导入：每个文件之间检查中止信号（停止按钮可即时打断）
      let ok = 0;
      const categories: Record<string, number> = {};
      for (let fi = 0; fi < newFiles.length; fi++) {
        if (aborted()) { wasAborted = true; break; }
        try {
          const r = await importFiles(workspaceDir, [newFiles[fi]!], { existingTitles });
          ok += r.ok;
          for (const [k, v] of Object.entries(r.categories)) {
            categories[k] = (categories[k] ?? 0) + v;
          }
          if (r.skipped) {
            skipped.dup += r.skipped.dup;
            skipped.ignore += r.skipped.ignore;
            skipped.empty += r.skipped.empty;
          }
        } catch { /* 单文件失败不中断整体 */ }
        progress("import", fi + 1, newFiles.length, "导入 " + (fi + 1) + "/" + newFiles.length);
      }
      scanned = { total: newFiles.length, ok, categories, skipped };
    }
  }
  if (aborted()) wasAborted = true;

  // 3. 领域发现（阈值默认 3；传扫描到的文件列表而非目录，避免遍历整个盘符）
  let domainSuggestions: DomainSuggestion[] = [];
  try {
    domainSuggestions = discoverDomains(workspaceDir, [
      "维保", "续费", "到期", "合同", "客户", "拜访", "项目", "交付", "培训",
    ], { extraFiles: scannedFiles });
  } catch { /* 领域分析失败不影响初始化结果 */ }

  // 3.5 旧知识库导入（配置了 legacyWikiPath 时自动执行）
  let legacyImported: number | undefined;
  try {
    const legacyPath = getActiveWikiConfig().legacyWikiPath;
    if (legacyPath) {
      progress("legacy", 0, 1, "导入旧知识库");
      legacyImported = importLegacyWiki(workspaceDir, legacyPath).imported;
      progress("legacy", 1, 1, "旧库导入 " + legacyImported + " 页");
    }
  } catch { /* 配置读取失败不阻塞初始化 */ }

  // 4. 索引 + 日志（任何分支都必写，保证初始化留痕可追溯）
  progress("domains", 1, 1, "领域分析");
  try { regenerateIndex(workspaceDir); } catch { /* 索引重建失败不阻塞 */ }
  const skipLine = scanned.skipped ? `，跳过 ${scanned.skipped.dup + scanned.skipped.ignore + scanned.skipped.empty}` : "";
  appendToLog(workspaceDir, `init_workspace | 结构就绪 | 导入 ${scanned.ok} 篇${skipLine}${legacyImported ? ` | 旧库 ${legacyImported} 页` : ""}${wasAborted ? "（用户中止）" : ""} | 建议 ${domainSuggestions.length} 个领域`);
  progress("done", 1, 1, wasAborted ? "已中止" : "完成");

  return { wikiReady, scanned, domainSuggestions, ...(legacyImported ? { legacyImported } : {}), ...(wasAborted ? { aborted: true } : {}) } as InitWorkspaceResult;
}
