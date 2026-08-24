/**
 * A2 瀑布流工具执行管道（WIKI-DESIGN.md 附录 A2）。
 *
 * 三层管道：PRE-EXECUTE → EXECUTE → POST-EXECUTE
 * - PRE: 审计日志、危险操作检测、参数校验、可否决
 * - EXECUTE: 实际工具执行（由 pi runtime 负责）
 * - POST: 结果存入 wiki、更新 index/log、触发通知/刷新
 *
 * 策略引擎（isDangerousOp/auditToolCall）可独立测试。
 * createPolicyExtension 返回 ExtensionFactory，注册 pi 事件钩子。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { PI_EVENTS, type ExtensionFactory } from "./pi-compat";
import { appendToLog } from "./wiki-manager";
import { getActiveWikiConfig } from "./wiki-config";
import { readHookRules, matchHookRules, hooksPath } from "./hooks-service";
import { isPlanMode, isMutationTool, PLAN_MODE_VETO_REASON } from "./plan-mode";

/** Hook 通知器：由 main.ts 注入（Electron Notification）。策略层不直接依赖 electron，测试可注入 mock。 */
let hookNotifier: ((title: string, body: string) => void) | null = null;
export function setHookNotifier(fn: ((title: string, body: string) => void) | null): void {
  hookNotifier = fn;
}

/** 危险操作确认器：由 main.ts 注入（应用内确认弹窗）。返回 false = 用户拒绝 → 否决工具执行。 */
let dangerousConfirmer: ((title: string, body: string) => Promise<boolean>) | null = null;
export function setDangerousOpConfirmer(fn: ((title: string, body: string) => Promise<boolean>) | null): void {
  dangerousConfirmer = fn;
}

/** 管道决策 */
export const PipelineDecision = {
  PASS: "pass" as const,
  BLOCK: "block" as const,
};

/** 需要确认的危险实体类型（修改这些类型的数据需要用户确认） */
const DANGEROUS_ENTITY_TYPES = new Set(["okr", "maintenance"]);

/** pi 上游的文件写入类工具（写这些工具的 path 参数才做受保护路径检查） */
const WRITE_FILE_TOOLS = new Set(["write", "edit", "edit-diff"]);

/**
 * 受保护配置文件判定（HK-1/F-06/F-34）：Agent 的文件工具改写这些文件
 * 等于修改自身的安全管控（Hook 规则 / 系统提示词 / MCP 命令清单），
 * 命中即走危险确认（复用 isDangerousOp 的确认与 fail-closed 流程）。
 */
export function isProtectedConfigPath(params: Record<string, unknown>, cwd: string): boolean {
  const workspaceTargets = [
    path.resolve(cwd, "workbench/wiki/hooks.md"),
    path.resolve(cwd, "workbench/wiki/schedule.md"),
    path.resolve(cwd, "workbench/wiki/log.md"),
    path.resolve(cwd, "AGENTS.md"),
  ];
  const check = (v: unknown): boolean => {
    if (typeof v !== "string" || !v) return false;
    const resolved = path.resolve(cwd, v);
    if (workspaceTargets.includes(resolved)) return true;
    const normalized = resolved.split(path.sep).join("/").toLowerCase();
    return normalized.endsWith(".pi/agent/mcp-servers.json");
  };
  const scan = (v: unknown): boolean => {
    if (typeof v === "string") return check(v);
    if (Array.isArray(v)) return v.some(scan);
    if (v && typeof v === "object") return Object.values(v).some(scan);
    return false;
  };
  return Object.values(params ?? {}).some(scan);
}

/** 查询类工具（只读，不修改数据，结果不自动存） */
const READONLY_TOOLS = new Set([
  "query_okr", "query_maintenance", "query_todos", "query_ka",
  "read_entity", "search_cases", "wiki_search", "wiki_read_memory",
  "wiki_lint", "wiki_get_active_goals", "list_card_templates",
  "wiki_query", "wiki_discover_domains", "init_scan",
]);

/**
 * 判断操作是否危险（需要用户确认）。
 * 规则：
 * - 修改 okr/maintenance 类型数据的 update 操作；
 * - 写入可执行插件代码（wiki_create_plugin，agent 自我扩展）；
 * - 整页覆写记忆（wiki_update_memory mode=replace，防持久化提示注入）；
 * - 显式指定目录的知识扫描（init_scan scanDir，读取工作区外文件）。
 */
