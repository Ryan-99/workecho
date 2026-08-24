/**
 * 待办提醒系统。
 *
 * - 每 5 分钟检查一次待办列表
 * - 距离截止时间 <= leadMinutes（默认 10 分钟）时推送桌面通知
 * - 每个待办只提醒一次（记录已提醒的 id）
 *
 * 用户可在设置里调整 leadMinutes（写入 settings.json）。
 */
import { Notification } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listEntities } from "./business-store";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 分钟检查一次
const DEFAULT_LEAD_MINUTES = 10;

interface RemindedSet {
  [todoId: string]: boolean;
}

export class TodoReminderService {
  private timer: NodeJS.Timeout | null = null;
  private reminded: RemindedSet = {};
  private remindedFilePath: string;

  constructor(
    private readonly getWorkspacePath: () => string | null,
    private readonly userDataDir: string,
  ) {
    this.remindedFilePath = path.join(userDataDir, "todo-reminded.json");
    this.loadReminded();
  }

  private loadReminded() {
    try {
      if (existsSync(this.remindedFilePath)) {
        this.reminded = JSON.parse(readFileSync(this.remindedFilePath, "utf-8"));
      }
    } catch {}
  }

  private saveReminded() {
    try {
      writeFileSync(this.remindedFilePath, JSON.stringify(this.reminded), "utf-8");
    } catch {}
  }

  /** 获取用户自定义的提前提醒分钟数 */
  getLeadMinutes(): number {
    try {
      const settingsPath = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent", "settings.json");
      if (existsSync(settingsPath)) {
        const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
        return s.todoLeadMinutes ?? DEFAULT_LEAD_MINUTES;
      }
    } catch {}
    return DEFAULT_LEAD_MINUTES;
  }

  start() {
    this.stop();
    // B-12：定时器回调必须吞异常——同步回调里抛错会变成 uncaughtException，
    // main.ts 对其 process.exit(1)，形成"重启→30 秒后再崩"的崩溃循环。
    const safeCheck = () => {
      try {
        this.checkOnce();
      } catch (error) {
        console.error("[todo-reminder] 检查失败（本轮跳过）:", error);
      }
    };
    const check = () => {
      safeCheck();
      this.timer = setInterval(safeCheck, CHECK_INTERVAL_MS) as unknown as NodeJS.Timeout;
    };
    // 首次延迟 30 秒启动
    this.timer = setTimeout(check, 30000) as unknown as NodeJS.Timeout;
    console.log("[todo-reminder] 服务已启动，提前提醒: " + this.getLeadMinutes() + " 分钟");
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; }
  }

  /** 检查一次 */
  checkOnce() {
    const cwd = this.getWorkspacePath();
    if (!cwd) return;
    const now = Date.now();
    const leadMs = this.getLeadMinutes() * 60 * 1000;
    let notified = false;

    const todos = listEntities(cwd, "todos");
    for (const todo of todos) {
      if (String(todo.frontmatter.status) !== "todo") continue;
      const id = String(todo.frontmatter.id ?? "");
      if (this.reminded[id]) continue;

      const dueDate = todo.frontmatter.dueDate as string;
      if (!dueDate) continue;

      const due = new Date(dueDate).getTime();
      if (isNaN(due)) continue;

      // 距离截止 <= leadMinutes
      const diff = due - now;
      if (diff <= leadMs && diff > -24 * 60 * 60 * 1000) {  // 已过期不超过 24 小时的也提醒
        const title = String(todo.frontmatter.title ?? "待办");
        const isOverdue = diff < 0;
        const body = isOverdue
          ? `已逾期: ${title}（截止 ${dueDate}）`
          : `${title}（${Math.ceil(diff / 60000)} 分钟后到期）`;

        if (Notification.isSupported()) {
          new Notification({ title: "待办提醒", body, silent: false }).show();
        }
        this.reminded[id] = true;
        notified = true;
      }
    }

    if (notified) this.saveReminded();
  }

  /** 任务完成时通知 */
  notifyCompleted(title: string) {
    if (Notification.isSupported()) {
      new Notification({
        title: "待办已完成",
        body: title,
        silent: false,
      }).show();
    }
  }
}
