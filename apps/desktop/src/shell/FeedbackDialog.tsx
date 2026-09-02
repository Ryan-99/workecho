import { useEffect, useState } from "react";
import { Bug, Lightbulb, Smile, MessageSquare, Loader, Check, ClipboardCopy, X } from "lucide-react";
import { collectPastedFiles } from "../composer-paste";
import type { DesktopAppState } from "../desktop-state";

type Kind = "bug" | "suggestion" | "ux" | "other";

const KINDS: Array<{ id: Kind; label: string; icon: React.ReactNode }> = [
  { id: "bug", label: "问题/BUG", icon: <Bug size={13} /> },
  { id: "suggestion", label: "功能建议", icon: <Lightbulb size={13} /> },
  { id: "ux", label: "体验问题", icon: <Smile size={13} /> },
  { id: "other", label: "其他", icon: <MessageSquare size={13} /> },
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 用户反馈弹窗：类型 + 描述 + 粘贴截图 + 诊断信息透明预览。
 * 通道为企业微信机器人（主进程配置），未配置时本地留底 + 一键复制。
 */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("bug");
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ base64: string; dataUrl: string } | null>(null);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [diagnostics, setDiagnostics] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    window.piApp.getFeedbackDiagnostics().then(setDiagnostics).catch(() => setDiagnostics("（诊断信息不可用）"));
  }, []);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = collectPastedFiles(e.clipboardData ?? null);
    const img = files.find((f) => f.type.startsWith("image/"));
    if (!img) return;
    e.preventDefault();
    if (img.size > 2 * 1024 * 1024) {
      setResult({ ok: false, message: "截图超过 2MB，请裁剪后再贴" });
      return;
    }
    const buf = new Uint8Array(await img.arrayBuffer());
    const base64 = bytesToBase64(buf);
    setImage({ base64, dataUrl: `data:${img.type};base64,${base64}` });
  };

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setResult(null);
    try {
      const r = await window.piApp.submitFeedback({
        kind,
        text,
        includeDiagnostics,
        imageBase64: image?.base64,
      });
      setResult({ ok: r.ok, message: r.message });
      if (r.ok && r.channel === "wecom") {
        setTimeout(onClose, 1400);
      }
    } catch (e) {
      setResult({ ok: false, message: `发送失败：${(e as Error).message}` });
    } finally {
      setSending(false);
    }
  };

  const copyContent = () => {
    const content = `【Workecho 反馈｜${KINDS.find((k) => k.id === kind)?.label}】\n${text}\n\n${includeDiagnostics ? diagnostics : ""}`;
    navigator.clipboard.writeText(content).catch(() => {});
    setResult({ ok: true, message: "已复制，粘贴给维护者即可" });
  };

  return (
    <div className="app-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-dialog feedback-dialog">
        <button className="app-dialog__close" onClick={onClose} title="关闭"><X size={14} /></button>
        <div className="app-dialog__message">反馈</div>
        <div className="app-dialog__detail">描述问题或建议，直达维护者。</div>

        <div className="feedback-kinds">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`feedback-kind ${kind === k.id ? "active" : ""}`}
              onClick={() => setKind(k.id)}
            >{k.icon}{k.label}</button>
          ))}
        </div>

        <textarea
          className="feedback-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { void handlePaste(e); }}
          placeholder="描述你遇到的问题或建议（可直接 Ctrl+V 粘贴截图）"
          rows={4}
          autoFocus
        />

        {image && (
          <div className="feedback-shot">
            <img src={image.dataUrl} alt="反馈截图" />
            <button type="button" title="移除截图" onClick={() => setImage(null)}>×</button>
          </div>
        )}

        <label className="feedback-diag-toggle">
          <input
            type="checkbox"
            checked={includeDiagnostics}
            onChange={(e) => setIncludeDiagnostics(e.target.checked)}
          />
          附带诊断信息（版本/平台/最近异常，不含会话内容）
        </label>
        {includeDiagnostics && (
          <pre className="feedback-diag-preview">{diagnostics || "…"}</pre>
        )}

        {result && <div className={`feedback-result ${result.ok ? "ok" : "bad"}`}>{result.message}</div>}

        <div className="feedback-actions">
          <button type="button" className="app-dialog__btn" onClick={copyContent} disabled={!text.trim()}>
            <ClipboardCopy size={12} /> 复制内容
          </button>
          <button
            type="button"
            className="app-dialog__btn primary"
            onClick={() => { void submit(); }}
            disabled={sending || !text.trim()}
          >
            {sending ? <Loader size={12} className="spin" /> : <Check size={12} />} 发送反馈
          </button>
        </div>
      </div>
    </div>
  );
}
