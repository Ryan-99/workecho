/**
 * 应用内弹窗系统（统一替代原生 dialog / window.alert / 独立 prompt 窗口）。
 *
 * 主进程发起（登录提示、更新检查等）经 "workbench:app-dialog" 事件到达；
 * 渲染层代码直接调 openAppDialog()。同一时间只显示一个，排队等待。
 * 样式与应用一致：深色卡片、无系统标题栏、无 OS 默认按钮。
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export interface AppDialogSpec {
  /** 主进程发起时携带，回传结果用 */
  id?: number;
  kind: "alert" | "confirm" | "prompt";
  message: string;
  detail?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface AppDialogResult {
  ok: boolean;
  value?: string;
}

type HostPush = (spec: AppDialogSpec, respond: (r: AppDialogResult) => void) => void;

let hostPush: HostPush | null = null;
const queue: Array<{ spec: AppDialogSpec; resolve: (r: AppDialogResult) => void }> = [];
let busy = false;

export function registerDialogHost(push: HostPush | null): void {
  hostPush = push;
  pump();
}

/** 渲染层直接使用：确认框 / 提示框 / 输入框 */
export function openAppDialog(spec: AppDialogSpec): Promise<AppDialogResult> {
  return new Promise((resolve) => {
    queue.push({ spec, resolve });
    pump();
  });
}

export const appConfirm = (message: string, opts: Partial<AppDialogSpec> = {}) =>
  openAppDialog({ kind: "confirm", message, ...opts }).then((r) => r.ok);
export const appAlert = (message: string, opts: Partial<AppDialogSpec> = {}) =>
  openAppDialog({ kind: "alert", message, ...opts });
export const appPrompt = (message: string, opts: Partial<AppDialogSpec> = {}) =>
  openAppDialog({ kind: "prompt", message, ...opts });

function pump(): void {
  if (busy || !hostPush || queue.length === 0) return;
  busy = true;
  const item = queue.shift()!;
  hostPush(item.spec, (r) => {
    busy = false;
    item.resolve(r);
    pump();
  });
}

/* ============ Host 组件（挂在 App 根部） ============ */

export function DialogHost() {
  const [spec, setSpec] = useState<AppDialogSpec | null>(null);
  const [value, setValue] = useState("");
  const respondRef = useRef<((r: AppDialogResult) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerDialogHost((next, respond) => {
      setSpec(next);
      setValue(next.defaultValue ?? "");
      respondRef.current = respond;
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    // 主进程发起的弹窗
    const api = (window as any).piApp;
    const off = api?.onAppDialog?.((incoming: AppDialogSpec) => {
      openAppDialog(incoming).then((r) => {
        if (incoming.id !== undefined) {
          api.appDialogResult?.(incoming.id, r).catch(() => undefined);
        }
      });
    });
    return () => {
      registerDialogHost(null);
      off?.();
    };
  }, []);

  if (!spec) return null;

  const finish = (ok: boolean) => {
    const r: AppDialogResult = ok
      ? { ok: true, ...(spec.kind === "prompt" ? { value } : {}) }
      : { ok: false };
    respondRef.current?.(r);
    respondRef.current = null;
    setSpec(null);
  };

  const isAlert = spec.kind === "alert";
  const confirmLabel = spec.confirmText ?? (isAlert ? "知道了" : "确认");
  const cancelLabel = spec.cancelText ?? (isAlert ? "" : "取消");

  return (
    <div className="app-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}>
      <div
        className="app-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(false);
          if (e.key === "Enter" && spec.kind !== "confirm") finish(true);
        }}
      >
        <div className="app-dialog__message">{spec.message}</div>
        {spec.detail && <div className="app-dialog__detail">{spec.detail}</div>}
        {spec.kind === "prompt" && (
          <input
            ref={inputRef}
            className="app-dialog__input"
            value={value}
            placeholder={spec.placeholder ?? ""}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        )}
        <div className="app-dialog__actions">
          {!isAlert && cancelLabel && (
            <button className="app-dialog__btn" onClick={() => finish(false)}>{cancelLabel}</button>
          )}
          <button
            className={`app-dialog__btn primary${spec.danger ? " danger" : ""}`}
            onClick={() => finish(true)}
            autoFocus={spec.kind !== "prompt"}
          >
            {confirmLabel}
          </button>
        </div>
        {!isAlert && <button className="app-dialog__close" onClick={() => finish(false)} title="关闭"><X size={14} /></button>}
      </div>
    </div>
  );
}
