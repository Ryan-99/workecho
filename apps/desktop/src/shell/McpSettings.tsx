import { useState, useEffect } from "react";
import { appConfirm } from "./app-dialog";
import { Plus, Trash2, Pencil, Plug, X, Check, Loader, FolderOpen } from "lucide-react";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** MCP Server 设置（一条一条的列表 + 新建/编辑弹窗） */
export function McpSection() {
  const [servers, setServers] = useState<Record<string, McpServerConfig> | null>(null);
  const [paths, setPaths] = useState<{ agentDir: string } | null>(null);
  const [editing, setEditing] = useState<{ isNew: boolean; originalName: string; name: string; command: string; argsText: string; envText: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const api = window as any;

  const load = async () => {
    try {
      const c = await api.piApp.getExtensionsConfig();
      setServers(c.mcpServers ?? {});
      setPaths(c.paths);
    } catch {
      setServers({});
    }
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditing({ isNew: true, originalName: "", name: "", command: "", argsText: "", envText: "" });
  };

  const openEdit = (name: string, cfg: McpServerConfig) => {
    const argsText = (cfg.args ?? []).join("\n");
    const envText = Object.entries(cfg.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
    setEditing({ isNew: false, originalName: name, name, command: cfg.command, argsText, envText });
  };

  const handleSave = async () => {
    if (!editing || !servers) return;
    const name = editing.name.trim();
    if (!name || !editing.command.trim()) return;
    setSaving(true);
    try {
      const next: Record<string, McpServerConfig> = {};
      // 重命名时移除旧 key
      for (const [k, v] of Object.entries(servers)) {
        if (k === editing.originalName) continue;
        next[k] = v;
      }
      const env: Record<string, string> = {};
      for (const line of editing.envText.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim();
          if (key) env[key] = val;
        }
      }
      next[name] = {
        command: editing.command.trim(),
        args: editing.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
        env: Object.keys(env).length > 0 ? env : undefined,
      };
      setServers(next);
      await api.piApp.saveMcpConfig(next);
      setEditing(null);
    } finally { setSaving(false); }
  };

  const handleDelete = async (name: string) => {
    if (!servers || !(await appConfirm(`删除 MCP server "${name}"？重启后生效。`, { danger: true }))) return;
    const next = { ...servers };
    delete next[name];
    setServers(next);
    await api.piApp.saveMcpConfig(next);
  };

  const entries = servers ? Object.entries(servers) : [];

  return (
    <section className="settings-section">
      <h2>MCP Server</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        外部工具服务。每个 server 的工具会以 <code>mcp_服务器名_工具名</code> 注册。修改后需重启生效。
      </p>

      {servers === null ? (
        <p className="hint"><Loader size={12} className="spin" /> 加载中...</p>
      ) : entries.length === 0 ? (
        <p className="hint" style={{ padding: "12px 0" }}>暂无 MCP server。</p>
      ) : (
        <div className="mcp-list">
          {entries.map(([name, cfg]) => (
            <div key={name} className="mcp-item">
              <div className="mcp-item-main">
                <div className="mcp-item-name"><Plug size={12} /> {name}</div>
                <div className="mcp-item-cmd">
                  {cfg.command}{cfg.args?.length ? " " + cfg.args.join(" ") : ""}
                </div>
                {cfg.env && Object.keys(cfg.env).length > 0 && (
                  <div className="mcp-item-env">{Object.keys(cfg.env).length} 个环境变量</div>
                )}
              </div>
              <div className="mcp-item-actions">
                <button className="action-btn" title="编辑" onClick={() => openEdit(name, cfg)}><Pencil size={13} /></button>
                <button className="action-btn danger" title="删除" onClick={() => handleDelete(name)}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="form-actions" style={{ marginTop: 8 }}>
        <button className="schedule-new-btn" style={{ marginLeft: 0 }} onClick={openNew}><Plus size={11} /> 新建 Server</button>
        {paths && (
          <button className="btn-ghost" onClick={() => api.piApp.openDir(paths.agentDir)}>
            <FolderOpen size={12} /> 打开配置目录
          </button>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      {editing && (
        <div className="archive-overlay" onClick={() => setEditing(null)}>
          <div className="archive-modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="archive-header">
              <h2>{editing.isNew ? "新建 MCP Server" : `编辑 ${editing.originalName}`}</h2>
              <button className="archive-close" onClick={() => setEditing(null)}><X size={18} /></button>
            </div>
            <div className="mcp-form">
              <label className="mcp-form-label">名称</label>
              <input
                className="schedule-form-input"
                placeholder="如：weather、jira"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
              <label className="mcp-form-label">启动命令</label>
              <input
                className="schedule-form-input"
                placeholder="如：npx / uvx / node / python"
                value={editing.command}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
              />
              <label className="mcp-form-label">参数（每行一条）</label>
              <textarea
                className="schedule-form-input"
                style={{ minHeight: 56, fontFamily: "monospace", fontSize: 12 }}
                placeholder={"-y\n@modelcontextprotocol/server-weather"}
                value={editing.argsText}
                onChange={(e) => setEditing({ ...editing, argsText: e.target.value })}
              />
              <label className="mcp-form-label">环境变量（KEY=value 每行一条，可选）</label>
              <textarea
                className="schedule-form-input"
                style={{ minHeight: 56, fontFamily: "monospace", fontSize: 12 }}
                placeholder={"API_KEY=xxx\nBASE_URL=https://..."}
                value={editing.envText}
                onChange={(e) => setEditing({ ...editing, envText: e.target.value })}
              />
              <div className="mcp-form-actions">
                <button className="schedule-new-btn" style={{ marginLeft: 0 }} onClick={handleSave} disabled={saving || !editing.name.trim() || !editing.command.trim()}>
                  {saving ? <Loader size={11} className="spin" /> : <Check size={11} />} 保存
                </button>
                <button className="btn-ghost" onClick={() => setEditing(null)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
