import { useState, useEffect, useRef, useCallback, type RefObject } from "react";
import { ArrowUp, Square, Paperclip, FileEdit, FileText, AtSign, Minimize2, ChevronDown, ChevronRight, ListChecks, RotateCcw, Plus, Sparkles } from "lucide-react";
import type { DesktopAppState, SelectedTranscriptRecord, ComposerAttachment } from "../desktop-state";
import type { ChangedFilesResult, ChangedFileEntry } from "../ipc";
import { ModelSelector } from "./ModelSelector";
import { ContextMeterIcon, SchemaBanner } from "./AgentFeatures";
import { QueuedMessages } from "./ChatExtras";
import { TerminalPanel } from "./TerminalPanel";
import { renderTimelineItems } from "./TranscriptTimeline";

/** 粘贴/拖放图片的大小上限（与主进程剪贴板限制同量级） */
const MAX_PASTE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Uint8Array → base64（分块避免 String.fromCharCode 栈溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function collectFiles(list: FileList | undefined | null): readonly File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => f.size > 0);
}

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
import { ImageLightbox } from "./ImageLightbox";
import { collectPastedFiles, filesToComposerAttachments } from "../composer-paste";
import { appConfirm, appAlert } from "./app-dialog";

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
  // R-14：草稿按会话隔离——切会话时保存当前草稿、恢复目标会话的草稿，
  // 而不是让 A 会话的未发文字泄漏到 B 会话输入框
  const draftsRef = useRef<Map<string, string>>(new Map());
  const sessionKey = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
  const [text, setText] = useState("");
  const prevSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    if (prevSessionKeyRef.current === sessionKey) return;
    // 会话切换：暂存旧会话草稿 → 恢复新会话草稿
    draftsRef.current.set(prevSessionKeyRef.current, text);
    prevSessionKeyRef.current = sessionKey;
    setText(draftsRef.current.get(sessionKey) ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);
  const [planOn, setPlanOn] = useState(false);
  /** 已加载技能胶囊：/ 菜单选中 skill 后挂起，发送时自动拼 `/skill:name ` 前缀 */
  const [skillChip, setSkillChip] = useState<{ command: string; label: string } | null>(null);
  /** 图片大图预览（双击缩略卡打开） */
  const [zoomImage, setZoomImage] = useState<{ src: string; name?: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const items = transcript?.transcript ?? [];

  // 切换会话：直接落到最新位置（无滑动动画）
  const sessionId = state.selectedSessionId;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId, scrollRef]);

  // 计划模式状态跟随主进程（工作区隔离）
  useEffect(() => {
    window.piApp.getPlanMode().then(setPlanOn).catch(() => {});
  }, [state.selectedWorkspaceId]);

  // 滚动跟随：流式输出（同一条消息的 delta 不改变 items.length）也要跟随最新内容；
  // 用户上翻阅读时不强制拽底（距底 > 120px 视为在阅读），只在接近底部时 pin 住
  const transcriptTick = transcript?.transcript?.length
    ? `${items.length}:${transcript.transcript[transcript.transcript.length - 1]?.kind === "message" ? String((transcript.transcript[transcript.transcript.length - 1] as { text?: string }).text ?? "").length : 0}`
    : "0";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptTick, showTerminal, scrollRef]);

  // 自动调整高度（codex：min 24px，内容多了增高，封顶 220px）
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "24px";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  }, []);

  useEffect(() => { autoResize(); }, [text, autoResize]);

  /** 压缩当前会话（+ 菜单与 /compact 命令共用） */
  const handleCompact = async () => {
    const ok = await appConfirm("压缩会话上下文？历史消息将被摘要替代，释放上下文空间。");
    if (!ok) return;
    try {
      const st = await window.piApp.compactSession();
      if (st) onStateRefresh?.(st);
    } catch (e) {
      appAlert(`压缩失败: ${(e as Error).message}`);
    }
  };

  /** 菜单类受控写入：setText 后下一帧恢复光标并聚焦 */
  const applyMenuText = (next: string, caret?: number) => {
    setText(next);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      if (typeof caret === "number") ta.setSelectionRange(caret, caret);
      ta.focus();
    });
  };

  /** 菜单选择完整命令后直接发送执行 */
  const sendText = (t: string) => {
    if (!t.trim() || sending) return;
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "24px";
    onSend(t);
  };

  const handleSubmit = () => {
    const t = text.trim();
    // slash 模糊输入拦截：/thin 这类前缀有唯一候选时先补全（否则会当聊天发给模型）
    if (t.startsWith("/") && !t.includes(" ")) {
      const cmds = slashCommandCandidates(state, state.selectedWorkspaceId, state.selectedSessionId);
      const starts = cmds.filter((c) => c.command.startsWith(t));
      const hit = cmds.find((c) => c.command === t) ?? (starts.length === 1 ? starts[0] : undefined);
      if (hit && hit.command !== t) {
        applyMenuText(`${hit.command} `, hit.command.length + 1);
        return;
      }
    }
    // 已加载技能胶囊：发送文本自动拼技能调用前缀（仅附件也可发送，U-07）
    if (skillChip) {
      if ((!t && state.composerAttachments.length === 0) || sending) return;
      const outgoing = `${skillChip.command} ${t}`;
      setSkillChip(null);
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "24px";
      onSend(outgoing);
      return;
    }
    // 有文字或有附件（粘贴的图片/文件）都可发送；技能胶囊挂起时附件路径同样拼技能前缀
    if ((!t && state.composerAttachments.length === 0) || sending) return;
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

  // 粘贴/拖放：图片转 base64 附件，文件经 webUtils 取真实路径
  const handlePaste = async (e: React.ClipboardEvent) => {
    // 截图位图在 clipboardData.items（files 为空），公共模块统一处理
    const files = collectPastedFiles(e.clipboardData ?? null);
    if (files.length === 0) return;
    e.preventDefault();
    await addPastedFiles(files);
  };

  // 焦点兜底：从截图工具切回窗口直接 Ctrl+V 时，焦点往往不在 textarea
  // （paste 落在 body，textarea 的 onPaste 收不到）——document 捕获态兜住
  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
        return; // 输入框自身的 onPaste 已处理
      }
      const files = collectPastedFiles(e.clipboardData ?? null);
      if (files.length === 0) return;
      e.preventDefault();
      void addPastedFiles(files);
    };
    document.addEventListener("paste", onDocPaste, true);
    return () => document.removeEventListener("paste", onDocPaste, true);
  }, []);

  const handleDrop = async (e: React.DragEvent) => {
    const files = collectFiles(e.dataTransfer?.files);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    await addPastedFiles(files);
  };

  const addPastedFiles = async (files: readonly File[]) => {
    const attachments = await filesToComposerAttachments(files, {
      getPathForFile: window.piApp.getPathForFile,
      bytesToBase64,
      maxImageBytes: MAX_PASTE_IMAGE_BYTES,
    });
    if (attachments.length > 0) {
      try { await window.piApp.addComposerAttachments(attachments); } catch { /* 静默 */ }
    };
  };

  return (
    <div className="chat-panel">
      <SchemaBanner state={state} />
      <QueuedMessages state={state} />
      <ChangesBar workspaceId={state.selectedWorkspaceId} />
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-inner">
          {renderTimelineItems(items)}
          {state.lastError && (
            <div className="msg assistant"><div className="bubble error-bubble">{state.lastError}</div></div>
          )}
        </div>
      </div>
      <div className="composer">
        {/* Codex 1:1 结构：圆角卡片 surface → editor(textarea) → footer(模型+发送) */}
        <div className="composer__surface" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
          {/* 附件预览条（粘贴/上传的图片与文件） */}
          {(skillChip || state.composerAttachments.length > 0) && (
            <div className="composer-chips">
              {state.composerAttachments.filter((a) => a.kind === "image").map((a) => (
                <div
                  key={a.id}
                  className="composer-image-card"
                  title={`${a.name ?? ""}（双击放大）`}
                  onDoubleClick={() => setZoomImage({ src: `data:${a.mimeType};base64,${a.data}`, name: a.name })}
                >
                  <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                  <button
                    type="button"
                    className="composer-image-card__remove"
                    title="移除图片"
                    onClick={() => window.piApp.removeComposerAttachment(a.id).catch(() => {})}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >×</button>
                </div>
              ))}
              {skillChip && (
                <div className="composer-chip composer-chip--skill composer-skill-chip" title={`技能 ${skillChip.command}`}>
                  <Sparkles size={11} />
                  <span className="composer-chip__name composer-skill-chip__name">{skillChip.label}</span>
                  <button
                    type="button"
                    className="composer-chip__remove composer-skill-chip__remove"
                    title="移除技能"
                    onClick={() => setSkillChip(null)}
                  >×</button>
                </div>
              )}
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
          {zoomImage && (
            <ImageLightbox src={zoomImage.src} alt={zoomImage.name} onClose={() => setZoomImage(null)} />
          )}
          <div className="composer__editor">
            <SlashMenu
              text={text}
              textareaRef={textareaRef}
              runtimeCommands={state.sessionCommandsBySession[`${state.selectedWorkspaceId}:${state.selectedSessionId}`]}
              runtimeSkills={state.runtimeByWorkspace[state.selectedWorkspaceId]?.skills ?? []}
              onSelect={(insertText, { send }) => {
                if (send) {
                  sendText(insertText.trim());
                } else {
                  applyMenuText(insertText, insertText.length);
                }
              }}
              onSkillPick={(command, label) => {
                setSkillChip({ command, label });
                setText("");
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              onLocalAction={(action) => {
                setText("");
                if (textareaRef.current) textareaRef.current.style.height = "24px";
                if (action.kind === "thinking") {
                  window.piApp
                    .setSessionThinkingLevel(
                      state.selectedWorkspaceId,
                      state.selectedSessionId ?? "",
                      action.level as Parameters<typeof window.piApp.setSessionThinkingLevel>[2],
                    )
                    .then((st) => onStateRefresh?.(st))
                    .catch((e) => appAlert(`设置思考级别失败: ${(e as Error).message}`));
                } else if (action.kind === "tree") {
                  window.dispatchEvent(new CustomEvent("open-tree-modal"));
                } else if (action.kind === "compact") {
                  void handleCompact();
                }
              }}
            />
            <AtFileMenu
              text={text}
              textareaRef={textareaRef}
              workspaceId={state.selectedWorkspaceId}
              onInsert={applyMenuText}
            />
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => { setText(e.target.value); autoResize(); }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                skillChip
                  ? `已加载技能「${skillChip.label}」，描述你的任务后发送`
                  : planOn
                    ? "计划模式：描述你的目标，助手将只读探索并给出行动方案，不会做任何修改"
                    : "给 Workecho 助手发消息"
              }
              rows={1}
            />
          </div>
          <div className="composer__footer">
            <div className="composer__footer-row">
              {/* 左：+ 操作面板（附件/引用文件/计划/压缩/技能命令）。只切状态或插入文字，绝不自动发送 */}
              <ComposerPlusMenu
                planOn={planOn}
                onPlanChange={setPlanOn}
                sending={sending}
                workspaceId={state.selectedWorkspaceId}
                onInsertText={(s) => {
                  setText((prev) => (prev && !prev.endsWith(" ") ? `${prev} ${s}` : prev ? prev + s : s));
                  requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              />
              <div className="composer__footer-right">
                <ContextMeterIcon state={state} />
                <ModelSelector state={state} />
                {sending ? (
                  <button className="composer__send composer__send--stop" onClick={onCancel} title="停止">
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    className="composer__send"
                    onClick={handleSubmit}
                    disabled={!text.trim() && state.composerAttachments.length === 0}
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

/** "@" 文件引用：输入 @ 唤出工作区文件过滤列表，Tab/点击把路径插入输入框（替换 @token） */
function AtFileMenu({ text, textareaRef, workspaceId, onInsert }: {
  text: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  workspaceId: string;
  /** 受控插入：由 ChatPanel setText 并恢复光标（直接改 DOM 会被 React 吞掉） */
  onInsert: (nextText: string, caret: number) => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const ta = textareaRef.current;
  const cursor = ta ? ta.selectionStart : text.length;
  const beforeCursor = text.slice(0, cursor);
  const tokenMatch = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  const query = tokenMatch?.[2] ?? null;
  const active = query !== null;

  useEffect(() => {
    if (!active || files !== null) return;
    window.piApp.listWorkspaceFiles(workspaceId)
      .then((list) => setFiles(list ?? []))
      .catch(() => setFiles([]));
  }, [active, files, workspaceId]);

  const filtered = active && files
    ? files.filter((f) => f.toLowerCase().includes(query!.toLowerCase())).slice(0, 10)
    : [];
  const filteredRef = useRef<string[]>([]);
  filteredRef.current = filtered;
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => { setSelectedIndex(0); }, [query]);
  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const insert = (file: string) => {
    const el = textareaRef.current;
    const cur = el ? el.selectionStart : text.length;
    const before = text.slice(0, cur);
    const after = text.slice(cur);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return;
    const start = before.length - m[2]!.length - 1;
    const next = text.slice(0, start) + file + " " + after;
    onInsert(next, start + file.length + 1);
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || !active || filtered.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const list = filteredRef.current;
      if (list.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        const f = list[selectedIndex];
        if (f) insert(f);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  });

  if (!active || files === null) return null;
  return (
    <div className="slash-menu at-file-menu">
      {filtered.length === 0 && <div className="slash-menu__item at-file-menu__empty">没有匹配的文件</div>}
      {filtered.map((f, i) => (
        <div
          key={f}
          ref={(el) => { itemRefs.current[i] = el; }}
          className={`slash-menu__item ${i === selectedIndex ? "active" : ""}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onMouseDown={(e) => { e.preventDefault(); insert(f); }}
        >
          <span className="slash-menu__cmd">@</span>
          <span className="at-file-menu__path">{f}</span>
        </div>
      ))}
    </div>
  );
}

/** 当前会话可用的 slash 命令全集（内置 + 运行时注册），供菜单与发送拦截共用 */
export function slashCommandCandidates(
  state: DesktopAppState,
  workspaceId: string,
  sessionId: string | null | undefined,
): Array<{ command: string; description?: string; source?: string }> {
  const runtimeCommands = state.sessionCommandsBySession[`${workspaceId}:${sessionId ?? ""}`] ?? [];
  return [
    ...[
      { command: "/compact" }, { command: "/thinking" }, { command: "/tree" },
      { command: "/status" }, { command: "/reload" },
    ],
    ...runtimeCommands.map((c) => ({ command: `/${c.name}`, description: c.description, source: c.source })),
  ];
}

/** "+" 操作面板：附件 / 引用工作区文件 / 计划模式 / 压缩会话（技能走 / 菜单） */
function ComposerPlusMenu({
  planOn, onPlanChange, sending, workspaceId, onInsertText,
}: {
  planOn: boolean;
  onPlanChange: (on: boolean) => void;
  sending: boolean;
  workspaceId: string;
  onInsertText: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fileView, setFileView] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [fileFilter, setFileFilter] = useState("");

  // 点击菜单外部关闭
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".composer-plus")) {
        setOpen(false);
        setFileView(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  const togglePlan = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !planOn;
    try {
      await window.piApp.setPlanMode(next);
      onPlanChange(next);
    } catch { /* 保持原状态 */ }
  };

  const openFileView = async () => {
    setFileView(true);
    if (files === null) {
      try {
        const list = await window.piApp.listWorkspaceFiles(workspaceId);
        setFiles(list ?? []);
      } catch {
        setFiles([]);
      }
    }
  };

  const handleCompact = async () => {
    setOpen(false);
    const ok = await appConfirm("压缩会话上下文？历史消息将被摘要替代，释放上下文空间。");
    if (!ok) return;
    try {
      await window.piApp.compactSession();
    } catch (e) {
      appAlert(`压缩失败: ${(e as Error).message}`);
    }
  };

  const filteredFiles = (files ?? []).filter((f) => !fileFilter || f.toLowerCase().includes(fileFilter.toLowerCase()));

  return (
    <div className={`composer-plus ${open ? "open" : ""} ${planOn ? "has-plan" : ""}`}>
      <button
        type="button"
        className="composer__icon-btn"
        onClick={() => { setOpen(!open); if (!open) setFileView(false); }}
        title="附件 / 引用文件 / 计划模式 / 压缩会话"
      ><Plus size={16} /></button>
      {open && !fileView && (
        <div className="composer-plus-menu">
          <div className="composer-plus-group">插入</div>
          <button
            type="button"
            disabled={sending}
            onClick={() => { setOpen(false); window.piApp.pickComposerAttachments().catch(() => {}); }}
          >
            <Paperclip size={14} /> 上传附件
          </button>
          <button type="button" disabled={sending} onClick={openFileView}>
            <AtSign size={14} /> 引用工作区文件
          </button>
          <div className="composer-plus-group">会话</div>
          <button type="button" className={planOn ? "checked" : ""} onClick={togglePlan}>
            <ListChecks size={14} />
            计划模式
            {planOn && <span className="composer-plus-check">已开启</span>}
          </button>
          <button type="button" onClick={handleCompact} disabled={sending}>
            <Minimize2 size={14} /> 压缩会话
          </button>
        </div>
      )}
      {open && fileView && (
        <div className="composer-plus-menu composer-plus-menu--files">
          <div className="composer-plus-files-head">
            <button type="button" className="composer-plus-back" onClick={() => setFileView(false)}>‹ 返回</button>
            <input
              className="composer-plus-files-filter"
              placeholder="过滤文件…"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              autoFocus
            />
          </div>
          <div className="composer-plus-files-list">
            {files === null && <div className="composer-plus-files-empty">加载中…</div>}
            {files !== null && filteredFiles.length === 0 && <div className="composer-plus-files-empty">没有匹配的文件</div>}
            {filteredFiles.slice(0, 80).map((f) => (
              <button
                key={f}
                type="button"
                title={f}
                onClick={() => { setOpen(false); setFileView(false); onInsertText(f); }}
              >
                <FileText size={13} />
                <span className="composer-plus-file-path">{f}</span>
              </button>
            ))}
            {filteredFiles.length > 80 && <div className="composer-plus-files-empty">…共 {filteredFiles.length} 个，输入关键词过滤</div>}
          </div>
        </div>
      )}
      {planOn && !open && <span className="composer-plus-plan-badge">计划中</span>}
    </div>
  );
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
          {changedFiles.map((f) => {
            // 已跟踪文件的修改/删除可以整体还原；新增/未跟踪不提供丢弃（避免误删用户文件）
            const restorable = f.status.startsWith("M") || f.status.startsWith("D");
            return (
              <div key={f.path} className={`change-row ${selectedDiff === f.path ? "active" : ""}`} onClick={() => handleViewDiff(f.path)}>
                <span className={`change-status status-${f.status}`}>{f.status.charAt(0).toUpperCase()}</span>
                <span className="change-path">{f.path}</span>
                {restorable && (
                  <button
                    className="change-discard-btn"
                    title="丢弃这个文件的全部未提交改动（还原到上次提交）"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const ok = await appConfirm(`丢弃 "${f.path}" 的改动？文件将还原到上次提交的状态，此操作不可撤销。`, { danger: true });
                      if (!ok) return;
                      try {
                        await window.piApp.discardFile(workspaceId, f.path);
                        setFiles((prev: ChangedFilesResult | null) =>
                          prev && prev.state === "available"
                            ? { ...prev, files: prev.files.filter((x) => x.path !== f.path) }
                            : prev,
                        );
                        if (selectedDiff === f.path) { setSelectedDiff(null); setDiffContent(null); }
                      } catch (err) {
                        appAlert(`丢弃失败: ${(err as Error).message}`);
                      }
                    }}
                  ><RotateCcw size={11} /> 丢弃</button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {selectedDiff && diffContent !== null && (
        <pre className="change-diff">{diffContent}</pre>
      )}
    </div>
  );
}
