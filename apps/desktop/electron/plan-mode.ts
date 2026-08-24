/**
 * 计划模式：会话级"先探索、提方案、批准后执行"开关。
 *
 * 开启时工具管道否决一切写类工具（isMutationTool），Agent 只能读取和思考；
 * 否决理由会引导 Agent 输出结构化行动方案。用户批准后关闭开关恢复执行。
 * 状态按工作区目录隔离，应用内存态（重启即清零，避免残留锁死用户）。
 */

/** 写类动词（词边界匹配；口径与前端 TranscriptTimeline 的 WRITE_TOOL_RE 一致，
 *  但不含 send/stop/kill——消息编排与运行控制在计划模式下仍可用） */
const WRITE_TOOL_RE =
  /(?:^|[^a-z])(?:write|create|update|delete|remove|add|advance|ingest|save|edit|patch|append|exec|run|bash|apply|import|move|rename)(?![a-z])/i;

/** 名字里没有写动词、但实际会产生副作用的工具（显式名单） */
const MUTATION_EXPLICIT = new Set(["init_workspace"]);

/** 判断工具是否会产生副作用（计划模式下要否决）。params 用于 init_scan 这类看参行为的工具 */
export function isMutationTool(toolName: string, params?: Record<string, unknown>): boolean {
  if (MUTATION_EXPLICIT.has(toolName)) return true;
  // init_scan 默认只预览；import=true 才真正写入
  if (toolName === "init_scan") return params?.import === true;
  return WRITE_TOOL_RE.test(toolName);
}

const planModeByWorkspace = new Map<string, boolean>();

export function setPlanMode(workspaceDir: string, on: boolean): void {
  planModeByWorkspace.set(workspaceDir, on === true);
}

export function isPlanMode(workspaceDir: string): boolean {
  return planModeByWorkspace.get(workspaceDir) === true;
}

/** 否决时给 Agent 的引导语（也是它收到的 block reason） */
export const PLAN_MODE_VETO_REASON =
  "计划模式已开启：仅允许只读操作（读文件/查询/搜索/联网查资料）。请完成探索后输出行动方案——目标、具体步骤、涉及的数据或文件改动、风险与回退方式；然后提醒用户：确认方案后，点击输入框左侧 '+' 菜单里的'计划模式'关闭，即可继续执行修改。";
