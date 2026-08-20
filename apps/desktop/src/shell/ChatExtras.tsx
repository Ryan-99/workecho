import { useState, useEffect } from "react";
import { Layers, Clock, Copy, Download, BarChart3 } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

/** #6 排队消息指示器 — 显示在 composer 上方 */
export function QueuedMessages({ state }: { state: DesktopAppState }) {
  const queued = state.queuedComposerMessages ?? [];
  if (queued.length === 0) return null;
  return (
    <div style={{ padding: "4px 24px", display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--accent-blue)", borderBottom: "1px solid var(--border)" }}>
      <Layers size={12} /> {queued.length} 条排队消息
      {queued.map((q: any, i: number) => (
        <span key={i} style={{ background: "var(--bg-muted)", padding: "1px 6px", borderRadius: 4, fontSize: 10 }}>
          {(q.text ?? "").slice(0, 30)}
        </span>
      ))}
    </div>
  );
}

/** #4 会话统计 + #10 导出 — 下拉菜单 */
export function SessionMenu({ state }: { state: DesktopAppState }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<{ messageCount: number; toolCallCount: number; estimatedTokens: number } | null>(null);

  const fetchStats = async () => {
    const s = await (window as any).piApp?.getSessionStats?.();
    setStats(s);
  };

  const handleExport = async (format: "html" | "jsonl") => {
    const content = await (window as any).piApp?.exportSession?.(format);
    if (!content) return;
    const blob = new Blob([content], { type: format === "html" ? "text/html" : "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${Date.now()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  const handleCopy = async () => {
    const content = await (window as any).piApp?.exportSession?.("jsonl");
    if (content) {
      await navigator.clipboard.writeText(content);
      setOpen(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="composer__icon-btn" onClick={() => { setOpen(!open); if (!open) fetchStats(); }} title="会话操作">
        <BarChart3 size={15} />
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
          <div className="session-menu-dropdown">
            {stats && (
              <div className="session-menu-stats">
                <div>消息数: {stats.messageCount}</div>
                <div>工具调用: {stats.toolCallCount}</div>
                <div>估算 token: {stats.estimatedTokens}</div>
              </div>
            )}
            <button className="session-menu-item" onClick={handleCopy}><Copy size={13} /> 复制会话</button>
            <button className="session-menu-item" onClick={() => handleExport("html")}><Download size={13} /> 导出 HTML</button>
            <button className="session-menu-item" onClick={() => handleExport("jsonl")}><Download size={13} /> 导出 JSONL</button>
          </div>
        </>
      )}
    </div>
  );
}

/** #7 Skills 列表（设置页用） */
export function SkillsSection() {
  const [skills, setSkills] = useState<any[]>([]);

  useEffect(() => {
    // 从 runtime snapshot 读 skills
    const load = async () => {
      const state = await (window as any).piApp?.getState?.();
      const ws = state?.workspaces?.find((w: any) => w.id === state.selectedWorkspaceId);
      const runtime = state?.runtimeByWorkspace?.[ws?.id ?? ""];
      setSkills(runtime?.skills ?? []);
    };
    load();
  }, []);

  const toggleSkill = async (filePath: string, enabled: boolean) => {
    try {
      const state = await (window as any).piApp?.getState?.();
      const ws = state?.workspaces?.find((w: any) => w.id === state.selectedWorkspaceId);
      if (ws) {
        await window.piApp.setSkillEnabled(ws.id, filePath, !enabled);
        // 刷新
        const newState = await (window as any).piApp?.getState?.();
        const runtime = newState?.runtimeByWorkspace?.[ws.id];
        setSkills(runtime?.skills ?? []);
      }
    } catch (e) {
      console.error("[skills] 切换失败:", e);
    }
  };

  if (skills.length === 0) {
    return <p className="ext-hint">暂无已安装的 skills。在 ~/.pi/agent/skills/ 放 SKILL.md 文件即可。</p>;
  }

  return (
    <div className="ext-list">
      {skills.map((s) => (
        <div key={s.filePath ?? s.name} className="ext-item" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <code style={{ fontSize: 12 }}>{s.name}</code>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.description}</div>
          </div>
          <label className="toggle-switch-container" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={s.enabled} onChange={() => toggleSkill(s.filePath, s.enabled)} style={{ accentColor: "var(--accent-blue)" }} />
          </label>
        </div>
      ))}
    </div>
  );
}
