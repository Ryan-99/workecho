import { useState } from "react";
import { MessageCircle, ArrowUp } from "lucide-react";

interface Props {
  onSend: (text: string) => void;
}

export function WelcomeView({ onSend }: Props) {
  const [text, setText] = useState("");

  const handleSend = () => {
    const t = text.trim();
    if (!t) return;
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
            <div className="composer__editor">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="问点什么…"
                rows={1}
                autoFocus
              />
            </div>
            <div className="composer__footer">
              <div className="composer__footer-row">
                <span className="welcome-composer-hint">Enter 发送，Shift+Enter 换行</span>
                <div className="composer__footer-right">
                  <button className="composer__send" onClick={handleSend} disabled={!text.trim()} title="发送"><ArrowUp size={18} /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
