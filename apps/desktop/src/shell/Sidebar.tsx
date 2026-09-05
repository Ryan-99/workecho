import { useState, useEffect, useRef } from "react";
import { appConfirm } from "./app-dialog";
import {
  Plus, Trash2, Archive, Settings as SettingsIcon, Pin,
  ChevronRight, ChevronDown, FolderPlus, Folder, X, Clock, BookOpen } from "lucide-react";
import type { SessionRecord, OrchestrationChildThread } from "../desktop-state";

interface SessionGroup {
  id: string;
  name: string;
  order: number;
}

interface GroupsConfig {
  groups: SessionGroup[];
  assignmentBySession: Record<string, string>;
}

interface Props {
  sessions: readonly SessionRecord[];
  orchestrationChildren?: readonly OrchestrationChildThread[];
  activeSessionId: string;
  collapsed: boolean;
  archivedCount: number;
  workspaceId: string;
  width: number;
  /** 返回新建会话的 id（供组内新建时归入分组） */
  onNewSession: () => Promise<string | undefined>;
  onSelectSession: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onOpenSettings: () => void;
  onOpenArchive: () => void;
  onResize: (e: React.MouseEvent) => void;
}

const UNCATEGORIZED = "__uncategorized__";
const COLLAPSE_KEY = "sidebar-collapsed-groups";
const DRAG_MIME = "application/x-workecho-session";

