/**
 * 知识库独立页面（侧栏「知识库」入口）。
 *
 * 两栏布局：左侧文件夹树（点击展开/收起，点击文件查看）+ 右侧正文阅读。
 * 图谱视角：莫兰迪配色，Obsidian 式交互——节点可拖拽、悬停高亮关联、
 * 点击节点弹出信息卡（标题/分类/引用数），可从信息卡打开页面。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Share2, X, RefreshCw, FileText, Folder, FolderOpen, ChevronRight, ChevronDown, ExternalLink } from "lucide-react";
import { MessageMarkdown } from "../message-markdown";

interface PageSummary {
  relPath: string;
  title: string;
  category: string;
  updatedAt: string;
}

interface WikiGraphData {
  nodes: Array<{ id: string; title: string; category: string }>;
  edges: Array<{ source: string; target: string }>;
}

/** 莫兰迪色板（低饱和灰调） */
const MORANDI = [
  "#A8B0C2", // 雾蓝
  "#B3BBA6", // 灰绿
  "#C9B2A0", // 豆沙
  "#BFAEC4", // 灰紫
  "#A9BFC0", // 灰青
  "#C7BCA1", // 燕麦
  "#C0A9A9", // 灰粉
  "#A9C0B4", // 尤加利
  "#BDBDBD", // 暖灰
  "#C4B5A5", // 浅驼
];

