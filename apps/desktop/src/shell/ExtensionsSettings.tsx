import { useState, useEffect } from "react";
import { appConfirm } from "./app-dialog";
import { FileText, Puzzle, FolderOpen, Trash2, Wrench, GitBranch, Plus, X, Check, Loader } from "lucide-react";

interface ExtensionsConfig {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  commands: string[];
  extensions: string[];
  paths: { agentDir: string; promptsDir: string; extensionsDir: string; mcpConfigPath: string };
}

interface PluginDetail {
  name: string;
  fileName: string;
  tools: string[];
  description: string;
}

const PLUGIN_TEMPLATE = `export default function(pi) {
  pi.registerTool({
    name: "my_tool",
    description: "工具描述（AI 可见）",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "参数描述" },
      },
      required: ["input"],
    },
    async execute(toolCallId, params) {
      // 工具逻辑
      return { content: [{ type: "text", text: "结果" }], details: {} };
    },
  });
}`;

/** 加载扩展配置的共享 hook */
function useExtensionsConfig() {
  const [config, setConfig] = useState<ExtensionsConfig | null>(null);
  const [plugins, setPlugins] = useState<PluginDetail[]>([]);

  const load = async () => {
    const c = await (window as any).piApp.getExtensionsConfig();
    setConfig(c);
    try {
      const p = await (window as any).piApp.listPlugins?.();
      if (Array.isArray(p)) setPlugins(p);
    } catch { /* listPlugins 可能不存在（旧 preload），静默降级 */ }
  };
  useEffect(() => { load(); }, []);

  return { config, plugins, reload: load };
}