export function isDangerousOp(toolName: string, params: Record<string, unknown>): boolean {
  // 插件 = 可执行代码，一律确认
  if (toolName === "wiki_create_plugin") {
    return true;
  }
  // update_entity 修改关键类型
  if (toolName === "update_entity") {
    const type = String(params.type ?? "");
    return DANGEROUS_ENTITY_TYPES.has(type);
  }
  // wiki_update_page 修改状态/金额等关键字段
  if (toolName === "wiki_update_page") {
    // B-01：按标题更新管控文件（hooks/schedule/log）同样属于改写安全管控
    const title = String(params.title ?? "").trim().toLowerCase();
    if (title === "hooks" || title === "schedule" || title === "log") {
      return true;
    }
    const updates = params.frontmatterUpdates as Record<string, unknown> | undefined;
    if (updates && (updates.status !== undefined || updates.amount !== undefined)) {
      return true;
    }
    return false;
  }
  // 记忆整页覆写（append 增量风险低，replace 可被注入利用）
  if (toolName === "wiki_update_memory") {
    return params.mode === "replace";
  }
  // B-01：在 memory/ 下新建页面同样进入持久化注入面（user-profile 等
  // 既有页的覆写已由 createWikiPage 的存在检查拒绝），一律确认
  if (toolName === "wiki_create_page") {
    const category = String(params.category ?? "").replace(/\\/g, "/").trim().toLowerCase();
    return category === "memory" || category.startsWith("memory/");
  }
  // 知识扫描显式指定目录（默认目录扫描视为常规初始化）
  if (toolName === "init_scan" && typeof params.scanDir === "string" && params.scanDir.trim()) {
    return true;
  }
  // B-03：读取工作区外目录进知识库的等价路径统一走确认——
  // wiki_import_legacy（任意 sourceDir）与 init_workspace 显式 scanDir 此前可旁路 init_scan 的门
  if (toolName === "wiki_import_legacy") {
    return true;
  }
  if (toolName === "init_workspace" && typeof params.scanDir === "string" && params.scanDir.trim()) {
    return true;
  }
  return false;
}

/**
 * 审计工具调用/结果到 log.md。
 * @param phase "call" = 调用前, "result" = 调用后
 */
/** 审计日志脱敏：凭据类键值不落 log.md（log 可被 agent 检索/展示） */
const SENSITIVE_KEY_RE = /(api[-_]?key|token|secret|password|authorization|credential)/i;
function redactParams(params: Record<string, unknown>): string {
  try {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      safe[k] = SENSITIVE_KEY_RE.test(k) ? "***" : v;
    }
    // B-18：80 字符会把 update_entity 的具体改动值截掉，放宽到 200
    return JSON.stringify(safe).slice(0, 200);
  } catch {
    return "(unserializable)";
  }
}

export function auditToolCall(
  workspaceDir: string,
  toolName: string,
  params: Record<string, unknown>,
  result?: unknown,
  phase: "call" | "result" = "call",
): void {
  if (phase === "call") {
    const paramStr = redactParams(params);
    appendToLog(workspaceDir, `tool_call | ${toolName} | ${paramStr}`);
  } else {
    // B-18：pi 的工具结果常是 content-block 数组（无 error 字段），恒被判成
    // success——调用方应显式传 isError（见 postExecute）
    const success = result === true || (result && typeof result === "object" && !((result as Record<string, unknown>).error));
    appendToLog(workspaceDir, `tool_result | ${toolName} | ${success ? "success" : "check"}`);
  }
}

/**
 * PRE-EXECUTE 处理器：审计 + 危险操作检测。
 * 返回 PipelineDecision.PASS 放行，PipelineDecision.BLOCK 否决。
 */
