import { useState, useEffect } from "react";
import { AlertTriangle, Gauge, Layers, Bookmark, BookmarkCheck } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

/** #1 上下文用量指示器（紧凑图标版，放在 composer 底栏右侧） */
export function ContextMeter({ state }: { state: DesktopAppState }) {
  // 保留原组件给其他可能的使用
  return null;
}

/** 上下文水位：圆环照旧，悬浮卡片 = 分段堆叠条（系统/工具/对话/剩余）+ 图例 */
export function ContextMeterIcon({ state }: { state: DesktopAppState }) {
  const [usage, setUsage] = useState<{
    tokens: number; contextWindow: number; percent: number; real?: boolean;
    sessionTotalTokens?: number | null;
    segments?: Array<{ key: string; tokens: number }>;
  } | null>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    let active = true;
    const fetch = async () => {
      try {
        const u = await (window as any).piApp?.getContextUsage?.();
        if (active && u) setUsage(u);
      } catch {}
    };
    fetch();
    const timer = setInterval(fetch, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [state.selectedSessionId, state.revision]);

  const pct = usage?.percent ?? 0;
  const isDark = document.documentElement.classList.contains("dark");
  const color = isDark
    ? pct > 85 ? "#d4908a" : pct > 70 ? "#d0b070" : "#88aab0"
    : pct > 85 ? "#c08b8b" : pct > 70 ? "#c4a97a" : "#8baab0";

  // 圆环（与原版一致）
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (Math.max(2, Math.min(pct, 100)) / 100) * circumference;

  // 分段（莫兰迪色）
  const SEG_STYLE: Record<string, { color: string; label: string }> = isDark
    ? {
        system: { color: "#8a9a7a", label: "系统提示词" },
        tools: { color: "#9a8aaa", label: "工具定义" },
        messages: { color: "#7a9aa0", label: "对话内容" },
        free: { color: "var(--bg-muted)", label: "剩余空间" },
      }
    : {
        system: { color: "#a8b8a0", label: "系统提示词" },
        tools: { color: "#b3a8bd", label: "工具定义" },
        messages: { color: "#8baab0", label: "对话内容" },
        free: { color: "var(--bg-muted)", label: "剩余空间" },
      };
  const window_ = usage?.contextWindow ?? 1;
  const segs = (usage?.segments ?? []).filter((sg) => sg.tokens > 0);

  return (
    <span
      className="context-meter"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="2" opacity="0.5" />
        <circle cx="8" cy="8" r={radius} fill="none" stroke={color} strokeWidth="2"
          strokeDasharray={circumference} strokeDashoffset={dashOffset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s ease" }} />
      </svg>
      {hovered && usage && (
        <div className="context-popover">
          <div className="context-popover__head">
            <span className="context-popover__title">上下文容量</span>
            <span className="context-popover__head-pct">{Math.round(pct)}%</span>
          </div>
          {/* 总容量条：堆叠条——填充段=各构成色按占比拼接，留白=剩余 */}
          <div className="context-popover__bar">
            {segs.filter((sg) => sg.key !== "free").map((sg) => (
              <span
                key={sg.key}
                className="context-popover__bar-seg"
                style={{ width: `${Math.max((sg.tokens / window_) * 100, 0.6)}%`, background: SEG_STYLE[sg.key]?.color }}
              />
            ))}
          </div>
          <div className="context-popover__rows">
            {segs.filter((sg) => sg.key !== "free").map((sg) => (
              <span key={sg.key} className="context-popover__row-item">
                <span className="context-popover__lg-dot" style={{ background: SEG_STYLE[sg.key]?.color }} />
                <span className="context-popover__row-label">{SEG_STYLE[sg.key]?.label ?? sg.key}</span>
                <span className="context-popover__row-bar">
                  <span
                    className="context-popover__row-bar-fill"
                    style={{ width: `${Math.min(sg.tokens / window_ * 100, 100)}%`, background: SEG_STYLE[sg.key]?.color }}
                  />
                </span>
                <span className="context-popover__lg-pct">{Math.round((sg.tokens / window_) * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

/** #3 schema 版本警告 */
export function SchemaBanner({ state }: { state: DesktopAppState }) {
  const [info, setInfo] = useState<{ writtenByNewerRuntime?: boolean } | null>(null);

  useEffect(() => {
    (window.piApp as any).getSchemaInfo?.().then(setInfo);
  }, [state.selectedSessionId, state.revision]);

  if (!info?.writtenByNewerRuntime) return null;

  return (
    <div className="schema-banner">
      <AlertTriangle size={14} /> 此会话由更新版本创建，部分内容可能不显示。
    </div>
  );
}

/** #7 队列深度指示器（steer/followUp 排队消息数） */
export function QueueIndicator({ state }: { state: DesktopAppState }) {
  const queued = state.queuedComposerMessages ?? [];
  if (queued.length === 0) return null;

  return (
    <div className="queue-indicator">
      <Layers size={12} /> {queued.length} 条排队中
    </div>
  );
}

/** #5 会话标签（bookmark）— 每条 assistant 消息旁的 bookmark 按钮 */
export function BookmarkButton({ entryId, onBookmark }: { entryId?: string; onBookmark?: () => void }) {
  const [bookmarked, setBookmarked] = useState(false);
  if (!entryId || !onBookmark) return null;
  return (
    <button
      className="bookmark-btn"
      title={bookmarked ? "取消标签" : "添加标签"}
      onClick={(e) => { e.stopPropagation(); setBookmarked(!bookmarked); onBookmark(); }}
    >
      {bookmarked ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
    </button>
  );
}
