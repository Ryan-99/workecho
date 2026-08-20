/**
 * A4 Schedule 子系统（WIKI-DESIGN.md 附录 A4）。
 *
 * 比现有 reminder-scheduler 更智能的定时服务：
 * - 不只弹通知，而是在指定时间向会话注入一条 Agent 消息
 * - Agent 主动执行 action（查询/分析/报告），在对话里主动发言
 * - 规则存在 wiki/schedule.md，Agent 可读写
 *
 * 核心逻辑可独立测试；会话注入（injectIntoSession）需要 pi runtime 接线。
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { wikiRoot, appendToLog } from "./wiki-manager";
import { stringifyFrontmatter } from "./business-store";

/** 触发类型 */
export interface ScheduleTrigger {
  type: "every" | "before_event" | "at";
  time?: string;        // "HH:MM" 格式（every/at 类型用）
  weekday?: number;     // 0=周日, 1=周一, ... 6=周六（every 类型可选）
  date?: string;        // "YYYY-MM-DD"（at 类型用）
  days?: number;        // 提前几天（before_event 类型用）
  entityType?: string;  // 实体类型（before_event 用，如 "maintenance"）
  field?: string;       // 日期字段名（before_event 用，如 "expireDate"）
}

/** 定时规则 */
export interface ScheduleRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  action: string;       // Agent 执行的 action 描述
  lastFired?: string;   // 上次触发时间（ISO）
}

const SCHEDULE_FILE = "schedule.md";

/** schedule.md 的完整路径 */
function schedulePath(workspaceDir: string): string {
  return path.join(wikiRoot(workspaceDir), SCHEDULE_FILE);
}

/** 确保 wiki/schedule.md 存在（幂等） */
export function ensureScheduleFile(workspaceDir: string): void {
  const p = schedulePath(workspaceDir);
  if (!existsSync(p)) {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(p, stringifyFrontmatter({
      title: "工作日程",
      type: "schedule",
      category: "schedule",
      created: today,
      updated: today,
    }) + `
# 工作日程

> Agent 维护的定时规则。到时间时 Agent 主动执行 action 并在对话中发言。
> 格式：每条规则用 "## 规则名" + JSON 代码块定义。

`, "utf-8");
    appendToLog(workspaceDir, "create | schedule.md | 定时规则初始化");
  }
}

/** 读取所有定时规则 */
export function readScheduleRules(workspaceDir: string): ScheduleRule[] {
  const p = schedulePath(workspaceDir);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf-8");
  const rules: ScheduleRule[] = [];
  // 解析 JSON 代码块（每条规则是一个 ```json ... ``` 块）
  const blocks = text.match(/```json\n([\s\S]*?)```/g);
  if (!blocks) return [];
  for (const block of blocks) {
    const jsonStr = block.replace(/```json\n/, "").replace(/```/, "").trim();
    try {
      const rule = JSON.parse(jsonStr);
      if (rule.id && rule.trigger) {
        rules.push({ enabled: true, ...rule });
      }
    } catch {
      /* skip malformed */
    }
  }
  return rules;
}

/** 把所有规则写回 schedule.md */
function writeScheduleRules(workspaceDir: string, rules: ScheduleRule[]): void {
  const today = new Date().toISOString().slice(0, 10);
  const fm = stringifyFrontmatter({
    title: "工作日程",
    type: "schedule",
    category: "schedule",
    created: today,
    updated: today,
  });
  let body = "\n# 工作日程\n\n> Agent 维护的定时规则。到时间时 Agent 主动执行 action 并在对话中发言。\n\n";
  for (const rule of rules) {
    body += `## ${rule.name}\n\n`;
    body += "```json\n" + JSON.stringify(rule, null, 2) + "\n```\n\n";
    body += `**触发**: ${describeTrigger(rule.trigger)}  \n**动作**: ${rule.action}  \n**状态**: ${rule.enabled ? "✅ 启用" : "⏸️ 禁用"}\n\n`;
  }
  writeFileSync(schedulePath(workspaceDir), fm + body, "utf-8");
}

function describeTrigger(t: ScheduleTrigger): string {
  if (t.type === "every") {
    const day = t.weekday !== undefined ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][t.weekday] + " " : "每天 ";
    return `${day}${t.time ?? ""}`;
  }
  if (t.type === "before_event") {
    return `${t.entityType ?? ""}.${t.field ?? "dueDate"} 前 ${t.days ?? 0} 天`;
  }
  if (t.type === "at") {
    return `${t.date ?? ""} ${t.time ?? ""}`;
  }
  return JSON.stringify(t);
}

/** 添加一条定时规则（可指定固定 id） */
export function addScheduleRule(
  workspaceDir: string,
  rule: Omit<ScheduleRule, "id" | "enabled"> & { id?: string },
): ScheduleRule {
  ensureScheduleFile(workspaceDir);
  const id = rule.id ?? `schedule-${Date.now().toString(36)}`;
  const fullRule: ScheduleRule = { ...rule, id, enabled: true };
  const rules = readScheduleRules(workspaceDir);
  // 如果 id 已存在，先移除旧的（upsert 语义）
  const filtered = rules.filter((r) => r.id !== id);
  filtered.push(fullRule);
  writeScheduleRules(workspaceDir, filtered);
  appendToLog(workspaceDir, `schedule_add | ${id} | ${rule.name}`);
  return fullRule;
}

/** 删除定时规则 */
export function removeScheduleRule(workspaceDir: string, ruleId: string): boolean {
  const rules = readScheduleRules(workspaceDir);
  const filtered = rules.filter((r) => r.id !== ruleId);
  if (filtered.length === rules.length) return false;
  writeScheduleRules(workspaceDir, filtered);
  appendToLog(workspaceDir, `schedule_remove | ${ruleId}`);
  return true;
}

/**
 * 判断规则是否应该在当前时间触发。
 * @param rule 规则
 * @param now 当前时间
 * @param lastCheck 上次检查时间（用于判断是否跨越了触发点）
 */
export function shouldFireRule(rule: ScheduleRule, now: Date, lastCheck: Date): boolean {
  if (!rule.enabled) return false;

  if (rule.trigger.type === "every") {
    if (!rule.trigger.time) return false;
    const [h, m] = rule.trigger.time.split(":").map(Number);
    if (h === undefined || m === undefined) return false;
    // 检查 weekday
    if (rule.trigger.weekday !== undefined && now.getDay() !== rule.trigger.weekday) return false;
    // 当前时间是否在触发点之后，且上次检查在触发点之前
    const fireTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    return now >= fireTime && lastCheck < fireTime;
  }

  if (rule.trigger.type === "at") {
    if (!rule.trigger.date) return false;
    const [h, m] = (rule.trigger.time ?? "00:00").split(":").map(Number);
    const fireTime = new Date(rule.trigger.date + "T00:00:00");
    fireTime.setHours(h ?? 0, m ?? 0);
    return now >= fireTime && lastCheck < fireTime;
  }

  // before_event 类型：需要查询实体数据判断，这里返回 false（由 checkAndFire 处理）
  return false;
}

/**
 * 构建注入对话的提示文本。
 * Agent 读到后会主动执行 action。
 */
export function buildSchedulePrompt(rule: ScheduleRule): string {
  return `[定时触发: ${rule.name}]\n${rule.action}\n\n请执行上述操作，并在对话中主动汇报结果。`;
}
