/**
 * 工具进度广播：main 进程 → renderer。
 *
 * 长工具（init_workspace 等）在主进程执行，通过这里把阶段/进度
 * 推给所有 BrowserWindow，渲染层顶部显示进度条。
 * 任何失败都静默（进度显示是锦上添花，不能影响工具执行）。
 */
import type { BrowserWindow } from "electron";

export interface ToolProgressPayload {
  tool: string;
  phase: string;
  current: number;
  total: number;
  message?: string;
}

let windowsProvider: () => BrowserWindow[] = () => [];

/** 注入窗口列表获取器（main.ts 启动时调用） */
export function setProgressWindowsProvider(provider: () => BrowserWindow[]): void {
  windowsProvider = provider;
}

/** 推送一条进度到所有窗口 */
export function emitToolProgress(payload: ToolProgressPayload): void {
  try {
    for (const win of windowsProvider()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("workbench:tool-progress", payload);
    }
  } catch { /* ignore */ }
}
