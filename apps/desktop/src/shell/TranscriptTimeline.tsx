import { useState, type ReactNode } from "react";
import { FileText, Plus, Sparkles } from "lucide-react";
import { fileExtension, formatFileSize } from "../composer-paste";
import { ImageLightbox } from "./ImageLightbox";
import ReactMarkdown from "react-markdown";
import type { SessionTranscriptMessage, SessionTranscriptToolCall } from "@pi-gui/pi-sdk-driver";
import { REMARK_PLUGINS, REHYPE_PLUGINS, MARKDOWN_COMPONENTS } from "../message-markdown";

/**
 * 会话时间线渲染：
 * - 消息（用户/助手/摘要）
 * - 工具调用（可折叠，输入/输出可读化键值渲染，不再展示裸 JSON）
 * - 连续的"读取类"工具自动合并为一行「读取了 N 项内容」，展开后逐条查看
 * - activity/summary 轻量行内显示
 */

/* ------------------------------------------------------------------ */
/* 分类：哪些工具算"安静读取"（可合并）                                */
/* ------------------------------------------------------------------ */

/** 写操作 / 有副作用的动词——命中则永不合并（宁可多显示，不可漏显示） */
const WRITE_TOOL_RE =
  /(?:^|[^a-z])(?:write|create|update|delete|remove|add|advance|ingest|save|edit|patch|append|exec|run|bash|apply|import|send|kill|stop|move|rename)(?![a-z])/i;
/** 只读动词 */
const READ_TOOL_RE =
  /(?:^|[^a-z])(?:read|list|get|search|query|grep|glob|find|browse|fetch|lint)(?![a-z])/i;

function isQuietReadCall(item: unknown): item is SessionTranscriptToolCall {
  const it = item as Record<string, unknown> | null;
  if (!it || it.kind !== "tool") return false;
  if (it.status !== "success") return false;
  const name = String(it.toolName ?? "");
  if (WRITE_TOOL_RE.test(name)) return false;
  return READ_TOOL_RE.test(name);
}

/* ------------------------------------------------------------------ */
/* 工具名称 → 中文友好标签                                             */
/* ------------------------------------------------------------------ */

const TOOL_DISPLAY: Record<string, string> = {
  // pi 内置
  read: "读取文件", list: "列出目录", grep: "搜索内容", glob: "匹配文件",
  write: "写入文件", edit: "编辑文件", bash: "执行命令",
  // wiki 工具
  wiki_read_memory: "读取记忆", wiki_update_memory: "更新记忆",
  wiki_query: "检索知识库", wiki_search: "搜索知识库",
  wiki_create_page: "创建页面", wiki_update_page: "更新页面",
  wiki_add_ref: "添加引用", wiki_lint: "检查知识库",
  wiki_create_goal: "创建目标", wiki_advance_goal: "推进目标",
  wiki_update_goal_status: "更新目标状态", wiki_get_active_goals: "读取目标",
  wiki_ingest: "摄取文档", wiki_save_synthesis: "保存综合结论",
  wiki_discover_domains: "领域发现", wiki_import_legacy: "导入旧知识库",
  wiki_create_schedule: "创建定时规则", wiki_list_schedules: "查看定时规则",
  wiki_remove_schedule: "删除定时规则",
  wiki_create_plugin: "创建插件", wiki_list_plugins: "查看插件", wiki_remove_plugin: "删除插件",
  wiki_create_skill: "创建技能", wiki_list_skills: "查看技能",
  // 业务实体工具
  read_entity: "读取实体", create_entity: "创建实体", update_entity: "更新实体",
  delete_entity: "删除实体", query_ka: "查询 KA", list_card_templates: "查看卡片模板",
  create_card: "创建卡片", init_workspace: "初始化工作区",
  // 子线程编排（orchestration）
  create_child_thread: "派生子任务", list_threads: "查看子任务", read_thread: "读取子任务",
  send_message_to_thread: "推进子任务",
};

function toolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY[toolName]) return TOOL_DISPLAY[toolName];
  const short = toolName.includes("__") ? toolName.split("__").slice(-1)[0] ?? toolName : toolName;
  return TOOL_DISPLAY[short] ?? short;
}

