import { useState, useEffect, memo } from "react";
import { RefreshCw, Plus, ChevronUp, ChevronDown, X, Zap, BookOpen, FileText, Link2, TrendingUp, Share2, MessageSquareHeart } from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { DesktopAppState } from "../desktop-state";
import { CardPicker } from "./CardPicker";

interface CardConfig {
  id: string;
  title: string;
  icon: string;
  entityType: string;
  displayFields: string[];
  fieldLabels?: Record<string, string>;
  filter?: Record<string, unknown>;
  sortBy?: string;
  sortDesc?: boolean;
  limit?: number;
  template: "preset" | "custom";
}

interface EntityData { frontmatter: Record<string, unknown>; body: string; }

interface Props {
  state: DesktopAppState;
  sidebarCollapsed?: boolean;
  width?: number;
  onResize?: (e: React.MouseEvent) => void;
  onFeedback?: () => void;
}

export function StatusPanel({ state, sidebarCollapsed, width, onResize, onFeedback }: Props) {
  const [cards, setCards] = useState<CardConfig[]>([]);
  const [cardData, setCardData] = useState<Record<string, EntityData[]>>({});
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  const api = window as any;

  const fetchAll = async () => {
    try {
      const [c, data] = await Promise.all([
        api.piApp.getCards(),
        api.piApp.getCardData(),
      ]);
      setCards(c);
      setCardData(data);
    } catch {}
    setLoading(false);
  };

  // Wiki 知识库概览卡片配置 + 数据 + 图谱（P5）
  const [wikiStatsVisible, setWikiStatsVisible] = useState(true);
  const [wikiStats, setWikiStats] = useState<{ totalPages: number; categories: Record<string, number>; crossReferences: number; recentUpdates: number } | null>(null);
  const [wikiGraph, setWikiGraph] = useState<{ nodes: Array<{ id: string; title: string; category: string }>; edges: Array<{ source: string; target: string }> } | null>(null);

  const fetchWikiStats = async () => {
    try {
      const cfg = await api.piApp?.getWikiConfig?.();
      if (cfg) setWikiStatsVisible(cfg.showWikiStatsCard !== false);
      if (cfg?.showWikiStatsCard !== false) {
        const stats = await api.piApp?.getWikiStats?.();
        if (stats) setWikiStats(stats);
        const graph = await api.piApp?.getWikiGraph?.();
        if (graph) setWikiGraph(graph);
      }
    } catch { /* 静默降级 */ }
  };

  // revision 变化防抖刷新：导入/连发工具时 revision 高频跳动，
  // 直接刷新会触发 getWikiStats/getWikiGraph 全库扫描风暴（曾导致顶栏闪烁）
  useEffect(() => {
    if (sidebarCollapsed) return; // 收起时面板不可见，不拉数据
    const t = setTimeout(() => {
      fetchAll();
      fetchWikiStats();
    }, 500);
    return () => clearTimeout(t);
  }, [state.selectedWorkspaceId, state.selectedSessionId, state.revision, sidebarCollapsed]);

  // 低频兜底轮询（与 revision 无关；依赖 collapsed 让闭包读到最新值）
  useEffect(() => {
    const timer = setInterval(() => {
      if (sidebarCollapsed) return;
      fetchAll();
      fetchWikiStats();
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed]);

  const handleAddCard = async (template: any) => {
    const newCard: CardConfig = {
      id: `preset-${template.entityType}-${Date.now().toString(36)}`,
      title: template.title,
      icon: template.icon,
      entityType: template.entityType,
      displayFields: template.displayFields,
      fieldLabels: template.fieldLabels,
      limit: 5,
      template: "preset",
    };
    const updated = [...cards, newCard];
    setCards(updated);
    await api.piApp.saveCards(updated);
    setShowPicker(false);
    fetchAll();
  };

  const handleRemoveCard = async (id: string) => {
    const updated = cards.filter((c) => c.id !== id);
    setCards(updated);
    await api.piApp.saveCards(updated);
  };

  const handleMoveCard = (index: number, dir: "up" | "down") => {
    const newIndex = dir === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= cards.length) return;
    const updated = [...cards];
    const tmp = updated[index];
    updated[index] = updated[newIndex]!;
    updated[newIndex] = tmp!;
    setCards(updated);
    api.piApp.saveCards(updated);
  };

  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const runtime = state.runtimeByWorkspace[state.selectedWorkspaceId];
  const models = runtime?.models ?? [];
  const [stats, setStats] = useState<{ messageCount: number; toolCallCount: number; estimatedTokens: number } | null>(null);

  useEffect(() => {
    (window as any).piApp?.getSessionStats?.().then(setStats);
  }, [state.selectedSessionId, state.revision]);

  const handleCreateViaAI = async (description: string) => {
    // 通过对话让 AI 创建卡片
    const prompt = `请用 create_card_template 工具创建一个工作台卡片：${description}。根据描述自动判断合适的实体类型名、展示字段、字段中文名、图标。创建后简要说明这个卡片怎么用。`;
    await window.piApp.submitComposer(prompt);
    // 等 AI 处理完后刷新
    setTimeout(fetchAll, 3000);
  };

  // 收起时保持挂载（只切 class 走 CSS 过渡）——卸载重挂会导致重新拉数据+重建图谱，
  // 展开动画因此卡顿；收起期间也不再发刷新请求
  return (
    <aside className={`status-panel ${sidebarCollapsed ? "collapsed" : ""}`} style={width && !sidebarCollapsed ? { width } : {}}>
      {onResize && <div className="status-resize-handle" onMouseDown={onResize} />}
      <div className="status-panel-header">
        <h2>工作台概览</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="refresh-btn" onClick={() => setShowPicker(true)} title="添加卡片"><Plus size={13} /></button>
          <button className="refresh-btn" onClick={fetchAll} title="刷新"><RefreshCw size={12} /></button>
        </div>
      </div>

      <div className="status-panel-body">
      {/* 固定卡片：Wiki 知识库概览（受 showWikiStatsCard 配置控制） */}
      {wikiStatsVisible && wikiStats && (
        <WikiStatsCard stats={wikiStats} />
      )}


      {loading ? (
        <div className="status-empty">加载中...</div>
      ) : (
        cards.map((card, index) => (
          <DynamicCard
            key={card.id}
            config={card}
            data={cardData[card.id] ?? []}
            onRemove={() => handleRemoveCard(card.id)}
            onMoveUp={() => handleMoveCard(index, "up")}
            onMoveDown={() => handleMoveCard(index, "down")}
            canMoveUp={index > 0}
            canMoveDown={index < cards.length - 1}
            onRefresh={fetchAll}
          />
        ))
      )}

      {cards.length === 0 && !loading && (
        <div className="status-card" style={{ textAlign: "center", padding: 24 }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>没有卡片</p>
          <button className="btn-primary" onClick={() => setShowPicker(true)}><Plus size={13} /> 添加卡片</button>
        </div>
      )}

      {onFeedback && (
        <div className="status-panel-footer">
          <button className="status-feedback-btn" onClick={onFeedback}>
            <MessageSquareHeart size={13} /> 反馈
          </button>
        </div>
      )}

      </div>

      {showPicker && (
        <CardPicker
          existingIds={cards.map((c) => c.id)}
          onAdd={handleAddCard}
          onCreateViaAI={handleCreateViaAI}
          onClose={() => setShowPicker(false)}
        />
      )}
    </aside>
  );
}

/** 固定卡片：Wiki 知识库概览（memo：stats 未变时不重渲染 SVG/统计块） */
const WikiStatsCard = memo(function WikiStatsCard({ stats }: {
  stats: { totalPages: number; categories: Record<string, number>; crossReferences: number; recentUpdates: number };
}) {
  return (
    <div className="status-card wiki-stats-card">
      <div className="card-title">
        <BookOpen size={14} /> 知识库概览
      </div>
      <div className="wiki-stats-grid">
        <div className="wiki-stat-item">
          <FileText size={16} />
          <span className="wiki-stat-num">{stats.totalPages}</span>
          <span className="wiki-stat-label">总页面</span>
        </div>
        <div className="wiki-stat-item">
          <Link2 size={16} />
          <span className="wiki-stat-num">{stats.crossReferences}</span>
          <span className="wiki-stat-label">交叉引用</span>
        </div>
        <div className="wiki-stat-item">
          <TrendingUp size={16} />
          <span className="wiki-stat-num">{stats.recentUpdates}</span>
          <span className="wiki-stat-label">近7天更新</span>
        </div>
      </div>
    </div>
  );
});

/** P5 补全：知识图谱迷你可视化（SVG 径向布局：分类成簇，边为引用关系） */
function WikiGraphCard({ graph }: {
  graph: { nodes: Array<{ id: string; title: string; category: string }>; edges: Array<{ source: string; target: string }> };
}) {
  const W = 260, H = 170, CX = W / 2, CY = H / 2;
  if (graph.nodes.length === 0) return null;
  // 按 category 分簇，簇沿圆周分布，节点在簇内小半径散布
  const byCat = new Map<string, typeof graph.nodes>();
  for (const n of graph.nodes) {
    const list = byCat.get(n.category) ?? [];
    list.push(n);
    byCat.set(n.category, list);
  }
  const cats = [...byCat.keys()];
  const pos = new Map<string, { x: number; y: number }>();
  const RING = Math.min(CX, CY) - 22;
  cats.forEach((cat, ci) => {
    const members = byCat.get(cat)!;
    const ca = (ci / Math.max(1, cats.length)) * Math.PI * 2 - Math.PI / 2;
    const cx = CX + Math.cos(ca) * RING * 0.72;
    const cy = CY + Math.sin(ca) * RING * 0.72;
    members.forEach((n, mi) => {
      const na = (mi / Math.max(1, members.length)) * Math.PI * 2;
      const spread = members.length > 1 ? 16 : 0;
      pos.set(n.id, { x: cx + Math.cos(na) * spread, y: cy + Math.sin(na) * spread });
    });
  });
  const CAT_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#f97316"];
  const catColor = new Map(cats.map((c, i) => [c, CAT_COLORS[i % CAT_COLORS.length]!]));
  return (
    <div className="status-card wiki-graph-card">
      <div className="card-title">
        <Share2 size={14} /> 知识图谱 · {graph.nodes.length} 页
      </div>
      <svg width={W} height={H} style={{ display: "block", margin: "0 auto" }}>
        {graph.edges.map((e, i) => {
          const a = pos.get(e.source), b = pos.get(e.target);
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth={0.7} opacity={0.55} />;
        })}
        {graph.nodes.map((n) => {
          const p2 = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <circle cx={p2.x} cy={p2.y} r={4} fill={catColor.get(n.category) ?? "#3b82f6"} opacity={0.9}>
                <title>{`${n.category} / ${n.title}`}</title>
              </circle>
            </g>
          );
        })}
        {cats.length > 1 && cats.map((c) => {
          const p2 = pos.get(byCat.get(c)![0]!.id)!;
          return (
            <text key={c} x={p2.x} y={p2.y - 8} textAnchor="middle" fontSize={7.5} fill="var(--text-muted)">
              {c.replace(/\.md$/, "")}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/** 通用动态卡片：根据 config.displayFields 渲染 */
function DynamicCard({ config, data, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown, onRefresh }: {
  config: CardConfig;
  data: EntityData[];
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRefresh?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const Icon = (LucideIcons as any)[config.icon] ?? LucideIcons.FileText;

  return (
    <div className="status-card" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="card-title">
        <Icon size={14} /> {config.title} ({data.length})
        {hovered && (
          <div className="card-controls">
            {canMoveUp && <button className="card-ctrl-btn" onClick={onMoveUp}><ChevronUp size={12} /></button>}
            {canMoveDown && <button className="card-ctrl-btn" onClick={onMoveDown}><ChevronDown size={12} /></button>}
            <button className="card-ctrl-btn danger" onClick={onRemove}><X size={12} /></button>
          </div>
        )}
      </div>
      {data.length === 0 ? (
        <div className="status-empty">暂无数据</div>
      ) : (
        (() => {
          // 待办类：未完成优先，已完成沉底；最多显示 5 条未完成 + 完成数汇总
          const isTodoType = config.entityType === "todos";
          let displayData = data;
          let doneCount = 0;
          let hiddenCount = 0;
          if (isTodoType) {
            const sorted = [...data].sort((a, b) => {
              // 已完成沉底
              const aDone = String(a.frontmatter.status) === "done" ? 1 : 0;
              const bDone = String(b.frontmatter.status) === "done" ? 1 : 0;
              if (aDone !== bDone) return aDone - bDone;
              // 同状态按 priority 降序
              const aPri = Number(a.frontmatter.priority) || 3;
              const bPri = Number(b.frontmatter.priority) || 3;
              if (aPri !== bPri) return bPri - aPri;
              // 再按 dueDate 升序
              return String(a.frontmatter.dueDate ?? "9999").localeCompare(String(b.frontmatter.dueDate ?? "9999"));
            });
            doneCount = sorted.filter((e) => String(e.frontmatter.status) === "done").length;
            const incomplete = sorted.filter((e) => String(e.frontmatter.status) !== "done");
            // 最多显示 5 条未完成 + 全部已完成
            const maxIncomplete = 5;
            hiddenCount = Math.max(0, incomplete.length - maxIncomplete);
            displayData = [
              ...incomplete.slice(0, maxIncomplete),
              ...sorted.filter((e) => String(e.frontmatter.status) === "done"),
            ];
          }
          return (<>
        {displayData.map((entity, i) => {
          const hasStatus = "status" in entity.frontmatter;
          const entityId = String(entity.frontmatter.id ?? "");
          const isDone = String(entity.frontmatter.status ?? "") === "done";
          return (
          <div key={i} className={`card-row ${isDone ? "todo-done" : ""}`}>
            {/* 待办勾选框：有 status 字段的实体显示 checkbox */}
            {hasStatus && config.entityType !== "maintenance" && (
              <input
                type="checkbox"
                className="todo-check"
                checked={isDone}
                onChange={async () => {
                  const newStatus = isDone ? "todo" : "done";
                  try {
                    await (window as any).piApp.updateEntity(config.entityType, entityId, { status: newStatus });
                    if (onRefresh) onRefresh();
                  } catch (e) {
                    console.error("[todo-check] 更新失败:", e);
                  }
                }}
              />
            )}
            {config.displayFields.map((field) => {
              if (field === "status") return null;
              const val = entity.frontmatter[field];
              if (field === config.displayFields[0] || (field === config.displayFields.find(f => f !== "status"))) {
                return <span key={field} className="card-label" style={isDone ? { textDecoration: "line-through", color: "var(--done-color)" } : {}}>{formatVal(val)}</span>;
              }
              return <span key={field} className={`card-val ${statusClass(field, val)}`}>{formatVal(val)}</span>;
            })}
          </div>
          );
        })}
        {hiddenCount > 0 && <div className="card-more">+{hiddenCount} 条待办未显示</div>}
        {isTodoType && doneCount > 0 && <div className="card-more" style={{ color: "var(--done-color)" }}>{doneCount} 项已完成</div>}
        </>);
        })()
      )}
    </div>
  );
}

function formatVal(val: unknown): string {
  if (val === undefined || val === null) return "—";
  if (typeof val === "number") return String(val);
  return String(val);
}

function statusClass(field: string, val: unknown): string {
  if (field !== "status") return "";
  const s = String(val ?? "");
  if (s === "expiring") return "status-expiring";
  if (s === "expired") return "status-expired";
  if (s === "active") return "status-active";
  return "";
}