export function preExecute(
  workspaceDir: string,
  toolName: string,
  params: Record<string, unknown>,
): { decision: typeof PipelineDecision.PASS | typeof PipelineDecision.BLOCK; reason?: string; dangerous?: boolean; dangerousDescription?: string } {
  // 审计日志
  auditToolCall(workspaceDir, toolName, params);

  // 危险操作：返回描述给调用方做确认（handler 里接 dangerousConfirmer）
  if (isDangerousOp(toolName, params)) {
    const type = String(params.type ?? params.title ?? "");
    return {
      decision: PipelineDecision.PASS,
      dangerous: true,
      dangerousDescription: `即将修改关键数据：${toolName}${type ? `（${type}）` : ""}。确认执行？`,
    };
  }

  // 受保护配置文件写入（HK-1/F-06）：文件工具改写管控配置 = 自我松绑
  if (WRITE_FILE_TOOLS.has(toolName) && isProtectedConfigPath(params, workspaceDir)) {
    return {
      decision: PipelineDecision.PASS,
      dangerous: true,
      dangerousDescription: "Agent 正在写入受保护配置文件（hooks.md / AGENTS.md / mcp-servers.json）。这类文件控制安全策略，确认允许修改？",
    };
  }

  return { decision: PipelineDecision.PASS };
}

/**
 * POST-EXECUTE 处理器：结果审计。
 * （入库不在这里做——wiki_ingest 等工具自身写库，wiki_query 由提示词引导回写洞察。）
 */
export function postExecute(
  workspaceDir: string,
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
  isError?: boolean,
): void {
  if (isError === true) {
    appendToLog(workspaceDir, `tool_result | ${toolName} | error`);
    return;
  }
  auditToolCall(workspaceDir, toolName, params, isError === false ? true : result, "result");
}

/** 危险操作/受保护路径命中的确认弹窗文案（供 handler 与 preExecute 共用） */
export function describeDangerousOp(
  workspaceDir: string,
  toolName: string,
  params: Record<string, unknown>,
): string | undefined {
  if (isDangerousOp(toolName, params)) {
    const type = String(params.type ?? params.title ?? params.category ?? "");
    return `即将修改关键数据：${toolName}${type ? `（${type}）` : ""}。确认执行？`;
  }
  if (WRITE_FILE_TOOLS.has(toolName) && isProtectedConfigPath(params, workspaceDir)) {
    return "Agent 正在写入受保护配置文件（hooks.md / schedule.md / log.md / AGENTS.md / mcp-servers.json）。这类文件控制安全策略，确认允许修改？";
  }
  return undefined;
}

/**
 * 创建策略扩展（ExtensionFactory）。
 * 注册 pi 事件钩子，实现工具执行的审计和安全拦截。
 *
 * 注意：pi-coding-agent 的 ExtensionAPI 可能不直接支持 tool_call/tool_result 事件。
 * 如果不支持，这个扩展作为策略规则库被其他工具内部调用。
 */
