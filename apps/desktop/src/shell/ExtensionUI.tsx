import { useState, useEffect, type ReactNode } from "react";
import { X, Check } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

interface HostUiRequest {
  kind: "confirm" | "input" | "select" | "editor";
  requestId: string;
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  options?: readonly string[];
  allowMultiple?: boolean;
  defaultValue?: boolean;
}

interface Props {
  state: DesktopAppState;
}

/**
 * 扩展 UI 对话框渲染器。
 * 监听 sessionExtensionUiBySession 中的 hostUiRequest，弹出对应对话框。
 * 用户响应后调 respondToHostUiRequest 回传。
 */
export function ExtensionDialogs({ state }: Props) {
  const [request, setRequest] = useState<HostUiRequest | null>(null);

  useEffect(() => {
    // 从当前 session 的 extension UI state 中取 pending request
    const key = state.selectedWorkspaceId && state.selectedSessionId
      ? `${state.selectedWorkspaceId}:${state.selectedSessionId}`
      : "";
    const uiState = state.sessionExtensionUiBySession[key];
    const pending = uiState?.pendingDialogs[0];
    if (pending) {
      setRequest(pending as HostUiRequest);
    } else {
      setRequest(null);
    }
  }, [state.sessionExtensionUiBySession, state.selectedWorkspaceId, state.selectedSessionId, state.revision]);

  const respond = async (response: Record<string, unknown>) => {
    if (!request || !state.selectedWorkspaceId || !state.selectedSessionId) return;
    try {
      await window.piApp.respondToHostUiRequest(
        state.selectedWorkspaceId,
        state.selectedSessionId,
        { requestId: request.requestId, ...response } as any,
      );
    } catch (e) {
      console.error("[ext-ui] 响应失败:", e);
    }
    setRequest(null);
  };

  if (!request) return null;

  if (request.kind === "confirm") {
    return (
      <DialogOverlay title={request.title} onClose={() => respond({ cancelled: true })}>
        <p className="ext-dialog-message">{request.message}</p>
        <DialogActions>
          <button className="btn-ghost" onClick={() => respond({ confirmed: false })}>取消</button>
          <button className="btn-primary" onClick={() => respond({ confirmed: true })}><Check size={12} /> 确认</button>
        </DialogActions>
      </DialogOverlay>
    );
  }

  if (request.kind === "input") {
    return <InputDialog request={request} respond={respond} />;
  }

  if (request.kind === "select") {
    return <SelectDialog request={request} respond={respond} />;
  }

  if (request.kind === "editor") {
    return <EditorDialog request={request} respond={respond} />;
  }

  return null;
}

function InputDialog({ request, respond }: { request: HostUiRequest; respond: (r: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(request.initialValue ?? "");
  return (
    <DialogOverlay title={request.title} onClose={() => respond({ cancelled: true })}>
      <input
        className="api-key-input"
        style={{ width: "100%", margin: "8px 0" }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={request.placeholder}
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") respond({ value }); }}
      />
      <DialogActions>
        <button className="btn-ghost" onClick={() => respond({ cancelled: true })}>取消</button>
        <button className="btn-primary" onClick={() => respond({ value })}>确认</button>
      </DialogActions>
    </DialogOverlay>
  );
}

function SelectDialog({ request, respond }: { request: HostUiRequest; respond: (r: Record<string, unknown>) => void }) {
  const [selected, setSelected] = useState<string>("");
  return (
    <DialogOverlay title={request.title} onClose={() => respond({ cancelled: true })}>
      <div className="ext-select-list">
        {(request.options ?? []).map((opt) => (
          <div
            key={opt}
            className={`ext-select-item ${selected === opt ? "active" : ""}`}
            onClick={() => setSelected(opt)}
            onDoubleClick={() => respond({ value: opt })}
          >
            {opt}
          </div>
        ))}
      </div>
      <DialogActions>
        <button className="btn-ghost" onClick={() => respond({ cancelled: true })}>取消</button>
        <button className="btn-primary" disabled={!selected} onClick={() => respond({ value: selected })}>确认</button>
      </DialogActions>
    </DialogOverlay>
  );
}

function EditorDialog({ request, respond }: { request: HostUiRequest; respond: (r: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(request.initialValue ?? "");
  return (
    <DialogOverlay title={request.title} onClose={() => respond({ cancelled: true })} wide>
      <textarea
        className="prompt-editor"
        style={{ minHeight: 240 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        spellCheck={false}
      />
      <DialogActions>
        <button className="btn-ghost" onClick={() => respond({ cancelled: true })}>取消</button>
        <button className="btn-primary" onClick={() => respond({ value })}><Check size={12} /> 确认</button>
      </DialogActions>
    </DialogOverlay>
  );
}

function DialogOverlay({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="archive-overlay" onClick={onClose}>
      <div className="archive-modal" style={{ width: wide ? 560 : 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="archive-header">
          <h2>{title}</h2>
          <button className="archive-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

function DialogActions({ children }: { children: ReactNode }) {
  return <div className="form-actions" style={{ marginTop: 16 }}>{children}</div>;
}
