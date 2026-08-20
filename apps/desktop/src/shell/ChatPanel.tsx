import { useState, useEffect, useRef, useCallback, type RefObject } from "react";
import { ArrowUp, Square, Paperclip, FileText, Plus, Sparkles, FileEdit, ChevronDown, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopAppState, SelectedTranscriptRecord } from "../desktop-state";
import type { SessionTranscriptMessage, SessionTranscriptToolCall } from "@pi-gui/pi-sdk-driver";
import type { ChangedFilesResult, ChangedFileEntry } from "../ipc";
import { ModelSelector } from "./ModelSelector";
import { ContextMeterIcon, SchemaBanner } from "./AgentFeatures";
import { QueuedMessages } from "./ChatExtras";
import { TerminalPanel } from "./TerminalPanel";

/** 终端容器：控制出现/消失动画 */
function TerminalSlot({ show, state }: { show: boolean; state: DesktopAppState }) {
  const [render, setRender] = useState(show);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (show) {
      setRender(true);
      setClosing(false);
    } else if (render) {
      setClosing(true);
      const timer = setTimeout(() => { setRender(false); setClosing(false); }, 300);
      return () => clearTimeout(timer);
    }
  }, [show]);

  if (!render) return null;
  return <div className={closing ? "terminal-slot closing" : "terminal-slot"}><TerminalPanel state={state} /></div>;
}
import { SlashMenu } from "./SlashMenu";

interface Props {
  state: DesktopAppState;
  transcript: SelectedTranscriptRecord | null;
  sending: boolean;
  showTerminal?: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  onStateRefresh?: (s: DesktopAppState) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function ChatPanel({ state, transcript, sending, showTerminal, onSend, onCancel, onStateRefresh, scrollRef }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const items = transcript?.transcript ?? [];

  // 滚到底部（消息变化或终端开关时）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, showTerminal, scrollRef]);

  // 自动调整高度（codex：min 24px，内容多了增高，封顶 220px）
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "24px";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  }, []);

  useEffect(() => { autoResize(); }, [text, autoResize]);

  const handleSubmit = () => {
    const t = text.trim();
    if (!t || sending) return;
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "24px";
    onSend(t);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="chat-panel">
      <SchemaBanner state={state} />
      <QueuedMessages state={state} />
      <ChangesBar workspaceId={state.selectedWorkspaceId} />
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {items.map((item, i) => renderItem(item, i))}
          {state.lastError && (
            <div className="msg assistant"><div className="bubble error-bubble">{state.lastError}</div></div>
          )}
        </div>
      </div>
      <div className="composer">
        {/* Codex 1:1 结构：圆角卡片 surface → editor(textarea) → footer(模型+发送) */}
        <div className="composer__surface">
          <div className="composer__editor">
            <SlashMenu text={text} textareaRef={textareaRef} runtimeCommands={state.sessionCommandsBySession[`${state.selectedWorkspaceId}:${state.selectedSessionId}`]} />
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => { setText(e.target.value); autoResize(); }}
              onKeyDown={handleKeyDown}
              placeholder="给 workbench 助手发消息"
              rows={1}
            />
          </div>
          <div className="composer__footer">
            <div className="composer__footer-row">
              <ModelSelector state={state} />
              <div className="composer__footer-right">
                <ContextMeterIcon state={state} />
                <button
                  className="composer__icon-btn"
                  onClick={() => window.piApp.pickComposerAttachments().catch(() => {})}
                  title="附件"
                  disabled={sending}
                ><Paperclip size={16} /></button>
                {sending ? (
                  <button className="composer__send composer__send--stop" onClick={onCancel} title="停止">
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    className="composer__send"
                    onClick={handleSubmit}
                    disabled={!text.trim()}
                    title="发送"
                  ><ArrowUp size={18} /></button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <TerminalSlot show={!!showTerminal} state={state} />
    </div>
  );
}

function renderItem(item: unknown, index: number): React.ReactNode {
  const it = item as any;
  if (it.kind === "message") return <MessageView key={it.id ?? index} msg={it as SessionTranscriptMessage} />;
  if (it.kind === "tool") return <ToolCallView key={it.id ?? index} call={it as SessionTranscriptToolCall} />;
  if (it.kind === "summary" || it.kind === "activity") return <ActivityView key={it.id ?? index} item={it} />;
  return null;
}

function MessageView({ msg }: { msg: SessionTranscriptMessage }) {
  if (msg.role === "user") {
    return <div className="msg user"><div className="bubble user-bubble">{msg.text}</div></div>;
  }
  // assistant / branchSummary / compactionSummary：无气泡，直接在背景上
  if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
    return (
      <div className="msg summary-msg">
        <div className="summary-eyebrow">{msg.role === "compactionSummary" ? "上下文压缩" : "分支摘要"}</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="msg assistant-msg">
      {msg.text ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        : <div className="thinking"><span className="dot" /><span className="dot" /><span className="dot" /></div>}
    </div>
  );
}