export function createPolicyExtension(): ExtensionFactory {
  return (pi: any) => {
    // 读取 Wiki 配置判断是否启用管道
    const getConfig = () => {
      try {
        return getActiveWikiConfig();
      } catch { return null; }
    };

    /** 执行命中的 Hook 规则，返回是否需要 block（仅 tool_call） */
    const applyHooks = (
      cwd: string,
      event: string,
      toolName: string,
    ): { block: boolean; reason?: string; terminate?: boolean } => {
      let terminate = false;
      try {
        const config = getConfig();
        if (config && config.hooksEnabled === false) return { block: false };
        const rules = matchHookRules(readHookRules(cwd), event, toolName);
        let blocked = false;
        let reason: string | undefined;
        for (const rule of rules) {
          if (rule.action === "log") {
            appendToLog(cwd, `hook | ${rule.name} | ${event} | ${toolName}`);
          } else if (rule.action === "notify") {
            try {
              hookNotifier?.(`Hook: ${rule.name}`, rule.message || `${toolName} 触发了 ${event}`);
            } catch { /* 通知失败忽略 */ }
          } else if ((rule.action === "block" || rule.action === "terminate") && event === PI_EVENTS.toolCall) {
            blocked = true;
            reason = rule.message || `已 Hook 拦截: ${rule.name}`;
            // pi 0.84.1+：terminate 让 agent 在本批工具后直接终止，不再追加模型调用
            if (rule.action === "terminate") terminate = true;
          }
        }
        return { block: blocked, reason, ...(terminate ? { terminate: true } : {}) };
      } catch (error) {
        // B-05：Hook 读取/匹配异常不能静默 fail-open。规则文件存在却读不出来，
        // 说明用户的拦截意图状态未知（EPERM/损坏），按 fail-closed 拦下并留证据。
        try {
          console.error("[tool-pipeline] applyHooks 异常:", error);
          appendToLog(cwd, `hook_error | ${event} | ${toolName} | ${(error as Error).message}`);
        } catch { /* 日志失败忽略 */ }
        if (existsSync(hooksPath(cwd))) {
          return {
            block: true,
            reason: "Hook 规则文件存在但无法读取（可能被占用或损坏），已按拦截处理；请检查 workbench/wiki/hooks.md",
          };
        }
        return { block: false };
      }
    };

    // 注册事件钩子（tool_call 可返回 {block, reason} 否决执行）
    if (typeof pi.on === "function") {
      pi.on(PI_EVENTS.toolCall, async (event: { toolName: string; input: Record<string, unknown> }, ctx: any) => {
        try {
          const config = getConfig();
          const cwd = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
          // 计划模式（独立于 pipelineEnabled，属于用户意图开关）：只读探索，否决一切写类工具
          if (isPlanMode(cwd) && isMutationTool(event.toolName, event.input)) {
            appendToLog(cwd, `plan_mode_block | ${event.toolName}`);
            return { block: true, reason: PLAN_MODE_VETO_REASON };
          }
          // B-04：审计日志受 pipelineEnabled 门控；危险操作确认与受保护路径检查
          // 是独立的安全开关（dangerousOpConfirm），关闭"审计管道"不应连带
          // 关闭确认门（此前二者捆绑，pipelineEnabled=false 会把确认门整个架空）
          if (!config || config.pipelineEnabled) {
            auditToolCall(cwd, event.toolName, event.input);
          }
          const dangerousDescription = describeDangerousOp(cwd, event.toolName, event.input);
          if (dangerousDescription && config?.dangerousOpConfirm !== false) {
            // fail-closed：命中危险操作但确认器不可用时拒绝执行，而非静默放行（安全审核 TP-1）
            if (!dangerousConfirmer) {
              appendToLog(cwd, `dangerous_op | ${event.toolName} | blocked(no-confirmer)`);
              return { block: true, reason: "危险操作需要用户确认，但确认器不可用；请在应用内重试" };
            }
            const approved = await dangerousConfirmer("危险操作确认", dangerousDescription);
            appendToLog(cwd, `dangerous_op | ${event.toolName} | ${approved ? "approved" : "rejected"}`);
            if (!approved) {
              return { block: true, reason: "用户拒绝了危险操作" };
            }
          }
          const { block, reason, terminate } = applyHooks(cwd, "tool_call", event.toolName);
          if (block) {
            appendToLog(cwd, `hook_block | ${event.toolName} | ${reason}${terminate ? " | terminate" : ""}`);
            return { block: true, reason, ...(terminate ? { terminate: true } : {}) };
          }
        } catch {
          /* 审计失败不影响工具执行 */
        }
      });

      pi.on(PI_EVENTS.toolResult, (event: { toolName: string; content: unknown; isError?: boolean }, ctx: any) => {
        try {
          const config = getConfig();
          const cwd = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
          if (!config || config.pipelineEnabled) {
            // B-18：把 pi 的 isError 传下去，失败结果不再被记成 success
            postExecute(cwd, event.toolName, {}, event.content, event.isError);
          }
          applyHooks(cwd, "tool_result", event.toolName);
        } catch {
          /* ignore */
        }
      });

      // P1 补全：session_start / agent_end 事件（此前 UI 可配但从未挂载）
      pi.on(PI_EVENTS.sessionStart, (_event: unknown, ctx: any) => {
        try {
          const cwd = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
          applyHooks(cwd, "session_start", "");
        } catch { /* ignore */ }
      });
      pi.on(PI_EVENTS.agentEnd, (_event: unknown, ctx: any) => {
        try {
          const cwd = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
          applyHooks(cwd, "agent_end", "");
        } catch { /* ignore */ }
      });
    }

    // 提供 preExecute/postExecute 给其他扩展调用
    (pi as any).pipeline = { preExecute, postExecute, isDangerousOp, applyHooks };
  };
}