export function WikiView(_props: { onClose?: () => void }) {
  const api = window as any;
  const [mode, setMode] = useState<"list" | "graph">("list");
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [graph, setGraph] = useState<WikiGraphData | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 左右分栏可拖动调整（与状态栏 resize 同款交互）
  const [treeWidth, setTreeWidth] = useState(320);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    const containerLeft = container?.getBoundingClientRect().left ?? 0;
    const onMove = (ev: MouseEvent) => {
      const w = ev.clientX - containerLeft;
      setTreeWidth(Math.max(200, Math.min(520, w)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const [activePage, setActivePage] = useState<{ relPath: string; title: string; content: string } | null>(null);
  const [activeRelPath, setActiveRelPath] = useState("");

  const load = async () => {
    try {
      const [p, g] = await Promise.all([
        api.piApp?.getWikiPages?.(),
        api.piApp?.getWikiGraph?.(),
      ]);
      if (p) setPages(p);
      if (g) setGraph(g);
    } catch { /* ignore */ }
  };
  useEffect(() => { load(); }, []);

  const openPage = async (relPath: string) => {
    try {
      const page = await api.piApp?.readWikiPage?.(relPath);
      if (page) { setActivePage(page); setActiveRelPath(relPath); }
    } catch { /* ignore */ }
  };

  // 正文 = 去 frontmatter；元信息 = frontmatter 关键字段
  const { pageBody, pageMeta } = useMemo(() => {
    const content = activePage?.content ?? "";
    const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { pageBody: content, pageMeta: {} as Record<string, string | string[]> };
    const meta: Record<string, string | string[]> = {};
    for (const line of m[1]!.split("\n")) {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (!kv) continue;
      const [, key, raw] = kv as unknown as [string, string, string];
      const tagList = raw!.match(/^\[(.*)\]$/);
      meta[key] = tagList ? tagList[1]!.split(",").map((t) => t.trim()).filter(Boolean) : raw!.trim();
    }
    return { pageBody: content.slice(m[0].length), pageMeta: meta };
  }, [activePage]);

  // 分类树：一级目录（含子目录，如 knowledge/cases）
  const tree = useMemo(() => {
    if (!pages) return [] as Array<{ cat: string; pages: PageSummary[] }>;
    const map = new Map<string, PageSummary[]>();
    for (const p of pages) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, list]) => ({ cat, pages: list }));
  }, [pages]);

  const toggleCat = (cat: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  return (
    <div className="wiki-page">
      <div className="wiki-page-header">
        <div className="wiki-page-title">
          <BookOpen size={15} /> 知识库
          {pages && <span className="wiki-page-count">{pages.length} 页 · {tree.length} 个分类</span>}
        </div>
        <div className="wiki-page-actions">
          <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>
            <FileText size={12} /> 列表
          </button>
          <button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
            <Share2 size={12} /> 图谱
          </button>
          <button onClick={load} title="刷新"><RefreshCw size={12} /></button>
        </div>
      </div>

      {mode === "list" ? (
        <div className="wiki-page-body">
          <aside className="wiki-tree" style={{ width: treeWidth }}>
            {tree.map(({ cat, pages: list }) => {
              const isOpen = expanded.has(cat);
              return (
                <div key={cat} className="wiki-tree-group">
                  <div className="wiki-tree-folder" onClick={() => toggleCat(cat)}>
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
                    <span className="name">{cat}</span>
                    <span className="count">{list.length}</span>
                  </div>
                  {isOpen && list.map((p) => (
                    <div
                      key={p.relPath}
                      className={`wiki-tree-file ${activeRelPath === p.relPath ? "active" : ""}`}
                      onClick={() => openPage(p.relPath)}
                    >
                      <FileText size={11} />
                      <span className="name">{p.title}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {pages && pages.length === 0 && (
              <div className="wiki-empty" style={{ height: 120 }}>知识库还是空的，试试对我说"帮我初始化工作环境"</div>
            )}
          </aside>
          <div className="wiki-split-handle" onMouseDown={startDrag} />
          <div className="wiki-reader">
            {activePage && activePage.relPath === "log.md" ? (
              <WikiLogView content={activePage.content} />
            ) : activePage ? (
              <>
                <div className="wiki-reader-title">{pageMeta.title || activePage.title}</div>
                <div className="wiki-reader-meta">
                  {pageMeta.type && <span className="meta-chip">{pageMeta.type}</span>}
                  {pageMeta.category && <span className="meta-chip">{pageMeta.category}</span>}
                  {pageMeta.updated && <span className="meta-chip">更新 {pageMeta.updated}</span>}
                  {(Array.isArray(pageMeta.tags) ? pageMeta.tags : []).map((t) => <span className="meta-chip tag" key={t}>#{t}</span>)}
                </div>
                <MessageMarkdown text={pageBody} />
              </>
            ) : (
              <div className="wiki-empty">点击左侧文件查看内容</div>
            )}
          </div>
        </div>
      ) : (
        <div className="wiki-graph-full">
          {graph && graph.nodes.length > 0 ? (
            <WikiGraphObsidian graph={graph} onOpen={(id) => { openPage(id); setMode("list"); }} />
          ) : (
            <div className="wiki-empty">暂无图谱数据</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Obsidian 式图谱：莫兰迪配色 + 节点拖拽 + 悬停高亮关联 + 点选信息卡 */
function WikiGraphObsidian({ graph, onOpen }: { graph: WikiGraphData; onOpen: (relPath: string) => void }) {
  const W = 980, H = 560, CX = W / 2, CY = H / 2;
  const svgRef = useRef<SVGSVGElement>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selected, setSelected] = useState<(typeof graph.nodes)[number] | null>(null);
  const layoutDone = useRef(false);

  // 初始径向布局（只算一次，之后由用户拖拽接管）
  const initialPos = useMemo(() => {
    const byCat = new Map<string, typeof graph.nodes>();
    for (const n of graph.nodes) {
      const list = byCat.get(n.category) ?? [];
      list.push(n);
      byCat.set(n.category, list);
    }
    const cats = [...byCat.keys()];
    const pos = new Map<string, { x: number; y: number }>();
    const RING = Math.min(CX, CY) - 90;
    cats.forEach((cat, ci) => {
      const members = byCat.get(cat)!;
      const ca = (ci / Math.max(1, cats.length)) * Math.PI * 2 - Math.PI / 2;
      const cx = CX + Math.cos(ca) * RING * 0.8;
      const cy = CY + Math.sin(ca) * RING * 0.8;
      members.forEach((n, mi) => {
        const na = (mi / Math.max(1, members.length)) * Math.PI * 2;
        const spread = members.length > 1 ? Math.min(80, 18 + members.length * 8) : 0;
        pos.set(n.id, { x: cx + Math.cos(na) * spread, y: cy + Math.sin(na) * spread * 0.7 });
      });
    });
    return { pos, cats, byCat };
  }, [graph]);

  if (!layoutDone.current) {
    layoutDone.current = true;
    setPositions(initialPos.pos);
  }

  const catColor = (category: string) => {
    const cats = initialPos.cats;
    const i = cats.indexOf(category);
    return MORANDI[(i < 0 ? 0 : i) % MORANDI.length]!;
  };

  // 关联集合（悬停/选中高亮）
  const related = useMemo(() => {
    const focus = hoverId ?? selected?.id ?? null;
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const e of graph.edges) {
      if (e.source === focus) set.add(e.target);
      if (e.target === focus) set.add(e.source);
    }
    return set;
  }, [hoverId, selected, graph.edges]);

  const toSvgCoords = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H,
    };
  };

  const handleMove = (e: React.PointerEvent) => {
    if (!dragId) return;
    const p = toSvgCoords(e.clientX, e.clientY);
    setPositions((prev) => {
      const next = new Map(prev);
      next.set(dragId, p);
      return next;
    });
  };

  const nodeR = (id: string) => {
    const links = graph.edges.filter((e) => e.source === id || e.target === id).length;
    return 6 + Math.min(6, links * 1.5);
  };

  return (
    <div className="wiki-graph-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "100%", touchAction: "none" }}
        onPointerMove={handleMove}
        onPointerUp={() => setDragId(null)}
        onPointerLeave={() => setDragId(null)}
      >
        {/* 引用连线：焦点模式外淡出 */}
        {graph.edges.map((e, i) => {
          const a = positions.get(e.source), b = positions.get(e.target);
          if (!a || !b) return null;
          const focused = related && (related.has(e.source) || related.has(e.target));
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={focused ? "#8a8f98" : "var(--border-strong)"}
              strokeWidth={focused ? 1.4 : 0.9}
              opacity={related && !focused ? 0.08 : 0.5}
            />
          );
        })}
        {/* 节点 */}
        {graph.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const dim = related && !related.has(n.id);
          const isFocus = hoverId === n.id || selected?.id === n.id;
          return (
            <g
              key={n.id}
              style={{ cursor: "grab" }}
              opacity={dim ? 0.15 : 1}
              onPointerDown={(e) => { e.preventDefault(); setDragId(n.id); setSelected(n); }}
              onMouseEnter={() => setHoverId(n.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              <circle cx={p.x} cy={p.y} r={nodeR(n.id) + (isFocus ? 3 : 0)} fill={catColor(n.category)} stroke="rgba(255,255,255,0.7)" strokeWidth={isFocus ? 2 : 1}>
                <title>{n.title}</title>
              </circle>
              <text x={p.x} y={p.y + nodeR(n.id) + 14} textAnchor="middle" fontSize={10} fill="var(--text-muted)">
                {n.title.length > 12 ? n.title.slice(0, 12) + "…" : n.title}
              </text>
            </g>
          );
        })}
        {/* 分类标注 */}
        {initialPos.cats.map((c) => {
          const first = initialPos.byCat.get(c)![0]!;
          const p = positions.get(first.id);
          if (!p) return null;
          return (
            <text key={c} x={p.x} y={p.y - 46} textAnchor="middle" fontSize={12} fontWeight={600} fill={catColor(c)}>
              {c}
            </text>
          );
        })}
      </svg>

      {/* 选中节点信息卡（Obsidian 式）：标题/分类/引用数 + 打开 */}
      {selected && (
        <div className="wiki-graph-info">
          <div className="wiki-graph-info-title">
            <span className="dot" style={{ background: catColor(selected.category) }} />
            {selected.title}
            <button className="close" onClick={() => setSelected(null)}><X size={12} /></button>
          </div>
          <div className="wiki-graph-info-row">分类：{selected.category}</div>
          <div className="wiki-graph-info-row">
            引用：{graph.edges.filter((e) => e.source === selected.id || e.target === selected.id).length} 条关联
          </div>
          <button className="open-btn" onClick={() => onOpen(selected.id)}>
            <ExternalLink size={11} /> 打开页面
          </button>
        </div>
      )}

      <div className="wiki-graph-legend">
        {initialPos.cats.slice(0, 8).map((c) => (
          <span key={c}><i style={{ background: catColor(c) }} />{c}</span>
        ))}
      </div>
      <div className="wiki-graph-hint">拖拽移动节点 · 悬停高亮关联 · 点击查看信息</div>
    </div>
  );
}

/** log.md 专属视图：解析逐行日志（兼容旧无前缀/新 "- " 列表格式），按天分组，动作徽章 */
function WikiLogView({ content }: { content: string }) {
  const groups = useMemo(() => {
    const entries: Array<{ date: string; action: string; detail: string }> = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim().replace(/^- /, "");
      if (!line) continue;
      const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (!m) continue;
      const rest = m[2]!;
      const parts = rest.split(" | ");
      entries.push({ date: m[1]!, action: parts[0] ?? "", detail: parts.slice(1).join(" · ") });
    }
    // 按日期分组（新日期在前）
    const byDate = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byDate.get(e.date) ?? [];
      list.push(e);
      byDate.set(e.date, list);
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [content]);

  const actionTone = (action: string) => {
    if (/^create|^init|^seed/.test(action)) return "create";
    if (/^update|^advance|^ingest/.test(action)) return "update";
    if (/^tool_|hook|dangerous/.test(action)) return "tool";
    if (/block|abort|error/.test(action)) return "warn";
    return "";
  };

  return (
    <div className="wiki-log">
      <div className="wiki-reader-title">操作日志</div>
      {groups.map(([date, list]) => (
        <div key={date} className="wiki-log-day">
          <div className="wiki-log-date">{date}<span className="count">{list.length} 条</span></div>
          {list.map((e, i) => (
            <div key={i} className="wiki-log-entry">
              <span className={`wiki-log-action ${actionTone(e.action)}`}>{e.action}</span>
              <span className="wiki-log-detail">{e.detail || "—"}</span>
            </div>
          ))}
        </div>
      ))}
      {groups.length === 0 && <div className="wiki-empty">暂无日志</div>}
    </div>
  );
}
