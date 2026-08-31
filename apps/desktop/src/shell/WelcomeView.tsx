import { useState, useEffect } from "react";
import { MessageCircle, ArrowUp, Paperclip } from "lucide-react";
import { collectPastedFiles, filesToComposerAttachments } from "../composer-paste";
import type { DesktopAppState } from "../desktop-state";

interface Props {
  onSend: (text: string) => void;
  state: DesktopAppState;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function WelcomeView({ onSend, state }: Props) {
  const [text, setText] = useState("");

  // 粘贴截图/文件与 ChatPanel 同逻辑（截图位图藏在 clipboardData.items）
  const submitPasted = async (e: React.ClipboardEvent | ClipboardEvent) => {
    const files = collectPastedFiles(e.clipboardData ?? null);
    if (files.length === 0) return;
    e.preventDefault();
    const attachments = await filesToComposerAttachments(files, {
      getPathForFile: window.piApp.getPathForFile,
      bytesToBase64,
      maxImageBytes: 5 * 1024 * 1024,
    });
    if (attachments.length > 0) {
      try { await window.piApp.addComposerAttachments(attachments); } catch { /* 静默 */ }
    }
  };

  // 焦点兜底：切窗后直接 Ctrl+V 时焦点不在 textarea——document 捕获兜住
  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      void submitPasted(e);
    };
    document.addEventListener("paste", onDocPaste, true);
    return () => document.removeEventListener("paste", onDocPaste, true);
  }, []);

  const handleSend = () => {
    const t = text.trim();
    // 与 ChatPanel 一致：仅附件（无文字）也可发送
    if (!t && state.composerAttachments.length === 0) return;
    setText("");
    onSend(t);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-content">
        <MessageCircle size={40} className="welcome-icon" />
        <h1 className="welcome-title">有什么可以帮你？</h1>
        <p className="welcome-hint">
          试试："这周有哪些维保快到期？""帮我看看 OKR 进展""给招行追加一条跟进记录"
        </p>
        <div className="composer">
          {/* 与 ChatPanel 相同的卡片结构：surface → editor → footer */}
          <div className="composer__surface">
            {state.composerAttachments.length > 0 && (
              <div className="composer-chips">
                {state.composerAttachments.filter((a) => a.kind === "image").map((a) => (
                  <div key={a.id} className="composer-image-card" title={a.name}>
                    <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                    <button
                      type="button"
                      className="composer-image-card__remove"
                      title="移除图片"
                      onClick={() => window.piApp.removeComposerAttachment(a.id).catch(() => {})}
                    >×</button>
                  </div>
                ))}
                {state.composerAttachments.filter((a) => a.kind !== "image").map((a) => (
                  <div key={a.id} className="composer-chip composer-chip--file" title={a.name}>
                    <Paperclip size={11} />
                    <span className="composer-chip__name">{a.name}</span>
                    <button
                      type="button"
                      className="composer-chip__remove"
                      title="移除附件"
                      onClick={() => window.piApp.removeComposerAttachment(a.id).catch(() => {})}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer__editor">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={(e) => { void submitPasted(e); }}
                placeholder="问点什么…"
                rows={1}
                autoFocus
              />
            </div>
            <div className="composer__footer">
              <div className="composer__footer-row">
                <span className="welcome-composer-hint">Enter 发送，Shift+Enter 换行</span>
                <div className="composer__footer-right">
                  <button className="composer__send" onClick={handleSend} disabled={!text.trim() && state.composerAttachments.length === 0} title="发送"><ArrowUp size={18} /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
