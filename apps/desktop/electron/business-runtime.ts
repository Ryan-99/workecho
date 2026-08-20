/**
 * 业务工作台工具扩展。
 *
 * 参考 orchestration-runtime.ts 的模式：定义工具 → 包装成 ExtensionFactory →
 * 在 main.ts 的 extensionFactories 数组里注册。
 *
 * 业务数据模型（从原 workbench-app 移植）：实体是 Markdown 文件（front-matter + body），
 * 存在 <workspace>/workbench/<type>/ 下，type ∈ okr|ka|projects|maintenance|todos|cases。
 * Agent 通过这些工具查询/读取/创建/更新你的业务数据。
 *
 * 数据读写函数复用 business-store.ts（和状态面板、scheduler 共享同一份逻辑）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineTool, toolOk as okResult, toolErr as errResult, cwdFromContext, assertPiExtensionApi, type ExtensionContext, type ExtensionFactory } from "./pi-compat";
import { readEntity, listEntities, entityDir, entityFile, ENTITY_TYPES, stringifyFrontmatter, listEntityTypes } from "./business-store";
import { processInbox, searchCases, previewScan, importFiles, getCommonDocDirs, scanDocs } from "./knowledge-service";
import { createWebFetchTool } from "./web-fetch-tool";
import { appendToLog, regenerateIndex, createWikiPage, updateWikiPage, findPageByTitle, readMemory, updateMemory, lintWiki, addCrossReference, createGoal, advanceGoal, updateGoalStatus, getActiveGoals, ingestText, ingestDocuments, discoverDomains, searchWiki, saveSynthesis, importLegacyWiki } from "./wiki-manager";
import { readCardConfig, saveCardConfig } from "./card-config";
import { getActiveWikiConfig, piUserDataDir } from "./wiki-config";
import { addScheduleRule, readScheduleRules, removeScheduleRule } from "./schedule-service";
import { createPlugin, listPlugins, removePlugin } from "./plugin-service";
import { createSkill, listSkills, userSkillsRoot } from "./skill-service";
import { initializeWorkspace } from "./workbench-init";
import { emitToolProgress } from "./progress-broadcaster";

/* ============ 工具定义 ============ */

/** 列出所有 OKR 及进度 */
function createQueryOkrTool() {
  return defineTool("query_okr", "查询所有 OKR 及其进度", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const list = listEntities(cwd, "okr");
    const summary = list.map((e) => ({
      id: e.frontmatter.id ?? e.frontmatter.title,
      title: e.frontmatter.title,
      progress: e.frontmatter.progress,
      status: e.frontmatter.status,
    }));
    return okResult(`找到 ${summary.length} 个 OKR:\n${JSON.stringify(summary, null, 2)}`, summary);
  });
}

/** 列出快到期的维保 */
function createQueryMaintenanceTool() {
  return defineTool("query_maintenance", "查询维保续费状态（可选 status 参数过滤）", {
    type: "object",
    properties: {
      status: { type: "string", description: "按状态过滤（active/expired/expiring），不填则全部" },
    },
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    let list = listEntities(cwd, "maintenance");
    if (params?.status) list = list.filter((e) => e.frontmatter.status === params.status);
    const summary = list.map((e) => ({
      id: e.frontmatter.id,
      customer: e.frontmatter.customer ?? e.frontmatter.title,
      product: e.frontmatter.product,
      expireDate: e.frontmatter.expireDate ?? e.frontmatter.expire,
      status: e.frontmatter.status,
      amount: e.frontmatter.amount,
    }));
    return okResult(`找到 ${summary.length} 条维保记录:\n${JSON.stringify(summary, null, 2)}`, summary);
  });
}

/** 列出待办 */
function createQueryTodosTool() {
  return defineTool("query_todos", "查询待办事项（可选 status 过滤）", {
    type: "object",
    properties: {
      status: { type: "string", description: "按状态过滤（todo/done），不填则全部" },
    },
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    let list = listEntities(cwd, "todos");
    if (params?.status) list = list.filter((e) => e.frontmatter.status === params.status);
    const summary = list.map((e) => ({
      id: e.frontmatter.id,
      title: e.frontmatter.title,
      status: e.frontmatter.status,
      dueDate: e.frontmatter.dueDate,
    }));
    return okResult(`找到 ${summary.length} 条待办:\n${JSON.stringify(summary, null, 2)}`, summary);
  });
}

/** 列出 KA 客户 */
function createQueryKaTool() {
  return defineTool("query_ka", "查询 KA（重点客户）列表", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const list = listEntities(cwd, "ka");
    const summary = list.map((e) => ({
      id: e.frontmatter.id,
      name: e.frontmatter.name ?? e.frontmatter.title,
      tier: e.frontmatter.tier,
      status: e.frontmatter.status,
    }));
    return okResult(`找到 ${summary.length} 个 KA 客户:\n${JSON.stringify(summary, null, 2)}`, summary);
  });
}