export function Sidebar({
  sessions, orchestrationChildren = [], activeSessionId, collapsed, archivedCount, workspaceId, width,
  onNewSession, onSelectSession, onArchiveSession, onDeleteSession,
  onOpenSettings, onOpenArchive, onResize,
}: Props) {
  const [groupsConfig, setGroupsConfig] = useState<GroupsConfig>({ groups: [], assignmentBySession: {} });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [dragSessionId, setDragSessionId] = useState<string | null>(null);
  const api = window as any;

  // 加载分组配置
  useEffect(() => {
    const load = async () => {
      try {
        const gc = await api.piApp?.getSessionGroups?.();
        if (gc) setGroupsConfig(gc);
      } catch { /* 静默降级 */ }
    };
    load();
    // 从 localStorage 恢复折叠状态
    try {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      if (saved) setCollapsedGroups(new Set(JSON.parse(saved)));
    } catch { /* ignore */ }
  }, [workspaceId]);

  // 关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const toggleGroup = (gid: string) => {
    const next = new Set(collapsedGroups);
    if (next.has(gid)) next.delete(gid);
    else next.add(gid);
    setCollapsedGroups(next);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
  };

  const handleCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) { setCreatingGroup(false); return; }
    try {
      const updated = await api.piApp?.createSessionGroup?.(name);
      if (updated) setGroupsConfig(updated);
    } catch { /* ignore */ }
    setNewGroupName("");
    setCreatingGroup(false);
  };

  const handleRemoveGroup = async (gid: string) => {
    try {
      const updated = await api.piApp?.removeSessionGroup?.(gid);
      if (updated) setGroupsConfig(updated);
    } catch { /* ignore */ }
  };

  const handleAssign = async (sessionId: string, gid: string | null) => {
    try {
      const updated = await api.piApp?.assignSessionGroup?.(sessionId, gid);
      if (updated) setGroupsConfig(updated);
    } catch { /* ignore */ }
    setContextMenu(null);
  };

  /** 组内新建：建会话后立刻归入该分组（分组是 client-side overlay，分配走独立 IPC） */
  const handleNewInGroup = async (gid: string | null) => {
    const sid = await onNewSession();
    if (sid) await handleAssign(sid, gid);
  };

  /** 拖拽落点：把会话移入目标分组（未分类 = 移出分组） */
  const handleDropOnGroup = (e: React.DragEvent, gid: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const sid = e.dataTransfer.getData(DRAG_MIME) || dragSessionId;
    setDragSessionId(null);
    if (sid) void handleAssign(sid, gid);
  };

  // 子线程父子映射（orchestration）：子会话嵌在父会话下展示，不再平铺
  const childrenByParent = new Map<string, OrchestrationChildThread[]>();
  const childSessionIds = new Set<string>();
  for (const c of orchestrationChildren) {
    const list = childrenByParent.get(c.parentSessionId) ?? [];
    list.push(c);
    childrenByParent.set(c.parentSessionId, list);
    childSessionIds.add(c.childSessionId);
  }
  // 子会话不进平铺列表（在父行下渲染）；父会话不在列表的孤儿子会话保留平铺避免消失
  const visibleSessions = sessions.filter((s) => !childSessionIds.has(s.id));

  // 按 group 分桶
  const buckets: Record<string, SessionRecord[]> = {};
  for (const g of groupsConfig.groups) buckets[g.id] = [];
  buckets[UNCATEGORIZED] = [];
  for (const s of visibleSessions) {
    const gid = groupsConfig.assignmentBySession[s.id];
    if (gid && buckets[gid]) buckets[gid].push(s);
    else buckets[UNCATEGORIZED].push(s);
  }
  const orphanChildSessions = sessions.filter(
    (s) => childSessionIds.has(s.id) && !visibleSessions.includes(s),
  );
  for (const s of orphanChildSessions) buckets[UNCATEGORIZED].push(s);

  if (collapsed) return <aside className="sidebar collapsed" />;

  const orderedGroups = [...groupsConfig.groups].sort((a, b) => a.order - b.order);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-resize-handle" onMouseDown={onResize} />

      {/* ═══ 顶部固定区 ═══ */}
      <div className="sidebar-topbar">
        <button className="new-btn" onClick={onNewSession}><Plus size={15} /> 新建会话</button>

        {/* 定时任务入口（进入管理页面） */}
        <button
          className="schedule-entry-btn"
          onClick={() => window.dispatchEvent(new CustomEvent("open-schedule-manager"))}
        >
          <Clock size={13} /> 定时任务
        </button>

        {/* 知识库入口（独立页面：浏览/图谱） */}
        <button
          className="schedule-entry-btn"
          onClick={() => window.dispatchEvent(new CustomEvent("open-wiki-manager"))}
        >
          <BookOpen size={13} /> 知识库
        </button>
      </div>

      {/* ═══ 中间滚动区：分组 session 列表 ═══ */}
      <div className="session-list">
        {/* 新建分组 */}
        {creatingGroup ? (
          <div className="group-create-inline">
            <input
              autoFocus
              className="group-name-input"
              placeholder="分组名称"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") { setCreatingGroup(false); setNewGroupName(""); } }}
              onBlur={handleCreateGroup}
            />
          </div>
        ) : (
          <button className="group-add-btn" onClick={() => setCreatingGroup(true)}>
            <FolderPlus size={11} /> 新建分组
          </button>
        )}

        {sessions.length === 0 && (
          <div className="session-empty">新建第一个会话开始对话</div>
        )}

        {/* 按分组渲染 */}
        {orderedGroups.map((g) => (
          <SessionGroupSection
            key={g.id}
            group={g}
            sessions={buckets[g.id] ?? []}
            childrenByParent={childrenByParent}
            activeSessionId={activeSessionId}
            workspaceId={workspaceId}
            isCollapsed={collapsedGroups.has(g.id)}
            onToggle={() => toggleGroup(g.id)}
            onRemove={() => handleRemoveGroup(g.id)}
            onNewInGroup={() => void handleNewInGroup(g.id)}
            onDropOnGroup={handleDropOnGroup}
            onSelect={onSelectSession}
            onArchive={onArchiveSession}
            onDelete={onDeleteSession}
            onDragStartSession={(sid) => setDragSessionId(sid)}
            onDragEndSession={() => setDragSessionId(null)}
            onContextMenu={(e, sid) => {
              e.preventDefault();
              setContextMenu({ sessionId: sid, x: e.clientX, y: e.clientY });
            }}
          />
        ))}

        {/* 未分类 */}
        {(buckets[UNCATEGORIZED]?.length > 0 || orderedGroups.length === 0) && (
          <SessionGroupSection
            group={{ id: UNCATEGORIZED, name: "未分类", order: -1 }}
            sessions={buckets[UNCATEGORIZED] ?? sessions}
            childrenByParent={childrenByParent}
            activeSessionId={activeSessionId}
            workspaceId={workspaceId}
            isCollapsed={collapsedGroups.has(UNCATEGORIZED)}
            onToggle={() => toggleGroup(UNCATEGORIZED)}
            onRemove={() => {}}
            onNewInGroup={() => void handleNewInGroup(null)}
            onDropOnGroup={handleDropOnGroup}
            onSelect={onSelectSession}
            onArchive={onArchiveSession}
            onDelete={onDeleteSession}
            onDragStartSession={(sid) => setDragSessionId(sid)}
            onDragEndSession={() => setDragSessionId(null)}
            onContextMenu={(e, sid) => {
              e.preventDefault();
              setContextMenu({ sessionId: sid, x: e.clientX, y: e.clientY });
            }}
            isUncategorized
          />
        )}
      </div>

      {/* ═══ 右键菜单：移动到分组 ═══ */}
      {contextMenu && (
        <div
          className="session-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ctx-menu-label">移动到分组</div>
          {orderedGroups.map((g) => (
            <button
              key={g.id}
              className="ctx-menu-item"
              onClick={() => handleAssign(contextMenu.sessionId, g.id)}
            >
              <Folder size={11} /> {g.name}
            </button>
          ))}
          {groupsConfig.assignmentBySession[contextMenu.sessionId] && (
            <button
              className="ctx-menu-item"
              onClick={() => handleAssign(contextMenu.sessionId, null)}
            >
              <X size={11} /> 移出分组
            </button>
          )}
        </div>
      )}

      {/* ═══ 底部 footer ═══ */}
      <div className="sidebar-footer">
        <button onClick={onOpenArchive} title="归档管理"><Archive size={14} /> 归档{archivedCount > 0 && <span className="archive-badge">{archivedCount}</span>}</button>
        <button onClick={onOpenSettings}><SettingsIcon size={14} /> 设置</button>
      </div>
    </aside>
  );
}

