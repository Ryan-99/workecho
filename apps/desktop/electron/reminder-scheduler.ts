/**
 * 定时提醒调度器。
 *
 * 从原 workbench-app 移植。每日到设定时间检查：
 * - 维保续费：X 天内到期的（X = leadDays，默认 30）
 * - 待办：已过截止日期但未完成的
 *
 * 有提醒时通过 Electron Notification API 推送桌面通知。
 */
import { Notification } from "electron";
import { listEntities, type EntityData } from "./business-store";

const DAY = 86400000;

export interface ReminderBundle {
  maintenance: Array<{ id: string; customer: string; product: string; expireDate: string; daysLeft: number }>;
  todos: Array<{ id: string; title: string; dueDate: string; daysOverdue: number }>;
}

/** 计算当前需要提醒的维保和待办 */
export function computeReminders(cwd: string, leadDays = 30): ReminderBundle {
  const horizon = Date.now() + leadDays * DAY;

  const maintenance = listEntities(cwd, "maintenance")
    .filter((e) => {
      const status = String(e.frontmatter.status ?? "");
      const expire = e.frontmatter.expireDate ?? e.frontmatter.expire;
      return status !== "renewed" && status !== "已续约" && expire;
    })
    .map((e) => {
      const expire = String(e.frontmatter.expireDate ?? e.frontmatter.expire ?? "");
      return { e, t: new Date(expire).getTime() };
    })
    .filter((x) => x.t >= Date.now() && x.t <= horizon)
    .map((x) => ({
      id: String(x.e.frontmatter.id ?? ""),
      customer: String(x.e.frontmatter.customer ?? x.e.frontmatter.title ?? ""),
      product: String(x.e.frontmatter.product ?? ""),
      expireDate: String(x.e.frontmatter.expireDate ?? x.e.frontmatter.expire ?? ""),
      daysLeft: Math.ceil((x.t - Date.now()) / DAY),
    }));

  const todos = listEntities(cwd, "todos")
    .filter((e) => {
      const status = String(e.frontmatter.status ?? "");
      const due = e.frontmatter.dueDate;
      return status !== "done" && due;
    })
    .map((e) => {
      const due = String(e.frontmatter.dueDate);
      return { e, t: new Date(due).getTime() };
    })
    .filter((x) => x.t < Date.now())
    .map((x) => ({
      id: String(x.e.frontmatter.id ?? ""),
      title: String(x.e.frontmatter.title ?? ""),
      dueDate: String(x.e.frontmatter.dueDate ?? ""),
      daysOverdue: Math.ceil((Date.now() - x.t) / DAY),
    }));

  return { maintenance, todos };
}

/** 推送桌面通知 */
function pushReminders(bundle: ReminderBundle): void {
  const total = bundle.maintenance.length + bundle.todos.length;
  if (total === 0) return;

  const lines: string[] = [];
  if (bundle.maintenance.length > 0) {
    lines.push(`${bundle.maintenance.length} 个维保即将到期`);
    for (const m of bundle.maintenance.slice(0, 3)) {
      lines.push(`  · ${m.customer} ${m.product}（剩 ${m.daysLeft} 天）`);
    }
  }
  if (bundle.todos.length > 0) {
    lines.push(`${bundle.todos.length} 个待办已逾期`);
    for (const t of bundle.todos.slice(0, 3)) {
      lines.push(`  · ${t.title}（逾期 ${t.daysOverdue} 天）`);
    }
  }

  if (Notification.isSupported()) {
    const n = new Notification({
      title: "Workbench 提醒",
      body: lines.join("\n"),
      silent: false,
    });
    n.show();
  }
}

/**
 * 每日定时调度器。
 * start() 后到设定时间（默认 09:00）跑一次，之后每 24h 一次。
 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(
    private readonly getWorkspacePath: () => string | null,
    private readonly checkTime: string = "09:00",
    private readonly leadDays: number = 30,
  ) {}

  start(): void {
    this.stop();
    const parts = this.checkTime.split(":").map(Number);
    const rawHh = parts[0] ?? NaN;
    const rawMm = parts[1] ?? NaN;
    const hh = Number.isFinite(rawHh) ? rawHh : 9;
    const mm = Number.isFinite(rawMm) ? rawMm : 0;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);

    const myGeneration = ++this.generation;
    const delay = next.getTime() - now.getTime();
    // B-12：回调内吞异常，保证后续 setInterval 一定建立（否则一次失败就让每日提醒永久静默死亡）
    const safeRun = () => {
      try {
        this.runOnce();
      } catch (error) {
        console.error("[scheduler] 检查失败（本轮跳过）:", error);
      }
    };
    this.timer = setTimeout(async () => {
      safeRun();
      if (myGeneration !== this.generation) return;
      this.timer = setInterval(safeRun, 86400000) as unknown as NodeJS.Timeout;
    }, delay) as unknown as NodeJS.Timeout;
    console.log(`[scheduler] 下次提醒检查: ${next.toLocaleString()}`);
  }

  /** 立即跑一次检查（手动触发/测试用） */
  runOnce(): ReminderBundle {
    const cwd = this.getWorkspacePath();
    if (!cwd) return { maintenance: [], todos: [] };
    const bundle = computeReminders(cwd, this.leadDays);
    pushReminders(bundle);
    console.log(`[scheduler] 检查完成: ${bundle.maintenance.length} 维保提醒, ${bundle.todos.length} 逾期待办`);
    return bundle;
  }

  stop(): void {
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = null; }
  }
}
