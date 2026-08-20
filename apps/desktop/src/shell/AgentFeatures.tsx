import { useState, useEffect } from "react";
import { AlertTriangle, Gauge, Layers, Bookmark, BookmarkCheck } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

/** #1 上下文用量指示器（紧凑图标版，放在 composer 底栏右侧） */
export function ContextMeter({ state }: { state: DesktopAppState }) {
  // 保留原组件给其他可能的使用
  return null;
}

/** 紧凑图标版：小圆环，hover 显示完整统计（token + 消息数 + 工具数） */
export function ContextMeterIcon({ state }: { state: DesktopAppState }) {
  const [usage, setUsage] = useState<{ tokens: number; contextWindow: number; percent: number } | null>(null);
  const [stats, setStats] = useState<{ messageCount: number; toolCallCount: number; estimatedTokens: number } | null>(null);

  useEffect(() => {
    let active = true;
    const fetch = async () => {
      try {
        const [u, s] = await Promise.all([
          (window as any).piApp?.getContextUsage?.(),
          (window as any).piApp?.getSessionStats?.(),
        ]);
        if (active) { if (u) setUsage(u); if (s) setStats(s); }
      } catch {}
    };
    fetch();
    const timer = setInterval(fetch, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [state.selectedSessionId, state.revision]);

  const isWarning = (usage?.percent ?? 0) > 70;
  const isDanger = (usage?.percent ?? 0) > 85;
  const pct = usage?.percent ?? 0;
  const fillWidth = Math.max(2, Math.min(pct, 100));
  const color = isDanger ? "#c08b8b" : isWarning ? "#c4a97a" : "#8baab0";
  const [hovered, setHovered] = useState(false);

  // 环形进度图（SVG）
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (fillWidth / 100) * circumference;

  const tooltipLines = [
    usage ? `Token ${(usage.tokens / 1000).toFixed(1)}k / ${(usage.contextWindow / 1000).toFixed(0)}k (${pct}%)` : null,
    stats ? `消息 ${stats.messageCount}` : null,
    stats ? `工具 ${stats.toolCallCount}` : null,
  ].filter(Boolean);

  return (
    <span
      className="context-icon"
      style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, opacity: 0.65, position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--border-strong)" strokeWidth="2" opacity="0.5" />
        <circle cx="8" cy="8" r={radius} fill="none" stroke={color} strokeWidth="2"
          strokeDasharray={circumference} strokeDashoffset={dashOffset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s ease" }} />
      </svg>
      {hovered && tooltipLines.length > 0 && (
        <div className="context-tooltip">
          {tooltipLines.map((line, i) => <div key={i}>{line}</div>)}
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