/** 工具图标（按名称匹配） */
function toolGlyph(toolName: string) {
  const name = toolName.toLowerCase();
  if (READ_TOOL_RE.test(name) && !WRITE_TOOL_RE.test(name)) return <FileText size={14} />;
  if (WRITE_TOOL_RE.test(name)) return <Plus size={14} />;
  return <Sparkles size={14} />;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 紧凑标签：优先从参数里提取人话；"读取"类措辞只给只读工具用，写操作不得伪装成读取 */
function buildToolLabel(call: SessionTranscriptToolCall): string {
  const name = call.toolName;
  const isRead = READ_TOOL_RE.test(name) && !WRITE_TOOL_RE.test(name);
  const i = call.input as Record<string, unknown> | undefined;
  if (i && typeof i === "object") {
    const fm = i.frontmatter as Record<string, unknown> | undefined;
    if (!isRead && fm && typeof fm.title === "string" && fm.title) return `创建：${fm.title}`;
    if (isRead && typeof i.path === "string" && i.path) return `读取 ${baseName(i.path)}`;
    if (isRead && typeof i.file_path === "string" && i.file_path) return `读取 ${baseName(i.file_path)}`;
    if (isRead && typeof i.query === "string" && i.query) return `搜索「${truncate(i.query, 24)}」`;
    if (isRead && typeof i.pattern === "string" && i.pattern) return `匹配 ${truncate(i.pattern, 24)}`;
    if (typeof i.command === "string" && i.command) return `$ ${truncate(i.command, 32)}`;
    if (isRead && typeof i.customer === "string" && i.customer) return `查询 ${i.customer}`;
    if (isRead && typeof i.status === "string" && i.status) return `按状态过滤: ${i.status}`;
    if (isRead && typeof i.type === "string" && i.type) return `读取 ${i.type}${typeof i.id === "string" ? "/" + i.id : ""}`;
    if (typeof i.title === "string" && i.title) return `添加: ${i.title}`;
  }
  if (typeof call.input === "string" && call.input.trim()) return truncate(call.input.trim(), 48);
  return toolDisplayName(call.toolName);
}

/* ------------------------------------------------------------------ */
/* 时间线入口                                                          */
/* ------------------------------------------------------------------ */

/** 连续读取类工具的隐藏阈值：达到 3 条即收成一行静默摘要（不再逐条展示） */
const GROUP_MIN = 3;

export function renderTimelineItems(items: readonly unknown[]): ReactNode[] {
  const out: ReactNode[] = [];
  // "从此分支"入口只保留在会话最下面（最后一条消息）——
  // 每条消息都出按钮干扰大且语义重复（Ryan 反馈）
  let lastMessageIdx = -1;
  for (let k = items.length - 1; k >= 0; k--) {
    if ((items[k] as Record<string, unknown> | null)?.kind === "message") {
      lastMessageIdx = k;
      break;
    }
  }
  let i = 0;
  while (i < items.length) {
    const it = items[i] as Record<string, unknown> | null;
    if (it?.kind === "tool") {
      // 连续工具调用整体包进"思考"折叠块：默认收起，点开才看分步明细
      let j = i;
      while (j < items.length && (items[j] as Record<string, unknown> | null)?.kind === "tool") j++;
      out.push(
        <ThinkingBlock
          key={`think-${i}-${j}`}
          calls={items.slice(i, j) as SessionTranscriptToolCall[]}
          active={j === items.length}
        />,
      );
      i = j;
      continue;
    }
    out.push(renderSingleItem(it, i, i === lastMessageIdx));
    i++;
  }
  return out;
}

/** 工具调用序列 → 摘要行 + 单行工具（思考块展开后的第二层） */
function renderToolSequence(items: readonly SessionTranscriptToolCall[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i] as unknown as Record<string, unknown> | null;
    // ① 连续读取类：收成一行静默摘要
    if (isQuietReadCall(it)) {
      let j = i;
      while (j < items.length && isQuietReadCall(items[j])) j++;
      if (j - i >= GROUP_MIN) {
        out.push(
          <ToolGroupView
            key={`tool-group-${i}-${j}`}
            calls={items.slice(i, j) as SessionTranscriptToolCall[]}
            label={`已读取 ${j - i} 项内容`}
          />,
        );
        i = j;
        continue;
      }
    }
    // ② 同名操作连发（如批量创建实体）：也收成一行
    const toolName = typeof it?.toolName === "string" ? it.toolName : "";
    if (toolName && it?.status === "success") {
      let j = i;
      while (j < items.length) {
        const cur = items[j] as unknown as Record<string, unknown> | null;
        if (cur?.kind !== "tool" || cur.toolName !== toolName || cur.status !== "success") break;
        j++;
      }
      if (j - i >= GROUP_MIN) {
        out.push(
          <ToolGroupView
            key={`tool-run-${i}-${j}`}
            calls={items.slice(i, j) as SessionTranscriptToolCall[]}
            label={`${toolDisplayName(toolName)} ×${j - i}`}
          />,
        );
        i = j;
        continue;
      }
    }
    out.push(renderSingleItem(it, i));
    i++;
  }
  return out;
}

