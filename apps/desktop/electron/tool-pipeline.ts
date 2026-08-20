/**
 * A2 瀑布流工具执行管道（WIKI-DESIGN.md 附录 A2）。
 *
 * 三层管道：PRE-EXECUTE → EXECUTE → POST-EXECUTE
 * - PRE: 审计日志、危险操作检测、参数校验、可否决
 * - EXECUTE: 实际工具执行（由 pi runtime 负责）
 * - POST: 结果存入 wiki、更新 index/log、触发通知/刷新
 *
 * 策略引擎（isDangerousOp/shouldPersistResult/auditToolCall）可独立测试。
 * createPolicyExtension 返回 ExtensionFactory，注册 pi 事件钩子。
 */
import { PI_EVENTS, type ExtensionFactory } from "./pi-compat";
import { appendToLog } from "./wiki-manager";
import { getActiveWikiConfig } from "./wiki-config";
import { readHookRules, matchHookRules } from "./hooks-service";

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

/** 查询类工具（只读，不修改数据，结果不自动存） */
const READONLY_TOOLS = new Set([
  "query_okr", "query_maintenance", "query_todos", "query_ka",
  "read_entity", "search_cases", "wiki_search", "wiki_read_memory",
  "wiki_lint", "wiki_get_active_goals", "list_card_templates",
  "wiki_query", "wiki_discover_domains", "init_scan",
]);

/** 结果应该自动存入 wiki 的工具 */
const PERSIST_TOOLS = new Set([
  "wiki_ingest", "wiki_query", "wiki_save_synthesis", "web_fetch",
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
  // 知识扫描显式指定目录（默认目录扫描视为常规初始化）
  if (toolName === "init_scan" && typeof params.scanDir === "string" && params.scanDir.trim()) {
    return true;
  }
  return false;
}

/**
 * 判断工具结果是否应该自动存入 wiki。
 */
export function shouldPersistResult(toolName: string): boolean {
  return PERSIST_TOOLS.has(toolName);
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
    return JSON.stringify(safe).slice(0, 80);
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
    const success = result && typeof result === "object" && !((result as Record<string, unknown>).error);
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

  return { decision: PipelineDecision.PASS };
}

/**
 * POST-EXECUTE 处理器：结果审计 + 判断是否需要存入 wiki。
 */
export function postExecute(
  workspaceDir: string,
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
): { shouldPersist: boolean } {
  auditToolCall(workspaceDir, toolName, params, result, "result");
  return { shouldPersist: shouldPersistResult(toolName) };
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
      } catch {
        return { block: false };
      }
    };

    // 注册事件钩子（tool_call 可返回 {block, reason} 否决执行）
    if (typeof pi.on === "function") {
      pi.on(PI_EVENTS.toolCall, async (event: { toolName: string; input: Record<string, unknown> }, ctx: any) => {
        try {
          const config = getConfig();
          const cwd = ctx?.cwd ?? (pi as any).cwd ?? process.cwd();
          // 审计管道受 pipelineEnabled 门控；Hook 规则独立（仅受 hooksEnabled 门控，在 applyHooks 内检查）
          if (!config || config.pipelineEnabled) {
            const pre = preExecute(cwd, event.toolName, event.input);
            // P2 补全：危险操作确认（dangerousOpConfirm 配置生效）。
            // fail-closed：命中危险操作但确认器不可用时拒绝执行，而非静默放行（安全审核 TP-1）
            if (pre.dangerous && config?.dangerousOpConfirm !== false) {
              if (!dangerousConfirmer) {
                appendToLog(cwd, `dangerous_op | ${event.toolName} | blocked(no-confirmer)`);
                return { block: true, reason: "危险操作需要用户确认，但确认器不可用；请在应用内重试" };
              }
              const desc = pre.dangerousDescription ?? `${event.toolName} ${JSON.stringify(event.input).slice(0, 80)}`;
              const approved = await dangerousConfirmer("危险操作确认", desc);
              appendToLog(cwd, `dangerous_op | ${event.toolName} | ${approved ? "approved" : "rejected"}`);
              if (!approved) {
                return { block: true, reason: "用户拒绝了危险操作" };
              }
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
            postExecute(cwd, event.toolName, {}, event.content);
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
    (pi as any).pipeline = { preExecute, postExecute, isDangerousOp, shouldPersistResult, applyHooks };
  };
}