/** 工具调用：Codex 风格——无框，图标 + 可折叠行 */
function ToolCallView({ call }: { call: SessionTranscriptToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = call.input !== undefined || call.output !== undefined;
  const label = buildToolLabel(call);
  const glyph = toolGlyph(call.toolName);

  return (
    <div className={`timeline-tool timeline-tool--${call.status}`}>
      <div className="timeline-tool__header-row">
        <span className="timeline-tool__glyph">{glyph}</span>
        <button
          className="timeline-tool__header"
          type="button"
          disabled={!hasContent}
          onClick={() => setExpanded(!expanded)}
        >
          {hasContent && <span className={`timeline-tool__chevron ${expanded ? "expanded" : ""}`}>▸</span>}
          <span className="timeline-tool__label">{label}</span>
          <span className="timeline-tool__meta">
            <span className={`timeline-tool__status-pip status-${call.status}`} />
            {call.toolName} · {call.status === "success" ? "完成" : call.status === "error" ? "失败" : "运行中"}
          </span>
        </button>
      </div>
      {expanded && hasContent && (
        <div className="timeline-tool__body">
          {call.input != null && (
            <div className="tool-section">
              <div className="tool-section-title">输入</div>
              <pre>{typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2)}</pre>
            </div>
          )}
          {call.output != null && (
            <div className="tool-section">
              <div className="tool-section-title">输出</div>
              <pre>{typeof call.output === "string" ? call.output : JSON.stringify(call.output, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** activity/summary：轻量行内显示（思考、压缩等过程） */
function ActivityView({ item }: { item: any }) {
  return (
    <div className={`timeline-activity ${item.tone ? `tone-${item.tone}` : ""}`}>
      <span className="timeline-activity__label">{item.label}</span>
      {item.detail && <span className="timeline-activity__detail">{item.detail}</span>}
    </div>
  );
}

/** 工具图标（按名称匹配） */
function toolGlyph(toolName: string) {
  const name = toolName.toLowerCase();
  if (name.includes("query") || name.includes("read") || name.includes("list")) return <FileText size={14} />;
  if (name.includes("add") || name.includes("create") || name.includes("write")) return <Plus size={14} />;
  return <Sparkles size={14} />;
}

/** 紧凑标签 */
function buildToolLabel(call: SessionTranscriptToolCall): string {
  const i = call.input as any;
  if (i?.customer) return `查询 ${i.customer}`;
  if (i?.status) return `按状态过滤: ${i.status}`;
  if (i?.type) return `读取 ${i.type}/${i.id ?? ""}`;
  if (i?.title) return `添加: ${i.title}`;
  return call.toolName;
}

/** 文件变更条：有变更时在对话顶部显示可折叠条 */
function ChangesBar({ workspaceId }: { workspaceId: string }) {
  const [files, setFiles] = useState<ChangedFilesResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedDiff, setSelectedDiff] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const fetch = async () => {
      try {
        const result = await window.piApp.getChangedFiles(workspaceId);
        if (active) setFiles(result);
      } catch {}
    };
    fetch();
    const timer = setInterval(fetch, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [workspaceId]);

  const changedFiles = files?.state === "available" ? files.files : [];
  if (changedFiles.length === 0) return null;

  const handleViewDiff = async (filePath: string) => {
    if (selectedDiff === filePath) {
      setSelectedDiff(null);
      setDiffContent(null);
      return;
    }
    setSelectedDiff(filePath);
    setDiffContent(null);
    try {
      const d = await window.piApp.getFileDiff(workspaceId, filePath);
      setDiffContent(d);
    } catch { setDiffContent("无法获取 diff"); }
  };

  return (
    <div className="changes-bar">
      <button className="changes-bar-header" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FileEdit size={13} />
        <span>{changedFiles.length} 个文件变更</span>
      </button>
      {expanded && (
        <div className="changes-bar-list">
          {changedFiles.map((f) => (
            <div key={f.path} className={`change-row ${selectedDiff === f.path ? "active" : ""}`} onClick={() => handleViewDiff(f.path)}>
              <span className={`change-status status-${f.status}`}>{f.status.charAt(0).toUpperCase()}</span>
              <span className="change-path">{f.path}</span>
            </div>
          ))}
        </div>
      )}
      {selectedDiff && diffContent !== null && (
        <pre className="change-diff">{diffContent}</pre>
      )}
    </div>
  );
}
