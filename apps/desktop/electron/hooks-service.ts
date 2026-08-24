/**
 * Hooks 服务（P2）：用户可配置的事件规则。
 *
 * 规则 = 事件 + 匹配条件 + 动作：
 *   - 事件: tool_call / tool_result / session_start / agent_end 等基座 30+ 事件
 *   - 匹配: toolName（支持 * 通配和前缀通配 wiki_*）
 *   - 动作: log（记 wiki/log.md）/ notify（桌面通知）/ block（阻止执行，仅 tool_call）
 *
 * 存 workbench/wiki/hooks.md（JSON 代码块，同 schedule.md 模式），Agent 也可读写。
 * 由 tool-pipeline 在事件触发时读取并执行。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { wikiRoot, appendToLog, writeWikiFileSync } from "./wiki-manager";

/** 支持的事件类型（首批接入，可扩展） */
export const HOOK_EVENTS = ["tool_call", "tool_result", "session_start", "agent_end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** 支持的动作 */
export const HOOK_ACTIONS = ["log", "notify", "block", "terminate"] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];

export interface HookRule {
  id: string;
  name: string;
  enabled: boolean;
  event: HookEvent;
  /** 工具名匹配：精确 / * / 前缀通配 wiki_* */
  toolName: string;
  action: HookAction;
  message: string;
}

const HOOKS_FILE = "hooks.md";

export function hooksPath(workspaceDir: string): string {
  return path.join(wikiRoot(workspaceDir), HOOKS_FILE);
}

/** 确保 wiki/hooks.md 存在（幂等） */
export function ensureHooksFile(workspaceDir: string): void {
  const p = hooksPath(workspaceDir);
  if (!existsSync(p)) {
    const today = new Date().toISOString().slice(0, 10);
    writeWikiFileSync(p, `---\ntitle: Hooks\ntype: hooks\ncategory: hooks\ncreated: ${today}\nupdated: ${today}\n---\n\n# Hooks\n\n> 事件规则：到匹配的事件发生时执行动作（记日志/通知/阻止）。Agent 可读写。\n\n`, "utf-8");
    appendToLog(workspaceDir, "create | hooks.md | Hooks 初始化");
  }
}

/** 读取所有规则 */
export function readHookRules(workspaceDir: string): HookRule[] {
  const p = hooksPath(workspaceDir);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf-8");
  const blocks = text.match(/```json\n([\s\S]*?)```/g);
  if (!blocks) return [];
  const rules: HookRule[] = [];
  for (const block of blocks) {
    const jsonStr = block.replace(/```json\n/, "").replace(/```/, "").trim();
    try {
      const rule = JSON.parse(jsonStr);
      if (rule.id && rule.event) {
        rules.push({ enabled: true, toolName: "*", message: "", ...rule });
      }
    } catch { /* skip malformed */ }
  }
  return rules;
}

/** 规则写回文件 */
function writeHookRules(workspaceDir: string, rules: HookRule[]): void {
  const today = new Date().toISOString().slice(0, 10);
  let body = "\n# Hooks\n\n> 事件规则：到匹配的事件发生时执行动作（记日志/通知/阻止）。Agent 可读写。\n\n";
  for (const r of rules) {
    body += `## ${r.name}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`\n\n`;
  }
  writeWikiFileSync(hooksPath(workspaceDir), `---\ntitle: Hooks\ntype: hooks\ncategory: hooks\nupdated: ${today}\n---\n${body}`, "utf-8");
}

/** 添加规则（可指定固定 id 实现 upsert）。校验失败返回 null。 */
export function addHookRule(
  workspaceDir: string,
  input: Omit<HookRule, "id" | "enabled"> & { id?: string; enabled?: boolean },
): HookRule | null {
  if (!(HOOK_EVENTS as readonly string[]).includes(input.event)) return null;
  if (!(HOOK_ACTIONS as readonly string[]).includes(input.action)) return null;
  ensureHooksFile(workspaceDir);
  const id = input.id ?? `hook-${Date.now().toString(36)}`;
  const rule: HookRule = {
    id,
    name: input.name,
    enabled: input.enabled ?? true,
    event: input.event,
    toolName: input.toolName || "*",
    action: input.action,
    message: input.message ?? "",
  };
  const rules = readHookRules(workspaceDir).filter((r) => r.id !== id);
  rules.push(rule);
  writeHookRules(workspaceDir, rules);
  appendToLog(workspaceDir, `hook_add | ${id} | ${rule.name}`);
  return rule;
}

/** 删除规则 */
export function removeHookRule(workspaceDir: string, ruleId: string): boolean {
  const rules = readHookRules(workspaceDir);
  const filtered = rules.filter((r) => r.id !== ruleId);
  if (filtered.length === rules.length) return false;
  writeHookRules(workspaceDir, filtered);
  appendToLog(workspaceDir, `hook_remove | ${ruleId}`);
  return true;
}

/** 工具名通配匹配（支持 * 和前缀通配 wiki_*） */
function matchesToolName(pattern: string, toolName: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(toolName);
  }
  return pattern === toolName;
}

/** 返回事件+工具名命中的启用规则 */
export function matchHookRules(rules: HookRule[], event: string, toolName: string): HookRule[] {
  return rules.filter(
    (r) => r.enabled && r.event === event && (event === "tool_call" || event === "tool_result" ? matchesToolName(r.toolName, toolName) : true),
  );
}