/** 思考块：运行中显示"正在思考…"，完成后收成"已思考 · N 个操作" */
function ThinkingBlock({ calls, active }: { calls: SessionTranscriptToolCall[]; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const errors = calls.filter((c) => c.status === "error").length;
  const seconds = runSeconds(calls);

  return (
    <div className="timeline-thinking">
      <button
        type="button"
        className={`timeline-thinking__header ${active ? "timeline-thinking__header--active" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}>▸</span>
        {active ? (
          <span className="timeline-thinking__label">
            <span className="timeline-thinking__pip" />
            正在思考…
          </span>
        ) : (
          <span className="timeline-thinking__label">
            已思考 · {calls.length} 个操作
            {errors > 0 ? `（${errors} 个失败）` : ""}
            {seconds > 0 ? ` · ${seconds}s` : ""}
          </span>
        )}
      </button>
      {expanded && (
        <div className="timeline-thinking__body">
          {renderToolSequence(calls)}
        </div>
      )}
    </div>
  );
}

/** 一段工具运行的时间跨度（秒），时间戳不可用或不足 1 秒时返回 0 */
function runSeconds(calls: SessionTranscriptToolCall[]): number {
  const t0 = Date.parse(calls[0]?.createdAt ?? "");
  const t1 = Date.parse(calls[calls.length - 1]?.createdAt ?? "");
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 0;
  return Math.round((t1 - t0) / 1000);
}

function renderSingleItem(item: unknown, index: number, isLastMessage = false): ReactNode {
  const it = item as Record<string, unknown> | null;
  const key = (typeof it?.id === "string" && it.id) || `item-${index}`;
  if (it?.kind === "message") return <MessageView key={key} msg={it as unknown as SessionTranscriptMessage} showBranchAction={isLastMessage} />;
  if (it?.kind === "tool") return <ToolCallView key={key} call={it as unknown as SessionTranscriptToolCall} />;
  if (it?.kind === "summary" || it?.kind === "activity") return <ActivityView key={key} item={it} />;
  return null;
}

/* ------------------------------------------------------------------ */
/* 消息 / activity                                                     */
/* ------------------------------------------------------------------ */

/**
 * 用户消息中的技能调用展示：/skill:name 任务…… → 只渲染任务文本，
 * 命令前缀转为小徽标（与 composer 技能胶囊呼应——命令语法不裸露在对话流里）
 */
function SkillCommandText({ text }: { text: string }) {
  const m = text.match(/^\/(skill:[^\s]+)\s*([\s\S]*)$/);
  if (!m) {
    return <div className="bubble user-bubble">{text}</div>;
  }
  // 技能调用只显示任务文本——命令前缀与徽标均不进对话流（Ryan：徽标也不要）
  const task = (m[2] ?? "").trim();
  return <div className="bubble user-bubble">{task || "（仅调用技能）"}</div>;
}

/** 消息内图片：双击放大预览 */
function MessageImage({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <img className="msg-image" src={src} alt={alt} title="双击放大" onDoubleClick={() => setZoom(true)} />
      {zoom && <ImageLightbox src={src} alt={alt} onClose={() => setZoom(false)} />}
    </>
  );
}

function MessageView({ msg, showBranchAction = false }: { msg: SessionTranscriptMessage; showBranchAction?: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="msg user">
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="msg-attachments">
            {msg.attachments.map((a, i) =>
              a.kind === "image" ? (
                <MessageImage key={a.name ?? i} src={`data:${a.mimeType};base64,${a.data}`} alt={a.name ?? "图片"} />
              ) : (
                <span key={a.fsPath ?? i} className="msg-att-file" title={a.fsPath}>
                  <FileText size={14} />
                  <span className="msg-att-file__name">{a.name}</span>
                  <span className="msg-att-file__meta">
                    {fileExtension(a.name)}{typeof a.sizeBytes === "number" ? ` · ${formatFileSize(a.sizeBytes)}` : ""}
                  </span>
                </span>
              ),
            )}
          </div>
        )}
        <SkillCommandText text={msg.text} />
        {showBranchAction && <MessageActions messageId={msg.id} />}
      </div>
    );
  }
  // assistant / branchSummary / compactionSummary：无气泡，直接在背景上
  if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
    return (
      <div className="msg summary-msg">
        <div className="summary-eyebrow">{msg.role === "compactionSummary" ? "上下文压缩" : "分支摘要"}</div>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>{msg.text}</ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="msg assistant-msg">
      {msg.text ? (
        <>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>{msg.text}</ReactMarkdown>
          {showBranchAction && <MessageActions messageId={msg.id} />}
        </>
      ) : (
        <div className="thinking"><span className="dot" /><span className="dot" /><span className="dot" /></div>
      )}
    </div>
  );
}

/** 消息 hover 操作：从此消息重开分支（App 监听 fork-from-message 事件） */
function MessageActions({ messageId }: { messageId: string }) {
  return (
    <div className="message-actions">
      <button
        type="button"
        title="从这条消息重开一个分支会话（之后的内容不带过去）"
        onClick={() => window.dispatchEvent(new CustomEvent("fork-from-message", { detail: { messageId } }))}
      >
        从此分支
      </button>
    </div>
  );
}

/** activity/summary：轻量行内显示（思考、压缩等过程） */
function ActivityView({ item }: { item: Record<string, unknown> }) {
  return (
    <div className={`timeline-activity ${item.tone ? `tone-${item.tone}` : ""}`}>
      <span className="timeline-activity__label">{String(item.label ?? "")}</span>
      {item.detail != null && <span className="timeline-activity__detail">{String(item.detail)}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 工具调用行                                                          */
/* ------------------------------------------------------------------ */

/** 工具调用：无框，图标 + 可折叠行；展开后是键值化的可读内容 */
function ToolCallView({ call }: { call: SessionTranscriptToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = call.input !== undefined || call.output !== undefined;
  const label = buildToolLabel(call);

  return (
    <div className={`timeline-tool timeline-tool--${call.status}`}>
      <div className="timeline-tool__header-row">
        <span className="timeline-tool__glyph">{toolGlyph(call.toolName)}</span>
        <button
          className="timeline-tool__header"
          type="button"
          disabled={!hasContent}
          onClick={() => setExpanded(!expanded)}
        >
          {hasContent && (
            <span className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}>▸</span>
          )}
          <span className="timeline-tool__label">{label}</span>
          <span className="timeline-tool__meta">
            <span className={`timeline-tool__status-pip status-${call.status}`} />
            {call.status === "success" ? "完成" : call.status === "error" ? "失败" : "运行中"}
          </span>
        </button>
      </div>
      {expanded && hasContent && (
        <div className="timeline-tool__body">
          {call.input != null && (
            <div className="tool-section">
              <div className="tool-section-title">输入</div>
              <ToolPayloadView value={call.input} />
            </div>
          )}
          {call.output != null && (
            <div className="tool-section">
              <div className="tool-section-title">输出</div>
              <ToolPayloadView value={call.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 连续同类工具：默认一行静默摘要，点开可下钻看每条明细 */
function ToolGroupView({ calls, label }: { calls: SessionTranscriptToolCall[]; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const counts = new Map<string, number>();
  for (const c of calls) {
    const name = toolDisplayName(c.toolName);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(" · ");

  return (
    <div className="timeline-tool-group">
      <button
        type="button"
        className="timeline-tool-group__line"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "收起明细" : "查看明细"}
      >
        <span className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}>▸</span>
        <span className="timeline-tool__glyph">{toolGlyph(calls[0]?.toolName ?? "read")}</span>
        <span className="timeline-tool__label">{label}</span>
        {summary !== label && <span className="timeline-tool-group__summary">{summary}</span>}
      </button>
      {expanded && (
        <div className="timeline-tool-group__list">
          {calls.map((c, idx) => (
            <ToolCallView key={c.id ?? idx} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 输入/输出可读化渲染                                                 */
/* ------------------------------------------------------------------ */

/** 常见字段的中文名 */
const KEY_LABELS: Record<string, string> = {
  content: "内容", details: "详情", type: "类型", id: "ID", title: "标题",
  path: "路径", file_path: "文件", file: "文件", files: "文件列表",
  query: "查询", pattern: "匹配模式", keyword: "关键词", keywords: "关键词",
  customer: "客户", status: "状态", results: "结果", items: "条目", total: "总数",
  count: "数量", text: "文本", name: "名称", description: "描述",
  limit: "数量上限", offset: "偏移", dir: "目录", directory: "目录", folder: "目录",
  url: "地址", page: "页面", body: "正文", error: "错误", message: "消息",
  mode: "模式", reason: "原因", command: "命令", cwd: "工作目录", script: "脚本",
  old_string: "原内容", new_string: "新内容", language: "语言", lines: "行数",
  createdAt: "创建时间", updatedAt: "更新时间", suggestions: "建议", domains: "领域",
  relPath: "路径", snippet: "摘要", score: "相关度", metadata: "元数据",
  frontmatter: "属性", tags: "标签", sources: "来源", refs: "引用", ref: "引用",
};

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}

const TEXT_CLAMP = 240;
const LIST_CLAMP = 3;

/** pi 工具输出的 content 常是 [{type:"text", text:"…"}] 结构——识别后拼接为纯文本 */
function isTextParts(value: unknown): value is { type: string; text: string }[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (p) =>
      p !== null &&
      typeof p === "object" &&
      typeof (p as Record<string, unknown>).text === "string" &&
      Object.keys(p as Record<string, unknown>).every((k) => k === "type" || k === "text"),
  );
}

/** 工具载荷渲染入口：字符串化 JSON 自动解析，其余按类型分派 */
function ToolPayloadView({ value }: { value: unknown }) {
  let v = value;
  if (typeof v === "string") {
    const s = v.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        v = JSON.parse(s);
      } catch {
        /* 保持原字符串 */
      }
    }
  }
  return <ValueView value={v} />;
}

function ValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span className="tool-kv__scalar">（空）</span>;
  if (isTextParts(value)) return <TextValue text={value.map((p) => p.text).join("\n\n")} />;
  if (typeof value === "string") return <TextValue text={value} />;
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="tool-kv__scalar">{String(value)}</span>;
  }
  if (Array.isArray(value)) return <ArrayValue value={value} depth={depth} />;
  if (typeof value === "object") return <ObjectValue value={value as Record<string, unknown>} depth={depth} />;
  return <span className="tool-kv__scalar">{String(value)}</span>;
}

function TextValue({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  if (text.trim() === "") return <span className="tool-kv__scalar">（空）</span>;
  const over = text.length > TEXT_CLAMP;
  const shown = over && !full ? text.slice(0, TEXT_CLAMP).replace(/\s+\S*$/, "") + " …" : text;
  return (
    <div className="tool-text">
      <div className="tool-text__body">{shown}</div>
      {over && (
        <button type="button" className="tool-text__toggle" onClick={() => setFull(!full)}>
          {full ? "收起" : `展开全部（${text.length.toLocaleString()} 字符）`}
        </button>
      )}
    </div>
  );
}

function ArrayValue({ value, depth }: { value: unknown[]; depth: number }) {
  const [full, setFull] = useState(false);
  if (value.length === 0) return <span className="tool-kv__scalar">（空）</span>;
  const allPrimitive = value.every(
    (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null,
  );
  const over = value.length > LIST_CLAMP;
  const shown = over && !full ? value.slice(0, LIST_CLAMP) : value;
  return (
    <div className="tool-list">
      {shown.map((v, idx) => (
        <div key={idx} className="tool-list__item">
          {allPrimitive ? (
            <ValueView value={v} depth={depth} />
          ) : (
            <>
              <span className="tool-list__index">#{idx + 1}</span>
              <ValueView value={v} depth={depth} />
            </>
          )}
        </div>
      ))}
      {over && (
        <button type="button" className="tool-text__toggle" onClick={() => setFull(!full)}>
          {full ? "收起" : `显示全部 ${value.length} 条`}
        </button>
      )}
    </div>
  );
}

function ObjectValue({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return <span className="tool-kv__scalar">（空）</span>;
  // 层级太深时退回紧凑 JSON，避免无限嵌套
  if (depth >= 2) {
    return <pre className="tool-compact">{JSON.stringify(value, null, 2)}</pre>;
  }
  return (
    <div className={depth === 0 ? "tool-kv" : "tool-kv tool-kv--nested"}>
      {entries.map(([k, v]) => (
        <div key={k} className="tool-kv__row">
          <span className="tool-kv__key">{keyLabel(k)}</span>
          <div className="tool-kv__value">
            <ValueView value={v} depth={depth + 1} />
          </div>
        </div>
      ))}
    </div>
  );
}