/* ============ 插件（独立设置项） ============ */
export function PluginsSection() {
  const { config, plugins, reload } = useExtensionsConfig();
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", code: PLUGIN_TEMPLATE });
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{ created: boolean; reason?: string; warnings?: string[] } | null>(null);

  const handleCreatePlugin = async () => {
    setCreating(true);
    setCreateResult(null);
    try {
      const r = await (window as any).piApp.createPlugin?.(createForm.name.trim(), createForm.code);
      setCreateResult(r);
      if (r?.created) {
        setTimeout(() => { setShowCreate(false); setCreateForm({ name: "", code: PLUGIN_TEMPLATE }); setCreateResult(null); reload(); }, 800);
      }
    } finally { setCreating(false); }
  };

  const handleRemovePlugin = async (name: string) => {
    if (!(await appConfirm(`确定删除插件 ${name}？删除后需重启生效。`, { danger: true }))) return;
    try {
      await (window as any).piApp.removePlugin?.(name);
      reload();
    } catch { /* ignore */ }
  };

  if (!config) return <section className="settings-section"><h2>插件</h2><p className="hint">加载中...</p></section>;

  return (
    <section className="settings-section">
      <h2>插件</h2>
      <p className="section-desc">
        在 .pi/extensions/ 放 .ts/.js 文件，export default 一个函数即可注册工具。Agent 也可以通过
        <code>wiki_create_plugin</code> 工具自己创建插件。重启后生效。
      </p>

      <div className="ext-group-header" style={{ marginTop: 4 }}>
        <span className="ext-group-title"><Puzzle size={13} /> 已安装 ({config.extensions.length})</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="schedule-new-btn" style={{ marginLeft: 0 }} onClick={() => setShowCreate(true)}>
            <Plus size={11} /> 新建插件
          </button>
          <button className="btn-ghost" onClick={() => (window as any).piApp.openDir(config.paths.extensionsDir)}>
            <FolderOpen size={12} /> 打开目录
          </button>
        </div>
      </div>

      {plugins.length > 0 ? (
        <div className="ext-list">
          {plugins.map((p) => (
            <div key={p.name} className="ext-item" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <code style={{ fontWeight: 600 }}>{p.name}</code>
                {p.description && <span className="hint" style={{ flex: 1 }}>{p.description}</span>}
                <button className="btn-ghost" style={{ color: "var(--danger)", padding: "2px 6px" }} onClick={() => handleRemovePlugin(p.name)}>
                  <Trash2 size={11} />
                </button>
              </div>
              {p.tools.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {p.tools.map((t) => (
                    <span key={t} className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--bg-muted)", color: "var(--text-muted)" }}>
                      <Wrench size={9} /> {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : config.extensions.length > 0 ? (
        <div className="ext-list">
          {config.extensions.map((ext) => (
            <div key={ext} className="ext-item"><code>{ext}</code></div>
          ))}
        </div>
      ) : (
        <p className="ext-hint" style={{ marginTop: 4 }}>暂无插件。让 Agent 帮你创建，或在上述目录放 .ts 文件。</p>
      )}

      {/* 新建插件弹窗 */}
      {showCreate && (
        <div className="archive-overlay" onClick={() => setShowCreate(false)}>
          <div className="archive-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="archive-header">
              <h2>新建插件</h2>
              <button className="archive-close" onClick={() => setShowCreate(false)}><X size={18} /></button>
            </div>
            <div className="mcp-form">
              <label className="mcp-form-label">插件名（英文，如 jira-search）</label>
              <input
                className="schedule-form-input"
                placeholder="my-plugin"
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              />
              <label className="mcp-form-label">插件代码（必须 export default function + pi.registerTool）</label>
              <textarea
                className="schedule-form-input"
                style={{ minHeight: 240, fontFamily: "monospace", fontSize: 11.5, lineHeight: 1.5 }}
                spellCheck={false}
                value={createForm.code}
                onChange={(e) => setCreateForm({ ...createForm, code: e.target.value })}
              />
              {createResult && !createResult.created && (
                <p className="hint" style={{ color: "var(--danger)" }}>{createResult.reason}</p>
              )}
              {createResult?.created && (
                <p className="hint" style={{ color: "var(--success)" }}>
                  <Check size={11} style={{ verticalAlign: -1 }} /> 已创建，重启后生效
                  {createResult.warnings?.length ? `（安全警告: ${createResult.warnings.join("; ")}）` : ""}
                </p>
              )}
              <div className="mcp-form-actions">
                <button className="schedule-new-btn" style={{ marginLeft: 0 }} onClick={handleCreatePlugin} disabled={creating || !createForm.name.trim()}>
                  {creating ? <Loader size={11} className="spin" /> : <Check size={11} />} 创建
                </button>
                <button className="btn-ghost" onClick={() => setShowCreate(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ============ 命令（独立设置项） ============ */
export function CommandsSection() {
  const { config } = useExtensionsConfig();

  if (!config) return <section className="settings-section"><h2>命令</h2><p className="hint">加载中...</p></section>;

  return (
    <section className="settings-section">
      <h2>自定义命令</h2>
      <p className="section-desc">斜杠命令。在 prompts 目录放 .md 文件，文件名即命令名，输入 /命令名 触发。</p>

      <div className="ext-group-header" style={{ marginTop: 4 }}>
        <span className="ext-group-title"><FileText size={13} /> 命令列表 ({config.commands.length})</span>
        <button className="btn-ghost" onClick={() => (window as any).piApp.openDir(config.paths.promptsDir)}>
          <FolderOpen size={12} /> 打开目录
        </button>
      </div>

      {config.commands.length > 0 ? (
        <div className="ext-list">
          {config.commands.map((cmd) => (
            <div key={cmd} className="ext-item"><code>/{cmd}</code></div>
          ))}
        </div>
      ) : (
        <p className="ext-hint" style={{ marginTop: 4 }}>暂无自定义命令。在 prompts 目录放 .md 文件创建。</p>
      )}

      {/* 会话分支入口（对话触发类功能） */}
      <div className="ext-group" style={{ marginTop: 20 }}>
        <div className="ext-group-header">
          <span className="ext-group-title"><GitBranch size={13} /> 会话分支</span>
        </div>
        <p className="ext-hint">
          查看和切换当前会话的对话分支点（fork 点、压缩点）。用于回溯对话历史中的不同路径。
        </p>
        <button className="btn-primary" style={{ marginTop: 4 }} onClick={() => window.dispatchEvent(new CustomEvent("open-tree-modal"))}>
          <GitBranch size={12} /> 打开分支管理
        </button>
      </div>
    </section>
  );
}