/** 读取单个实体详情 */
function createReadEntityTool() {
  return defineTool("read_entity", "读取某个业务实体的完整内容（front-matter + 正文）", {
    type: "object",
    properties: {
      type: { type: "string", description: "实体类型（okr/todos/maintenance/ka/projects/cases 或自定义类型）" },
      id: { type: "string", description: "实体 ID" },
    },
    required: ["type", "id"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const e = readEntity(cwd, params.type, params.id);
    if (!e) return errResult(`未找到实体: ${params.type}/${params.id}`);
    return okResult(`## ${e.frontmatter.title ?? params.id}\n\n${e.body || "(无正文内容)"}`, e);
  });
}

/** 添加待办 */
/** 解析中文时间表达为 YYYY-MM-DD */
function parseDate(text: string): string | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 今天
  if (/今天|today/i.test(text)) return fmtDate(today);
  // 明天
  if (/明天|tomorrow/i.test(text)) { const d = new Date(today); d.setDate(d.getDate() + 1); return fmtDate(d); }
  // 后天
  if (/后天/.test(text)) { const d = new Date(today); d.setDate(d.getDate() + 2); return fmtDate(d); }
  // 下周X
  const weekMatch = text.match(/下周([一二三四五六日天])/);
  if (weekMatch && weekMatch[1]) {
    const days: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
    const target = days[weekMatch[1]] ?? 0;
    const d = new Date(today);
    d.setDate(d.getDate() + 7);
    d.setDate(d.getDate() - d.getDay() + target);
    if (d <= today) d.setDate(d.getDate() + 7);
    return fmtDate(d);
  }
  // X月X日/X号
  const dateMatch = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (dateMatch && dateMatch[1] && dateMatch[2]) {
    const m = parseInt(dateMatch[1]) - 1;
    const d = parseInt(dateMatch[2]);
    let year = now.getFullYear();
    if (m < now.getMonth() || (m === now.getMonth() && d < now.getDate())) year++;
    return fmtDate(new Date(year, m, d));
  }
  // YYYY-MM-DD
  const isoMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  // X天后
  const daysMatch = text.match(/(\d+)\s*天[后内]/);
  if (daysMatch && daysMatch[1]) { const d = new Date(today); d.setDate(d.getDate() + parseInt(daysMatch[1])); return fmtDate(d); }

  return null;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function createAddTodoTool() {
  return defineTool("add_todo", "添加一条待办事项。会自动从标题中解析时间（如'明天''下周一''8月15日''3天后'），生成 dueDate。", {
    type: "object",
    properties: {
      title: { type: "string", description: "待办标题（可包含时间，如'明天跟进招行''8月15日前完成报告'）" },
      dueDate: { type: "string", description: "截止日期（YYYY-MM-DD，可选。不填会自动从标题解析）" },
      priority: { type: "number", description: "优先级 1-5（5最紧急，默认3）" },
    },
    required: ["title"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const id = `todo-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = entityDir(cwd, "todos");
    mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const fm: Record<string, unknown> = {
      id,
      title: params.title,
      type: "todo",
      category: "todos",
      status: "todo",
      created: today,
      updated: today,
    };
    // 自动解析时间
    const dueDate = params.dueDate || parseDate(params.title);
    if (dueDate) fm.dueDate = dueDate;
    fm.priority = params.priority ?? 3;
    const content = stringifyFrontmatter(fm);
    writeFileSync(entityFile(cwd, "todos", id), content, "utf-8");
    appendToLog(cwd, `create_page | todos/${id}.md | ${params.title}`);
    regenerateIndex(cwd);
    return okResult(`已添加待办: ${params.title}${dueDate ? `（截止: ${dueDate}）` : ""} (id: ${id})`, { id, ...fm });
  });
}

/** 创建任意类型的实体（维保/OKR/KA/项目/案例等） */
function createCreateEntityTool() {
  return defineTool("create_entity", "创建一个新的业务实体（维保/OKR/KA/项目/案例等）", {
    type: "object",
    properties: {
      type: { type: "string", description: "实体类型（okr/maintenance/ka/projects/todos 或自定义类型）" },
      frontmatter: { type: "object", description: "实体的元数据字段（key-value），如 {customer,product,expireDate,status,amount}" },
      body: { type: "string", description: "正文内容（可选）" },
    },
    required: ["type", "frontmatter"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const id = (params.frontmatter.id as string) || `${params.type}-${Date.now().toString(36)}`;
    const today = new Date().toISOString().slice(0, 10);
    const fm: Record<string, unknown> = {
      ...params.frontmatter,
      id,
      type: "entity",
      category: params.type,
      created: today,
      updated: today,
    };
    mkdirSync(entityDir(cwd, params.type), { recursive: true });
    const content = stringifyFrontmatter(fm) + (params.body ? `\n${params.body}\n` : "\n");
    writeFileSync(entityFile(cwd, params.type, id), content, "utf-8");
    appendToLog(cwd, `create_page | ${params.type}/${id}.md`);
    regenerateIndex(cwd);
    return okResult(`已创建 ${params.type}/${id}`, { id, type: params.type, frontmatter: fm });
  });
}

/** 更新实体（修改 front-matter 字段） */
function createUpdateEntityTool() {
  return defineTool("update_entity", "更新已有实体的字段（如修改维保状态、OKR 进度等）", {
    type: "object",
    properties: {
      type: { type: "string", description: `实体类型: ${ENTITY_TYPES.join("|")}` },
      id: { type: "string", description: "实体 ID" },
      updates: { type: "object", description: "要更新的字段（key-value），如 {status: 'renewed', progress: 80}" },
    },
    required: ["type", "id", "updates"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const existing = readEntity(cwd, params.type, params.id);
    if (!existing) return errResult(`未找到实体: ${params.type}/${params.id}`);
    const updatedFm = { ...existing.frontmatter, ...params.updates, updated: new Date().toISOString().slice(0, 10) };
    const content = stringifyFrontmatter(updatedFm) + "\n" + existing.body + "\n";
    writeFileSync(entityFile(cwd, params.type, params.id), content, "utf-8");
    appendToLog(cwd, `update_page | ${params.type}/${params.id}.md`);
    return okResult(`已更新 ${params.type}/${params.id}`, { id: params.id, type: params.type, frontmatter: updatedFm });
  });
}

/** 处理收件箱：批量导入 _inbox/ 下的文件到知识库 */
function createProcessInboxTool() {
  return defineTool("process_inbox", "处理收件箱里的新文件：自动分类（案例/方法论/学习/工具）并导入知识库", {
    type: "object",
    properties: {},
  }, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const { total, results } = await processInbox(cwd);
    if (total === 0) return okResult("收件箱为空，没有需要处理的文件。", { total: 0 });
    const detail = results.map((r) => `[${r.category}] ${r.title}`).join("\n");
    return okResult(`已处理 ${total} 个文件:\n${detail}`, { total, results });
  });
}

/** 搜索知识库 */
function createSearchCasesTool() {
  return defineTool("search_cases", "搜索知识库（案例/方法论/学习笔记等），按关键词匹配标题、摘要和正文", {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const results = searchCases(cwd, params.query);
    if (results.length === 0) return okResult(`没有找到与"${params.query}"相关的知识条目。`, []);
    const summary = results.map((e) => ({
      id: e.frontmatter.id,
      title: e.frontmatter.title,
      category: e.frontmatter.category,
      summary: e.frontmatter.summary,
    }));
    return okResult(`找到 ${results.length} 条相关知识:\n${JSON.stringify(summary, null, 2)}`, summary);
  });
}

/**
 * 初始化扫描工具（两步制，省 token）：
 * 1. scan_preview（不传 import=true）：扫描后只返回统计 + 前 30 个样本，不导入。让用户确认范围。
 * 2. scan_preview（import=true 或用户确认后）：正式导入。
 * 不传 scanDir = 自动扫用户文档区（桌面/文档/下载 + 额外盘符）。
 */
function createInitScanTool() {
  return defineTool("init_scan", "初始化扫描：扫描电脑文档（.md/.txt），自动分类。先预览（import=false）再导入（import=true）。不传 scanDir 则自动扫描用户文档区。", {
    type: "object",
    properties: {
      scanDir: { type: "string", description: "要扫描的目录（可选，不填则自动扫描桌面/文档/下载等常用目录）" },
      import: { type: "boolean", description: "false=仅预览（默认），true=确认后正式导入知识库" },
    },
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const doImport = params.import === true;

    // 确定扫描范围
    let scanDirs: string[];
    if (params.scanDir) {
      scanDirs = [params.scanDir];
    } else {
      scanDirs = getCommonDocDirs();
    }

    if (!doImport) {
      // 步骤 1：预览
      const preview = previewScan(scanDirs);
      if (preview.total === 0) {
        return okResult(`扫描了 ${scanDirs.join(", ")}，没有找到可导入的文档（.md/.txt）。`, preview);
      }
      const catLine = Object.entries(preview.categories).map(([k, v]) => `${k}: ${v}篇`).join("，");
      const sampleLine = preview.samples.slice(0, 10).map((s) => `  [${s.category}] ${s.title}`).join("\n");
      return okResult(
        `扫描完成，找到 ${preview.total} 篇文档。\n分类：${catLine}\n\n部分示例：\n${sampleLine}\n${preview.total > 10 ? `...等共 ${preview.total} 篇` : ""}\n\n请用户确认后，我将正式导入。`,
        preview,
      );
    }

    // 步骤 2：正式导入
    const preview = previewScan(scanDirs);
    const allFiles = preview.samples.map((s) => s.file);
    // 预览只返回前 30 个样本，实际导入需要全部文件——重新扫描拿完整列表
    const fullFiles: string[] = [];
    for (const d of scanDirs) { fullFiles.push(...scanDocs(d, 5)); }
    const result = await importFiles(cwd, fullFiles);
    const catSummary = Object.entries(result.categories).map(([k, v]) => `${k}: ${v}篇`).join("，");
    return okResult(
      `导入完成：共 ${result.total} 篇，成功 ${result.ok} 篇。\n分类分布：${catSummary}${result.failed.length > 0 ? `\n失败 ${result.failed.length} 个` : ""}`,
      result,
    );
  });
}

/** AI 创建自定义卡片模板（新建实体类型 + 卡片配置） */
function createCardTemplateTool() {
  return defineTool("create_card_template",
    "创建一个新的工作台卡片。会自动建实体目录、写卡片配置、更新系统提示词。用户下次打开右侧面板就能看到。", {
    type: "object",
    properties: {
      title: { type: "string", description: "卡片标题（如：客户拜访记录）" },
      entityType: { type: "string", description: "实体类型名（英文，如 visits、meetings）" },
      displayFields: { type: "array", items: { type: "string" }, description: "展示哪些字段（如 [customer, date, topic]）" },
      fieldLabels: { type: "object", description: "字段中文名映射（如 {customer: '客户', date: '日期'}）" },
      icon: { type: "string", description: "lucide 图标名（如 Users、Calendar、FileText），默认 FileText" },
    },
    required: ["title", "entityType", "displayFields"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    // 创建实体目录（wiki 路径）
    const dir = entityDir(cwd, params.entityType);
    mkdirSync(dir, { recursive: true });
    // 写示例数据（统一页面格式）
    const sampleId = `${params.entityType}-sample-${Date.now().toString(36)}`;
    const today = new Date().toISOString().slice(0, 10);
    const fm: Record<string, unknown> = {
      id: sampleId,
      title: `示例：${params.title}（可删除）`,
      type: "entity",
      category: params.entityType,
      tags: ["示例"],
      created: today,
      updated: today,
    };
    for (const f of params.displayFields) {
      if (f !== "id" && f !== "title") fm[f] = params.fieldLabels?.[f] ?? f;
    }
    writeFileSync(path.join(dir, `${sampleId}.md`), stringifyFrontmatter(fm) + "\n这是示例数据，请编辑或删除后添加真实数据。\n", "utf-8");
    // 更新卡片配置
    const userDataDir = piUserDataDir();
    const cards = readCardConfig(userDataDir);
    const newCard = {
      id: `custom-${params.entityType}-${Date.now().toString(36)}`,
      title: params.title,
      icon: params.icon ?? "FileText",
      entityType: params.entityType,
      displayFields: params.displayFields,
      fieldLabels: params.fieldLabels ?? {},
      limit: 5,
      template: "custom" as const,
    };
    cards.push(newCard);
    saveCardConfig(userDataDir, cards);
    appendToLog(cwd, `create_card | ${params.entityType} | ${params.title}`);
    regenerateIndex(cwd);
    return okResult(`已创建卡片"${params.title}"，绑定实体类型 ${params.entityType}。在 wiki/${params.entityType}/ 目录下添加 .md 文件即可看到数据。`, newCard);
  });
}

/** 列出当前卡片配置 */
function createListCardTemplatesTool() {
  return defineTool("list_card_templates", "列出当前工作台的所有卡片配置", {}, async () => {
    const cards = readCardConfig(piUserDataDir());
    return okResult(`当前有 ${cards.length} 张卡片:\n${cards.map((c: any) => `- ${c.title} (类型: ${c.entityType})`).join("\n")}`, cards);
  });
}

/** 删除卡片模板 */
function createRemoveCardTemplateTool() {
  return defineTool("remove_card_template", "删除一张工作台卡片（不删除数据，只移除卡片展示）", {
    type: "object",
    properties: { cardId: { type: "string", description: "卡片 ID" } },
    required: ["cardId"],
  }, async (_id, params: any) => {
    const userDataDir = piUserDataDir();
    const cards = readCardConfig(userDataDir);
    const filtered = cards.filter((c: any) => c.id !== params.cardId);
    if (filtered.length === cards.length) return errResult(`未找到卡片: ${params.cardId}`);
    saveCardConfig(userDataDir, filtered);
    return okResult(`已删除卡片 ${params.cardId}`, { removed: params.cardId });
  });
}

/* ============ Wiki 统一知识库工具 ============ */

/** wiki_create_page：在 wiki 中创建页面（统一入口） */
function createWikiCreatePageTool() {
  return defineTool("wiki_create_page",
    "在统一 Wiki 知识库中创建一个新页面。自动维护 index.md 和 log.md。适用于创建任何类型的 wiki 页面（实体/案例/概念/综合分析等）。", {
    type: "object",
    properties: {
      category: { type: "string", description: "wiki 类别（okr/todos/maintenance/ka/projects/knowledge/cases/knowledge/concepts/knowledge/synthesis/memory 或自定义类型）" },
      title: { type: "string", description: "页面标题" },
      frontmatter: { type: "object", description: "额外元数据字段（可选），如 {customer,product,status,tags:[..]}" },
      body: { type: "string", description: "正文内容（可选）" },
    },
    required: ["category", "title"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const result = createWikiPage(cwd, params.category, params.title, params.frontmatter ?? {}, params.body ?? "");
    return okResult(`已创建 wiki 页面: ${result.relPath}`, result);
  });
}

/** wiki_update_page：更新页面（append body + 更新 frontmatter） */
function createWikiUpdatePageTool() {
  return defineTool("wiki_update_page",
    "更新 wiki 页面。append 模式追加内容到正文（不覆写），也可更新 frontmatter 字段。自动维护 log.md。", {
    type: "object",
    properties: {
      title: { type: "string", description: "页面标题（用于查找）" },
      appendBody: { type: "string", description: "追加到正文的内容（不覆写原有内容）" },
      frontmatterUpdates: { type: "object", description: "要更新的 frontmatter 字段（可选）" },
    },
    required: ["title"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const page = findPageByTitle(cwd, params.title);
    if (!page) return errResult(`未找到 wiki 页面: ${params.title}`);
    const ok = updateWikiPage(cwd, page.relPath, params.appendBody ?? "", params.frontmatterUpdates ?? {});
    if (!ok) return errResult(`更新失败: ${page.relPath}`);
    return okResult(`已更新 wiki 页面: ${page.relPath}`, { relPath: page.relPath });
  });
}

/** wiki_read_memory：读取 Agent 对用户的记忆 */
function createWikiReadMemoryTool() {
  return defineTool("wiki_read_memory",
    "读取 Agent 对用户的长期记忆（用户画像、工作上下文、洞察）。会话开始时自动调用以恢复对用户的认知。", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const mem = readMemory(cwd);
    const summary = `## 用户画像\n${mem.userProfile || "(暂无)"}\n\n## 工作上下文\n${mem.workingContext || "(暂无)"}\n\n## 洞察\n${mem.insights || "(暂无)"}`;
    return okResult(summary, mem);
  });
}

/** wiki_update_memory：更新 Agent 记忆 */
function createWikiUpdateMemoryTool() {
  return defineTool("wiki_update_memory",
    "更新 Agent 对用户的记忆。发现用户新偏好/习惯时更新 user-profile，产生工作决策时更新 working-context。不需要用户确认——直接存。", {
    type: "object",
    properties: {
      page: { type: "string", description: "记忆页面名（user-profile / working-context / insights）" },
      content: { type: "string", description: "新内容" },
      mode: { type: "string", description: "replace=完全替换, append=追加（默认）", enum: ["replace", "append"] },
    },
    required: ["page", "content"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const ok = updateMemory(cwd, params.page, params.content, params.mode ?? "append");
    if (!ok) return errResult(`更新记忆失败: ${params.page}`);
    return okResult(`已更新记忆: ${params.page}`, { page: params.page });
  });
}

/** wiki_lint：巡检 wiki（孤立页、死链） */
function createWikiLintTool() {
  return defineTool("wiki_lint",
    "巡检 Wiki 知识库：检测孤立页（无人引用）和死链（引用了不存在的页面）。定期运行保持知识库整洁。", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const report = lintWiki(cwd);
    const lines: string[] = [];
    if (report.orphans.length > 0) {
      lines.push(`孤立页（${report.orphans.length}）:`);
      for (const o of report.orphans) lines.push(`  - ${o}`);
    }
    if (report.deadLinks.length > 0) {
      lines.push(`死链（${report.deadLinks.length}）:`);
      for (const d of report.deadLinks) lines.push(`  - ${d.page} → ${d.link}`);
    }
    if (lines.length === 0) lines.push("Wiki 知识库状态良好，无孤立页和死链。");
    return okResult(lines.join("\n"), report);
  });
}

/** wiki_add_ref：给页面添加交叉引用 */
function createWikiAddRefTool() {
  return defineTool("wiki_add_ref",
    "给 wiki 页面添加交叉引用（[[wikilink]]）。在创建/更新页面时检查相关页面并建立引用。", {
    type: "object",
    properties: {
      sourceTitle: { type: "string", description: "源页面标题" },
      targetTitle: { type: "string", description: "目标页面标题（被引用的页面）" },
    },
    required: ["sourceTitle", "targetTitle"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const source = findPageByTitle(cwd, params.sourceTitle);
    if (!source) return errResult(`未找到源页面: ${params.sourceTitle}`);
    const ok = addCrossReference(cwd, source.relPath, params.targetTitle);
    if (!ok) return errResult(`添加引用失败`);
    return okResult(`已在 "${params.sourceTitle}" 中添加对 "${params.targetTitle}" 的引用`, { source: source.relPath, target: params.targetTitle });
  });
}

/* ============ Goal 子系统工具（附录 A3） ============ */

/** wiki_create_goal：创建长任务目标 */
function createWikiCreateGoalTool() {
  return defineTool("wiki_create_goal",
    "创建一个长任务目标。目标有步骤列表和状态机（active→complete）。适合多步骤任务，Agent 可以跨会话追踪进度。", {
    type: "object",
    properties: {
      title: { type: "string", description: "目标标题（如：整理 Q3 客户拜访报告）" },
      steps: { type: "array", items: { type: "string" }, description: "步骤列表（按顺序执行）" },
    },
    required: ["title", "steps"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const result = createGoal(cwd, params.title, params.steps);
    return okResult(`已创建目标"${params.title}"，共 ${params.steps.length} 步。当前第 1 步。`, result);
  });
}

/** wiki_advance_goal：推进目标步骤 */
function createWikiAdvanceGoalTool() {
  return defineTool("wiki_advance_goal",
    "推进目标：标记当前步骤完成，进入下一步。最后一步完成时目标状态变为 complete。", {
    type: "object",
    properties: {
      title: { type: "string", description: "目标标题" },
    },
    required: ["title"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const page = findPageByTitle(cwd, params.title);
    if (!page) return errResult(`未找到目标: ${params.title}`);
    const ok = advanceGoal(cwd, page.relPath);
    if (!ok) return errResult(`推进失败`);
    return okResult(`已推进目标"${params.title}"`, { relPath: page.relPath });
  });
}

/** wiki_get_active_goals：获取当前活动目标 */
function createWikiGetActiveGoalsTool() {
  return defineTool("wiki_get_active_goals",
    "获取所有活动目标（status=active 或 blocked）。会话启动时调用以恢复上次做到哪里。", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const goals = getActiveGoals(cwd);
    if (goals.length === 0) return okResult("当前没有活动目标。", []);
    const summary = goals.map((g) => {
      const progress = `${g.currentStep}/${g.steps.length}`;
      return `- ${g.title} [${g.status}] 进度: ${progress}${g.steps[g.currentStep] ? ` 下一步: ${g.steps[g.currentStep]}` : ""}`;
    }).join("\n");
    return okResult(`活动目标（${goals.length}）:\n${summary}`, goals);
  });
}

/** wiki_update_goal_status：改变目标状态 */
function createWikiUpdateGoalStatusTool() {
  return defineTool("wiki_update_goal_status",
    "改变目标状态（active/paused/blocked/complete）。遇到阻碍设为 blocked，解决后恢复 active。", {
    type: "object",
    properties: {
      title: { type: "string", description: "目标标题" },
      status: { type: "string", description: "新状态", enum: ["active", "paused", "blocked", "complete"] },
    },
    required: ["title", "status"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const page = findPageByTitle(cwd, params.title);
    if (!page) return errResult(`未找到目标: ${params.title}`);
    const ok = updateGoalStatus(cwd, page.relPath, params.status);
    if (!ok) return errResult(`状态更新失败（无效状态或非目标页面）`);
    return okResult(`目标"${params.title}"状态已改为 ${params.status}`, { relPath: page.relPath, status: params.status });
  });
}

/* ============ 知识摄取工具（Phase 3） ============ */

/** wiki_ingest：摄取文档/文本到 wiki 知识库 */
function createWikiIngestTool() {
  return defineTool("wiki_ingest",
    "摄取文档/文本到统一 Wiki 知识库。自动分类（案例/方法论/学习/工具）、生成摘要、建交叉引用、更新 index/log。不传参数=处理 _sources/inbox/ 下所有文件；传 text=摄取指定文本。", {
    type: "object",
    properties: {
      text: { type: "string", description: "要摄取的文本内容（可选，不填则处理 inbox 文件）" },
      title: { type: "string", description: "知识页标题（摄取文本时必填）" },
      source: { type: "string", description: "来源描述（如'对话记录''inbox/xxx.txt'）" },
    },
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const wikiConfig = getActiveWikiConfig();
    if (params.text) {
      const result = ingestText(cwd, params.text, params.title ?? "未命名知识", {
        source: params.source ?? "对话记录",
        autoCrossRef: wikiConfig.ingestAutoCrossRef,
      });
      return okResult(
        `已摄取知识: ${result.relPath}\n分类: ${result.subcategory}\n摘要: ${result.summary.slice(0, 60)}${result.crossRefs.length > 0 ? `\n交叉引用: ${result.crossRefs.join(", ")}` : ""}`,
        result,
      );
    }
    // 无 text → 批量处理 inbox
    const batch = ingestDocuments(cwd);
    if (batch.ingested === 0) return okResult("_sources/inbox/ 为空，没有需要摄取的文件。", batch);
    const detail = batch.results.map((r) => `[${r.subcategory}] ${r.relPath}`).join("\n");
    return okResult(`已摄取 ${batch.ingested} 个文件:\n${detail}${batch.failed.length > 0 ? `\n失败: ${batch.failed.join(", ")}` : ""}`, batch);
  });
}

/** wiki_discover_domains：扫描文档发现高频领域词，建议动态类型 */
function createWikiDiscoverDomainsTool() {
  return defineTool("wiki_discover_domains",
    "扫描 _sources/ 下的文档，统计关键词频次，建议创建动态 wiki 类型 + 卡片。用于初始化领域发现。", {
    type: "object",
    properties: {
      keywords: {
        type: "array", items: { type: "string" },
        description: "要检测的领域关键词（默认检测：维保/续费/到期/合同/客户/拜访/项目/交付/培训）",
      },
    },
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const wikiConfig = getActiveWikiConfig();
    const keywords = params.keywords ?? ["维保", "续费", "到期", "合同", "客户", "拜访", "项目", "交付", "培训"];
    const suggestions = discoverDomains(cwd, keywords, { threshold: wikiConfig.discoverThreshold });
    if (suggestions.length === 0) return okResult("没有检测到高频领域词（阈值 3 篇以上）。", []);
    const detail = suggestions.map((s) => `- "${s.keyword}" 出现 ${s.count} 次 → 建议类型: ${s.suggestedType}`).join("\n");
    return okResult(`检测到 ${suggestions.length} 个高频领域:\n${detail}`, suggestions);
  });
}

/** wiki_search：全文搜索 wiki 知识库 */
function createWikiSearchTool() {
  return defineTool("wiki_search",
    "全文搜索 Wiki 知识库（标题/标签/正文），按相关度排序返回匹配页面。", {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      limit: { type: "number", description: "返回结果数上限（默认 10）" },
    },
    required: ["query"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const results = searchWiki(cwd, params.query, { limit: params.limit ?? 10 });
    if (results.length === 0) return okResult(`没有找到与"${params.query}"相关的 wiki 页面。`, []);
    const detail = results.map((r, i) => `${i + 1}. ${r.title} (score:${r.score})\n   ${r.snippet.slice(0, 60)}...`).join("\n");
    return okResult(`找到 ${results.length} 条结果:\n${detail}`, results);
  });
}

/** wiki_query：查询 + 综合分析 + 存回（write-back） */
function createWikiQueryTool() {
  return defineTool("wiki_query",
    "查询 Wiki 知识库并综合分析。搜索相关页面、读取内容、给出带引用的回答。如果分析产生了有价值的洞察，用 saveSynthesis 存回 wiki。", {
    type: "object",
    properties: {
      query: { type: "string", description: "查询问题（如'招行的维保情况''AF策略引擎的故障案例'）" },
    },
    required: ["query"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const results = searchWiki(cwd, params.query, { limit: 5 });
    if (results.length === 0) return okResult(`Wiki 中没有找到与"${params.query}"相关的内容。`, { query: params.query, results: [] });
    // 汇总找到的页面内容供 Agent 综合
    const summary = results.map((r) => {
      const page = findPageByTitle(cwd, r.title);
      const bodyPreview = page ? page.body.slice(0, 200) : "";
      return `### ${r.title}\n路径: ${r.relPath}\n${bodyPreview ? `内容摘要: ${bodyPreview}...\n` : ""}`;
    }).join("\n---\n");
    return okResult(
      `查询"${params.query}"找到 ${results.length} 个相关页面:\n\n${summary}\n\n如果上述内容让你产生了综合洞察，请用 wiki_create_page 在 knowledge/synthesis/ 下创建综合分析页。`,
      { query: params.query, results },
    );
  });
}

/** wiki_save_synthesis：存回综合分析（write-back） */
function createWikiSaveSynthesisTool() {
  return defineTool("wiki_save_synthesis",
    "把查询/分析产生的洞察存为 wiki 综合分析页（knowledge/synthesis/）。用于沉淀有价值的交叉分析结论。", {
    type: "object",
    properties: {
      title: { type: "string", description: "综合分析标题" },
      content: { type: "string", description: "分析内容" },
      sources: { type: "array", items: { type: "string" }, description: "引用来源页面标题列表" },
    },
    required: ["title", "content"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const result = saveSynthesis(cwd, params.title, params.content, params.sources ?? []);
    return okResult(`已保存综合分析: ${result.relPath}`, result);
  });
}

/* ============ Schedule 子系统工具（附录 A4） ============ */

function createWikiCreateScheduleTool() {
  return defineTool("wiki_create_schedule",
    "创建一条定时规则。到时间时 Agent 主动在对话中执行 action 并汇报。支持每日定时(at 09:00)、每周定时(weekday+time)、事件触发(before_event N天前)。", {
    type: "object",
    properties: {
      name: { type: "string", description: "规则名称（如：每日早报）" },
      triggerType: { type: "string", description: "触发类型", enum: ["every", "before_event", "at"] },
      time: { type: "string", description: "触发时间 HH:MM（every/at 类型用，如 09:00）" },
      weekday: { type: "number", description: "星期几 0-6（0=周日，every 类型可选）" },
      days: { type: "number", description: "提前几天（before_event 类型用）" },
      entityType: { type: "string", description: "实体类型（before_event 用，如 maintenance）" },
      field: { type: "string", description: "日期字段名（before_event 用，如 expireDate）" },
      action: { type: "string", description: "Agent 执行的动作描述（如：查询今日待办+维保到期，生成早报）" },
    },
    required: ["name", "triggerType", "action"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const rule = addScheduleRule(cwd, {
      name: params.name,
      trigger: {
        type: params.triggerType,
        time: params.time,
        weekday: params.weekday,
        days: params.days,
        entityType: params.entityType,
        field: params.field,
      },
      action: params.action,
    });
    return okResult(`已创建定时规则"${params.name}"(${rule.id})。到时间时 Agent 会主动执行。`, rule);
  });
}

function createWikiListSchedulesTool() {
  return defineTool("wiki_list_schedules", "列出所有定时规则", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const rules = readScheduleRules(cwd);
    if (rules.length === 0) return okResult("当前没有定时规则。", []);
    const detail = rules.map((r: any) => `- ${r.name} [${r.enabled ? "启用" : "禁用"}] trigger:${JSON.stringify(r.trigger)} → ${r.action}`).join("\n");
    return okResult(`定时规则（${rules.length}）:\n${detail}`, rules);
  });
}

function createWikiRemoveScheduleTool() {
  return defineTool("wiki_remove_schedule", "删除一条定时规则", {
    type: "object",
    properties: { ruleId: { type: "string", description: "规则 ID" } },
    required: ["ruleId"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const ok = removeScheduleRule(cwd, params.ruleId);
    if (!ok) return errResult(`未找到规则: ${params.ruleId}`);
    return okResult(`已删除定时规则 ${params.ruleId}`, { removed: params.ruleId });
  });
}

/* ============ Agent 自我修改插件工具（附录 A1） ============ */

function createWikiCreatePluginTool() {
  return defineTool("wiki_create_plugin",
    "创建一个新的工具插件（.ts 文件）到 .pi/extensions/。当你发现自己缺少某个能力时使用。代码必须 export default function(pi){pi.registerTool(...)}。重启后生效。", {
    type: "object",
    properties: {
      name: { type: "string", description: "插件名（英文，如 jira-search）" },
      code: { type: "string", description: "插件 TypeScript 代码。模板：export default function(pi) { pi.registerTool({ name: 'tool_name', description: '...', parameters: {...}, async execute(toolCallId, params) { return { content: [{type:'text',text:'result'}], details: {} }; } }); }" },
    },
    required: ["name", "code"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const wikiConfig = getActiveWikiConfig();
    if (!wikiConfig.selfModifyPlugins) {
      return errResult("Agent 自我修改插件功能已被禁用。请在设置 → Wiki 知识库中开启。");
    }
    const cwd = cwdFromContext(ctx);
    const result = createPlugin(cwd, params.name, params.code);
    if (!result.created) return errResult(`插件创建失败: ${result.reason}`);
    const warn = result.warnings.length > 0 ? `\n⚠️ 安全警告: ${result.warnings.join("; ")}` : "";
    return okResult(`已创建插件 ${result.relPath}。重启 app 后生效。${warn}`, result);
  });
}

function createWikiListPluginsTool() {
  return defineTool("wiki_list_plugins", "列出 .pi/extensions/ 下所有插件及其注册的工具", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const plugins = listPlugins(cwd);
    if (plugins.length === 0) return okResult("当前没有自定义插件。", []);
    const detail = plugins.map((p: any) => `- ${p.name}: 注册工具 [${p.tools.join(", ")}]${p.description ? ` — ${p.description}` : ""}`).join("\n");
    return okResult(`自定义插件（${plugins.length}）:\n${detail}`, plugins);
  });
}

function createWikiRemovePluginTool() {
  return defineTool("wiki_remove_plugin", "删除一个自定义插件", {
    type: "object",
    properties: { name: { type: "string", description: "插件名" } },
    required: ["name"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const ok = removePlugin(cwd, params.name);
    if (!ok) return errResult(`未找到插件: ${params.name}`);
    return okResult(`已删除插件 ${params.name}`, { removed: params.name });
  });
}

/* ============ Agent 自管 Skill 工具（P1-b，omp manage_skill 思路） ============ */

/** wiki_create_skill：把对话经验沉淀成 Skill */
function createWikiCreateSkillTool() {
  return defineTool("wiki_create_skill",
    "把有价值的对话经验/工作流程沉淀为 Skill（Agent 按需自动调用的技能）。当你发现某个流程被反复执行、或用户表达了可复用的偏好时调用。创建后下个会话生效。", {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill 名称（英文 kebab-case，如 weekly-report、case-summary）" },
      description: { type: "string", description: "一句话描述何时使用这个 skill（Agent 靠这个判断触发时机）" },
      content: { type: "string", description: "Skill 内容（Markdown 指令，写清楚步骤和要求）" },
    },
    required: ["name", "description", "content"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    const result = createSkill(userSkillsRoot(), params.name, params.description, params.content);
    if (!result.created) return errResult(`创建 Skill 失败: ${result.reason}`);
    appendToLog(cwd, `skill_create | ${params.name}`);
    return okResult(`已创建 Skill "${params.name}"（${result.path}）。新会话中立即可用。`, result);
  });
}

/** wiki_list_skills：列出已安装 Skill */
function createWikiListSkillsTool() {
  return defineTool("wiki_list_skills",
    "列出所有已安装的 Skill（名称+描述）。创建新 Skill 前先查看避免重名。", {}, async (_id, _params, _signal, _onUpdate, ctx) => {
    const skills = listSkills(userSkillsRoot());
    if (skills.length === 0) return okResult("当前没有已安装的 Skill。", []);
    const detail = skills.map((s: any) => `- ${s.name}: ${s.description}`).join("\n");
    return okResult(`已安装 Skill（${skills.length}）:\n${detail}`, skills);
  });
}

/* ============ 一键初始化（用户说"帮我初始化工作环境"时触发） ============ */

function createInitWorkspaceTool() {
  return defineTool("init_workspace",
    "一键初始化整个工作环境（含知识库）：创建 wiki 结构+记忆模板+定时/hooks 配置，扫描电脑文档导入知识库（自动去重、不动原文件），分析高频领域词建议动态类型。幂等可重复执行。用户说'帮我初始化工作环境/初始化一下/设置好环境'这类表达时直接调用，不需要确认。", {
    type: "object",
    properties: {
      scanDir: { type: "string", description: "要扫描的目录（可选，不填则自动扫描桌面/文档/下载+常用盘符）" },
      skipScan: { type: "boolean", description: "true 时只建结构不扫描文档（默认 false）" },
    },
  }, async (_id, params: any, signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    let result;
    try {
      result = await initializeWorkspace(cwd, {
        scanDirs: params.scanDir ? [params.scanDir] : undefined,
        doScan: params.skipScan === true ? false : undefined,
        signal,
        onProgress: (e) => emitToolProgress({
          tool: "init_workspace",
          phase: e.phase,
          current: e.current,
          total: e.total,
          message: e.message,
        }),
      });
    } catch (e) {
      return errResult(`初始化失败: ${(e as Error).message}。可以指定一个较小的目录重试（scanDir 参数），或用 skipScan=true 只建结构。`);
    }
    if ((result as any).aborted) {
      return okResult(`初始化已被用户中止。已完成部分：结构就绪，导入 ${result.scanned.ok} 篇。再次执行会从断点继续（自动去重）。`, result);
    }
    const catLine = Object.entries(result.scanned.categories).map(([k, v]) => `${k}:${v}`).join("，");
    const skip = result.scanned.skipped;
    const skipLine = skip ? `（另跳过 ${skip.dup + skip.ignore + skip.empty}：重复 ${skip.dup}／无价值 ${skip.ignore + skip.empty}）` : "";
    const domainLine = result.domainSuggestions
      .slice(0, 5)
      .map((d: any) => `"${d.keyword}"×${d.count}→建议类型 ${d.suggestedType}`)
      .join("；");
    return okResult(
      `工作环境初始化完成。\n` +
      `- Wiki 结构：就绪（记忆模板/定时/hooks 已配置）\n` +
      `- 知识库导入：${result.scanned.ok} 篇${catLine ? `（${catLine}）` : ""}${skipLine}\n` +
      (result.legacyImported !== undefined ? `- 旧知识库：已导入 ${result.legacyImported} 页（概念→knowledge/concepts，客户等实体→对应类型）\n` : "") +
      `- 领域发现：${result.domainSuggestions.length > 0 ? domainLine : "未检测到高频领域"}\n\n` +
      (result.domainSuggestions.length > 0 ? `高频领域可以创建对应的卡片类型（用 create_card_template），需要的话告诉我。` : `可以开始用了。试试让我"查询待办"或"添加待办"。`),
      result,
    );
  });
}

/* ============ 旧知识库导入（Karpathy 式精炼库迁移） ============ */

function createWikiImportLegacyTool() {
  return defineTool("wiki_import_legacy",
    "导入旧版知识库目录（如 D:\\Workspace\\Workspace 结构：wiki/concepts + wiki/entities + journals + pages + raw + index.md）。概念页进 knowledge/concepts，实体目录变成动态类型（可出卡片），旧 index 并入精炼区块不被覆盖。幂等可重复执行。", {
    type: "object",
    properties: {
      sourceDir: { type: "string", description: "旧知识库根目录路径（包含 wiki/、journals/、pages/ 的那层）" },
    },
    required: ["sourceDir"],
  }, async (_id, params: any, _signal, _onUpdate, ctx) => {
    const cwd = cwdFromContext(ctx);
    try {
      const result = importLegacyWiki(cwd, params.sourceDir);
      if (result.imported === 0) {
        return okResult(`没有导入任何文件（目录不存在或已全部导入过）。检查路径：${params.sourceDir}`, result);
      }
      // 提示可能的卡片类型
      const skipTypes = ["concepts", "journals", "pages", "raw"];
      const types = [...new Set(result.details.map((d) => d.split("/")[0] ?? ""))].filter((t) => !skipTypes.includes(t));
      return okResult(
        `已从旧库导入 ${result.imported} 个页面。\n` +
        `- 概念页 → wiki/knowledge/concepts/\n` +
        (types.length > 0 ? `- 实体类型：${types.join("、")}（可用 create_card_template 创建对应卡片）\n` : "") +
        `- 旧 index 已并入精炼区块\n\n` +
        `建议：让我为高频领域创建卡片视图，并基于导入的内容继续精炼知识库。`,
        result,
      );
    } catch (e) {
      return errResult(`导入失败: ${(e as Error).message}`);
    }
  });
}

/* ============ 工具注册（ExtensionFactory） ============ */

export function createBusinessRuntimeExtension(): ExtensionFactory {
  return (pi) => {
    assertPiExtensionApi(pi, "pi");
    for (const tool of createBusinessTools()) {
      pi.registerTool(tool);
    }
  };
}

export function createBusinessTools() {
  return [
    createQueryOkrTool(),
    createQueryMaintenanceTool(),
    createQueryTodosTool(),
    createQueryKaTool(),
    createReadEntityTool(),
    createAddTodoTool(),
    createCreateEntityTool(),
    createUpdateEntityTool(),
    createProcessInboxTool(),
    createSearchCasesTool(),
    createInitScanTool(),
    createWebFetchTool(),
    createCardTemplateTool(),
    createListCardTemplatesTool(),
    createRemoveCardTemplateTool(),
    // Wiki 统一知识库工具
    createWikiCreatePageTool(),
    createWikiUpdatePageTool(),
    createWikiReadMemoryTool(),
    createWikiUpdateMemoryTool(),
    createWikiLintTool(),
    createWikiAddRefTool(),
    // Goal 子系统工具（A3）
    createWikiCreateGoalTool(),
    createWikiAdvanceGoalTool(),
    createWikiGetActiveGoalsTool(),
    createWikiUpdateGoalStatusTool(),
    // 知识摄取工具（Phase 3）
    createWikiIngestTool(),
    createWikiDiscoverDomainsTool(),
    createWikiSearchTool(),
    createWikiQueryTool(),
    createWikiSaveSynthesisTool(),
    // Schedule 子系统工具（A4）
    createWikiCreateScheduleTool(),
    createWikiListSchedulesTool(),
    createWikiRemoveScheduleTool(),
    // Agent 自我修改插件工具（A1）
    createWikiCreatePluginTool(),
    createWikiListPluginsTool(),
    createWikiRemovePluginTool(),
    // Agent 自管 Skill（P1-b）
    createWikiCreateSkillTool(),
    createWikiListSkillsTool(),
    // 一键初始化
    createInitWorkspaceTool(),
    // 旧知识库导入
    createWikiImportLegacyTool(),
  ];
}

/* pi-coding-agent 适配（defineTool/okResult/errResult/cwdFromContext）已抽到 ./pi-compat，
   上游升级时只需改 pi-compat.ts 一个文件（见 PI-UPGRADE.md）。 */
