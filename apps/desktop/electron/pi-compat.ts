/**
 * pi agent 兼容层（Anti-Corruption Layer）。
 *
 * 整个 Workecho 业务代码对上游 @earendil-works/pi-coding-agent 的直接依赖
 * 集中在本文件——上游频繁更新时只需要改这里 + 对照
 * tests/wiki/pi-contract.test.mjs 的契约断言，业务代码（business-runtime /
 * tool-pipeline / main 等）一律从 "./pi-compat" 引用，不直接 import 上游包。
 *
 * 封装的上游契约面（与 pi-contract.test.mjs 的 C1-C7 一一对应）：
 * - 类型：AgentToolResult / ExtensionContext / ExtensionFactory
 * - 扩展工厂调用约定：(pi) => void，pi.registerTool(tool)、pi.on(event, handler)
 * - 工具形状：{ name, description, parameters, execute(五参) }
 * - 工具结果形状：{ content: [{type:"text",text}], details }
 * - tool_call 事件否决：handler 返回 { block: true, reason }
 * - ExtensionContext.cwd（workspace 路径，缺失回退 process.cwd）
 */
import type { AgentToolResult, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/* 类型再导出：业务代码的引用点统一为 ./pi-compat */
export type { AgentToolResult, ExtensionContext, ExtensionFactory };

/** 我们订阅的 pi 事件（升级时逐一核对事件名与载荷结构） */
export const PI_EVENTS = {
  /** (event: {toolName, input}, ctx) => {block, reason}? —— 返回可否决工具执行 */
  toolCall: "tool_call",
  /** (event: {toolName, content, isError?}, ctx) */
  toolResult: "tool_result",
  /** (event, ctx) —— 会话启动（Hook 规则 log/notify 可用） */
  sessionStart: "session_start",
  /** (event: {messages}, ctx) —— Agent 回合结束（Hook 规则 log/notify 可用） */
  agentEnd: "agent_end",
} as const;
export type PiEventName = (typeof PI_EVENTS)[keyof typeof PI_EVENTS];

/** pi 工具定义形状（上游 execute 为五参签名） */
export interface PiToolDefinition {
  name: string;
  /** 上游 0.84+ ToolDefinition 必填的 UI 标签，默认取工具名 */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}

/** 业务代码用的工具定义入口（上游形状变了只改这里） */
export function defineTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  execute: PiToolDefinition["execute"],
): PiToolDefinition {
  return { name, label: name, description, parameters: inputSchema, execute };
}

/** 工具成功结果（AgentToolResult 形状） */
export function toolOk(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/** 工具失败结果 */
export function toolErr(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: undefined };
}

/** 从 ExtensionContext 取 cwd（workspace 路径）；上游未提供时回退 process.cwd */
export function cwdFromContext(ctx: ExtensionContext | undefined): string {
  return (ctx as any)?.cwd ?? process.cwd();
}

/**
 * 运行时校验 pi 扩展宿主的 API 面。
 * 上游重命名 registerTool/on 时在控制台给出明确提示（而不是静默失效），
 * 契约测试 C3/C4 会在测试期先行拦截。
 */
export function assertPiExtensionApi(pi: unknown, label = "pi"): void {
  const p = pi as Record<string, unknown> | null | undefined;
  if (!p || typeof p.registerTool !== "function") {
    console.warn(`[pi-compat] ${label}.registerTool 不可用——上游 API 可能已变更，请检查 pi-compat.ts`);
  }
  if (!p || typeof p.on !== "function") {
    console.warn(`[pi-compat] ${label}.on 不可用——上游事件订阅 API 可能已变更，请检查 pi-compat.ts`);
  }
}
