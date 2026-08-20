import { useState, useEffect } from "react";
import { X, GitBranch, ChevronRight, ChevronDown } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

interface TreeNode {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  preview?: string;
  label?: string;
  role?: string;
  children: TreeNode[];
}

interface Props {
  state: DesktopAppState;
  onClose: () => void;
}

/** #5 会话分支树 + fork 导航 */
export function TreeModal({ state, onClose }: Props) {
  const [tree, setTree] = useState<{ roots: TreeNode[]; leafId: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!state.selectedWorkspaceId || !state.selectedSessionId) return;
      try {
        const result = await window.piApp.getSessionTree({
          workspaceId: state.selectedWorkspaceId,
          sessionId: state.selectedSessionId,
        });
        setTree(result as any);
      } catch (e) {
        console.error("[tree] 加载失败:", e);
      }
      setLoading(false);
    };
    load();
  }, [state.selectedWorkspaceId, state.selectedSessionId]);

  const handleNavigate = async (targetId: string) => {
    if (!state.selectedWorkspaceId || !state.selectedSessionId) return;
    try {
      await window.piApp.navigateSessionTree(
        { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId },
        targetId,
        {},
      );
      onClose();
    } catch (e) {
      console.error("[tree] 导航失败:", e);
    }
  };

  return (
    <div className="archive-overlay" onClick={onClose}>
      <div className="archive-modal" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="archive-header">
          <h2><GitBranch size={16} style={{ display: "inline", marginRight: 6 }} />会话分支</h2>
          <button className="archive-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ padding: 16, maxHeight: "60vh", overflowY: "auto" }}>
          {loading ? (
            <div className="status-empty" style={{ textAlign: "center", padding: 24 }}>加载中...</div>
          ) : tree && tree.roots.length > 0 ? (
            tree.roots.map((node) => (
              <TreeBranch key={node.id} node={node} leafId={tree.leafId} onNavigate={handleNavigate} depth={0} />
            ))
          ) : (
            <div className="status-empty" style={{ textAlign: "center", padding: 24 }}>暂无分支历史</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeBranch({ node, leafId, onNavigate, depth }: {
  node: TreeNode;
  leafId: string | null;
  onNavigate: (id: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const isLeaf = node.id === leafId;

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div
        className={`tree-node ${isLeaf ? "current" : ""}`}
        onClick={() => onNavigate(node.id)}
        style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
      >
        {hasChildren ? (
          <span onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }} style={{ cursor: "pointer", flexShrink: 0 }}>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isLeaf ? "var(--accent-blue)" : "var(--text-secondary)", fontWeight: isLeaf ? 500 : 400 }}>
          {node.label && <span style={{ color: "var(--text-muted)", fontSize: 11, marginRight: 4 }}>[{node.label}]</span>}
          {node.title}
        </span>
        {isLeaf && <span style={{ fontSize: 10, color: "var(--accent-blue)" }}>当前</span>}
      </div>
      {expanded && hasChildren && node.children.map((child) => (
        <TreeBranch key={child.id} node={child} leafId={leafId} onNavigate={onNavigate} depth={depth + 1} />
      ))}
    </div>
  );
}