/** 单个分组区块（可作拖拽落点；标题行带组内新建按钮） */
function SessionGroupSection({
  group, sessions, childrenByParent, activeSessionId, workspaceId,
  isCollapsed, onToggle, onRemove, onNewInGroup, onDropOnGroup, onSelect, onArchive, onDelete,
  onDragStartSession, onDragEndSession, onContextMenu, isUncategorized,
}: {
  group: SessionGroup;
  sessions: SessionRecord[];
  childrenByParent: Map<string, OrchestrationChildThread[]>;
  activeSessionId: string;
  workspaceId: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onNewInGroup: () => void;
  onDropOnGroup: (e: React.DragEvent, gid: string | null) => void;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStartSession: (sessionId: string) => void;
  onDragEndSession: () => void;
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void;
  isUncategorized?: boolean;
}) {
  const [isDropTarget, setIsDropTarget] = useState(false);
  // 拖拽悬停到折叠分组上时自动展开，便于直接落入
  const expandOnce = useRef(false);
  const targetGid = isUncategorized ? null : group.id;

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDropTarget(true);
    if (isCollapsed && !expandOnce.current) {
      expandOnce.current = true;
      onToggle();
    }
  };

  return (
    <div
      className={`session-group ${isCollapsed ? "collapsed" : ""} ${isDropTarget ? "drop-target" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDropTarget(false); }}
      onDrop={(e) => { setIsDropTarget(false); expandOnce.current = false; onDropOnGroup(e, targetGid); }}
    >
      <div className="session-group-header" onClick={onToggle}>
        {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="session-group-name">{group.name}</span>
        <span className="session-group-count">{sessions.length}</span>
        <button
          className="session-group-new"
          title="在此分组新建会话"
          onClick={(e) => { e.stopPropagation(); onNewInGroup(); }}
        ><Plus size={11} /></button>
        {!isUncategorized && (
          <button
            className="session-group-del"
            title="删除分组"
            onClick={(e) => { e.stopPropagation(); void appConfirm(`删除分组"${group.name}"？组内会话将回到未分类。`, { danger: true }).then((ok) => { if (ok) onRemove(); }); }}
          ><X size={11} /></button>
        )}
      </div>
      {!isCollapsed && sessions.length > 0 && (
        <div className="session-group-body">
          {sessions.map((s) => (
            <SessionItemRow
              key={s.id}
              session={s}
              childThreads={childrenByParent.get(s.id) ?? []}
              isActive={s.id === activeSessionId}
              activeSessionId={activeSessionId}
              workspaceId={workspaceId}
              onSelect={onSelect}
              onArchive={onArchive}
              onDelete={onDelete}
              onContextMenu={onContextMenu}
              onDragStart={onDragStartSession}
              onDragEnd={onDragEndSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 子线程状态徽标文案 */
const CHILD_STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  waiting: "等待",
  complete: "完成",
  failed: "失败",
};

/** 单条 session（含嵌套的 orchestration 子线程；可拖拽到分组） */
function SessionItemRow({
  session: s, childThreads = [], isActive, activeSessionId, workspaceId, onSelect, onArchive, onDelete, onContextMenu, onDragStart, onDragEnd,
}: {
  session: SessionRecord;
  childThreads?: readonly OrchestrationChildThread[];
  isActive: boolean;
  activeSessionId: string;
  workspaceId: string;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void;
  onDragStart: (sessionId: string) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className={`session-item-wrap ${isActive ? "active" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, s.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(s.id);
      }}
      onDragEnd={onDragEnd}
    >
    <div
      className={`session-item ${isActive ? "active" : ""}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => onContextMenu(e, s.id)}
    >
      {s.pinnedAt && <Pin size={11} className="session-pin-icon" />}
      <span className="title">{s.title || "新会话"}</span>
      {s.hasUnseenUpdate && !isActive && <span className="session-unread-dot" />}
      <div className="session-actions">
        <button
          className="action-btn"
          title={s.pinnedAt ? "取消置顶" : "置顶"}
          onClick={(e) => {
            e.stopPropagation();
            window.piApp.setSessionPinned({ workspaceId, sessionId: s.id }, !s.pinnedAt);
          }}
        ><Pin size={13} style={s.pinnedAt ? { color: "var(--accent-blue)" } : {}} /></button>
        <button
          className="action-btn"
          title="归档"
          onClick={(e) => { e.stopPropagation(); onArchive(s.id); }}
        ><Archive size={13} /></button>
        <button
          className="action-btn danger"
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            void appConfirm(`删除会话"${s.title || "新会话"}"？`, { danger: true }).then((ok) => { if (ok) onDelete(s.id); });
          }}
        ><Trash2 size={13} /></button>
      </div>
    </div>
    {childThreads.length > 0 && (
      <div className="child-thread-list">
        {childThreads.map((c) => (
          <div
            key={c.id}
            className={`child-thread-item ${c.childSessionId === activeSessionId ? "active" : ""}`}
            onClick={() => onSelect(c.childSessionId)}
            title={c.goal || c.title}
          >
            <span className="child-thread-arrow">↳</span>
            <span className="child-thread-title">{c.title || c.goal || "子任务"}</span>
            <span className={`child-thread-status status-${c.status}`}>
              {c.status === "running" && <span className="child-thread-pip" />}
              {CHILD_STATUS_LABEL[c.status] ?? c.status}
            </span>
          </div>
        ))}
      </div>
    )}
    </div>
  );
}
