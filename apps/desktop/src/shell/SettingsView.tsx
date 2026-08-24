import { Sun, Moon, Monitor, Plus, Trash2, KeyRound, LogIn, LogOut, Check, Loader, Palette, Cloud, FileText, Puzzle, Info, Cpu, Zap, BookOpen, Clock, Sparkles, Plug, Terminal, X, Webhook, Upload, Activity } from "lucide-react";

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: "appearance", label: "外观", icon: <Palette size={14} /> },
  { id: "providers", label: "模型 Provider", icon: <Cloud size={14} /> },
  { id: "agent", label: "Agent 设置", icon: <Cpu size={14} /> },
  { id: "wiki", label: "Wiki 知识库", icon: <BookOpen size={14} /> },
  { id: "skills", label: "Skills", icon: <Sparkles size={14} /> },
  { id: "mcp", label: "MCP", icon: <Plug size={14} /> },
  { id: "plugins", label: "插件", icon: <Puzzle size={14} /> },
  { id: "commands", label: "命令", icon: <Terminal size={14} /> },
  { id: "hooks", label: "Hooks", icon: <Webhook size={14} /> },
  { id: "about", label: "关于", icon: <Info size={14} /> },
];
import { PluginsSection, CommandsSection } from "./ExtensionsSettings";
import { McpSection } from "./McpSettings";
import { SkillsSection } from "./ChatExtras";
import { useState, useEffect, useMemo } from "react";
import { appConfirm, appAlert } from "./app-dialog";
import type { DesktopAppState } from "../desktop-state";
import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";
import type { CustomProviderConfig, CustomProviderProbeResult } from "../ipc";

export type SettingsTab = "appearance" | "providers" | "agent" | "skills" | "mcp" | "wiki" | "plugins" | "commands" | "hooks" | "about";

interface Props {
  state: DesktopAppState;
  tab: SettingsTab;
  onThemeChange: (mode: "system" | "light" | "dark") => void;
}

export function SettingsView({ state, tab, onThemeChange }: Props) {
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    window.piApp.getResolvedTheme().then(setResolvedTheme);
  }, []);

  return (
    <div className="settings-view">
      <div className="settings-content">
        {tab === "appearance" && <AppearanceSection themeMode={state.themeMode} resolvedTheme={resolvedTheme} onThemeChange={onThemeChange} />}
        {tab === "providers" && <ProvidersSection state={state} />}
        {tab === "agent" && <><SystemPromptSection /><AgentSettingsSection /></>}
        {tab === "skills" && <SkillsTab />}
        {tab === "mcp" && <McpSection />}
        {tab === "wiki" && <WikiSettingsSection />}
        {tab === "plugins" && <PluginsSection />}
        {tab === "commands" && <CommandsSection />}
        {tab === "hooks" && <HooksSettingsSection />}
        {tab === "about" && <AboutSection />}
      </div>
    </div>
  );
}

/* ============ 外观 ============ */
function AppearanceSection({ themeMode, resolvedTheme, onThemeChange }: {
  themeMode: string;
  resolvedTheme: string;
  onThemeChange: (m: "system" | "light" | "dark") => void;
}) {
  return (
    <section className="settings-section">
      <h2>外观</h2>
      <div className="settings-row">
        <label>主题</label>
        <div className="theme-options">
          <button className={themeMode === "light" ? "active" : ""} onClick={() => onThemeChange("light")}><Sun size={12} /> 浅色</button>
          <button className={themeMode === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}><Moon size={12} /> 深色</button>
          <button className={themeMode === "system" ? "active" : ""} onClick={() => onThemeChange("system")}><Monitor size={12} /> 跟随系统</button>
        </div>
      </div>
      <div className="settings-row"><label>当前生效</label><span className="hint">{resolvedTheme}</span></div>
    </section>
  );
}

/* ============ Provider 管理（核心） ============ */
function ProvidersSection({ state }: { state: DesktopAppState }) {
  const runtime = state.runtimeByWorkspace[state.selectedWorkspaceId];
  const providers = runtime?.providers ?? [];
  const wsId = state.selectedWorkspaceId;

  // CoStrict：合成 OAuth 行（登录/断开走 loginProvider/logoutProvider，主进程特判）
  const api = window as any;
  const [costrict, setCostrict] = useState<any>(null);
  useEffect(() => {
    api.piApp?.costrictStatus?.().then(setCostrict).catch(() => {});
  }, [providers.length]);
  const costrictRecord: RuntimeProviderRecord = {
    id: "costrict",
    name: "CoStrict",
    hasAuth: Boolean(costrict?.apiKeySaved),
    authType: costrict?.apiKeySaved ? "oauth" : "none",
    authSource: costrict?.apiKeySaved ? "oauth" : "none",
    oauthSupported: true,
    apiKeySetupSupported: false,
  };
  const oauthProviders = [
    costrictRecord,
    ...providers.filter((p) => p.oauthSupported && p.id !== "costrict"),
  ];
  const apiKeyProviders = providers.filter((p) => p.apiKeySetupSupported && !p.oauthSupported);

  return (
    <section className="settings-section">
      <h2>模型 Provider</h2>
      <p className="section-desc">登录或配置 API Key 来启用模型。已连接的 provider 会被标记。</p>

      {oauthProviders.length > 0 && (
        <div className="provider-group">
          <div className="provider-group-title">直接登录</div>
          {oauthProviders.map((p) => <OAuthProviderRow key={p.id} provider={p} wsId={wsId} />)}
        </div>
      )}

      {apiKeyProviders.length > 0 && (
        <div className="provider-group">
          <div className="provider-group-title">API Key 配置</div>
          {apiKeyProviders.map((p) => <ApiKeyProviderRow key={p.id} provider={p} wsId={wsId} />)}
        </div>
      )}

      <div className="provider-group">
        <div className="provider-group-title">自定义 Provider（OpenAI 兼容）</div>
        <CustomProvidersSection wsId={wsId} existingIds={providers.map((p) => p.id)} />
      </div>
    </section>
  );
}

/** Provider 健康检测按钮（P1-7）：自定义=在线探测，内置=凭据存在性 */
function ProviderHealthCheck({ providerId }: { providerId: string }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ online: boolean | null; message: string } | null>(null);

  const run = async () => {
    setChecking(true);
    setResult(null);
    try {
      const r = await window.piApp.checkProviderHealth(providerId);
      setResult({ online: r.online, message: r.message });
    } catch (e) {
      setResult({ online: false, message: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };

  return (
    <span className="provider-health">
      <button className="btn-ghost" onClick={run} disabled={checking} title="检测该 Provider 的凭据与连接状态">
        {checking ? <Loader size={12} className="spin" /> : <Activity size={12} />} 检测
      </button>
      {result && (
        <span className={`provider-health__msg ${result.online === false ? "is-bad" : ""}`}>
          {result.online === true ? "● " : result.online === false ? "○ " : ""}{result.message}
        </span>
      )}
    </span>
  );
}

function OAuthProviderRow({ provider, wsId }: { provider: RuntimeProviderRecord; wsId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleLogin = async () => {
    setPending(true); setError(undefined);
    try { await window.piApp.loginProvider(wsId, provider.id); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };
  const handleLogout = async () => {
    setPending(true);
    try { await window.piApp.logoutProvider(wsId, provider.id); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };

  return (
    <div className="provider-row">
      <div className="provider-info">
        <span className="provider-name">{provider.name}</span>
        {provider.hasAuth && <span className="provider-badge connected"><Check size={10} /> 已连接</span>}
      </div>
      <div className="provider-actions">
        <ProviderHealthCheck providerId={provider.id} />
        {provider.hasAuth ? (
          <button className="btn-ghost" onClick={handleLogout} disabled={pending}>
            {pending ? <Loader size={12} className="spin" /> : <LogOut size={12} />} 断开
          </button>
        ) : (
          <button className="btn-primary" onClick={handleLogin} disabled={pending}>
            {pending ? <Loader size={12} className="spin" /> : <LogIn size={12} />} 登录
          </button>
        )}
      </div>
      {error && <div className="provider-error">{error}</div>}
    </div>
  );
}

function ApiKeyProviderRow({ provider, wsId }: { provider: RuntimeProviderRecord; wsId: string }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleSave = async () => {
    setPending(true); setError(undefined);
    try {
      const s = await window.piApp.setProviderApiKey(wsId, provider.id, key.trim());
      setError(undefined); setEditing(false); setKey("");
      // state 自动通过 onStateChanged 更新
      void s;
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };
  const handleRemove = async () => {
    setPending(true);
    try { await window.piApp.setProviderApiKey(wsId, provider.id, ""); setEditing(false); setKey(""); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };

  return (
    <div className="provider-row">
      <div className="provider-info">
        <span className="provider-name">{provider.name}</span>
        {provider.hasAuth && <span className="provider-badge connected"><Check size={10} /> 已配置</span>}
      </div>
      <div className="provider-actions">
        {editing ? (
          <>
            <input
              className="api-key-input"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="粘贴 API Key"
              autoFocus
            />
            <button className="btn-primary" onClick={handleSave} disabled={pending || !key.trim()}>
              {pending ? <Loader size={12} className="spin" /> : <Check size={12} />} 保存
            </button>
            <button className="btn-ghost" onClick={() => { setEditing(false); setKey(""); setError(undefined); }}>取消</button>
          </>
        ) : (
          <>
            <ProviderHealthCheck providerId={provider.id} />
            <button className="btn-ghost" onClick={() => setEditing(true)}><KeyRound size={12} /> {provider.hasAuth ? "更换 Key" : "配置 Key"}</button>
            {provider.hasAuth && <button className="btn-ghost" onClick={handleRemove} disabled={pending}>移除</button>}
          </>
        )}
      </div>
      {error && <div className="provider-error">{error}</div>}
    </div>
  );
}

/* ============ 自定义 Provider（Echoly relay 类型） ============ */
function CustomProvidersSection({ wsId, existingIds }: { wsId: string; existingIds: readonly string[] }) {
  const [customs, setCustoms] = useState<CustomProviderConfig[]>([]);
  const [adding, setAdding] = useState(false);

  const loadCustoms = async () => {
    // costrict 由上方"直接登录"一键管理，不在手动列表中重复展示
    try { setCustoms((await window.piApp.listCustomProviders()).filter((c: CustomProviderConfig) => c.providerId !== "costrict")); } catch {}
  };
  useEffect(() => { loadCustoms(); }, []);

  const handleDelete = async (providerId: string) => {
    if (!(await appConfirm(`删除 provider "${providerId}"？`, { danger: true }))) return;
    try { await window.piApp.deleteCustomProvider(wsId, providerId); await loadCustoms(); }
    catch (e) { await appAlert((e as Error).message); }
  };

  return (
    <>
      {customs.map((c) => (
        <div key={c.providerId} className="provider-row">
          <div className="provider-info">
            <span className="provider-name">{c.providerId}</span>
            <span className="hint">{c.baseUrl} · {c.models.length} 个模型</span>
          </div>
          <div className="provider-actions">
            <button className="btn-ghost danger" onClick={() => handleDelete(c.providerId)}><Trash2 size={12} /> 删除</button>
          </div>
        </div>
      ))}
      {adding ? (
        <CustomProviderForm
          wsId={wsId}
          existingIds={existingIds}
          customs={customs.map((c) => c.providerId)}
          onSaved={() => { setAdding(false); loadCustoms(); }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className="btn-ghost add-provider" onClick={() => setAdding(true)}><Plus size={14} /> 添加自定义 Provider</button>
      )}
    </>
  );
}

function CustomProviderForm({ wsId, existingIds, customs, onSaved, onCancel }: {
  wsId: string;
  existingIds: readonly string[];
  customs: readonly string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [pending, setPending] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const allIds = useMemo(() => new Set([...existingIds, ...customs]), [existingIds, customs]);

  const handleProbe = async () => {
    setProbing(true); setError(undefined);
    try {
      const result: CustomProviderProbeResult = await window.piApp.probeCustomProviderModels({ baseUrl, apiKey: apiKey || undefined });
      if (result.ok) {
        setModels(result.models.join("\n"));
      } else {
        setError(result.error);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setProbing(false); }
  };

  const handleSave = async () => {
    setError(undefined);
    const id = providerId.trim();
    if (!id) { setError("Provider ID 不能为空"); return; }
    if (allIds.has(id)) { setError(`Provider ID "${id}" 已存在`); return; }
    if (!baseUrl.trim()) { setError("Base URL 不能为空"); return; }
    const modelList = models.split("\n").map((m) => m.trim()).filter(Boolean);
    if (modelList.length === 0) { setError("至少配置一个模型"); return; }

    setPending(true);
    try {
      await window.piApp.setCustomProvider(wsId, {
        providerId: id,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        models: modelList.map((m) => ({ id: m })),
      });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };

  return (
    <div className="custom-provider-form">
      <div className="form-row">
        <label>Provider ID</label>
        <input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="例如：echoly、my-openai" />
      </div>
      <div className="form-row">
        <label>Base URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
      </div>
      <div className="form-row">
        <label>API Key</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
      </div>
      <div className="form-row">
        <label>模型（每行一个）</label>
        <textarea value={models} onChange={(e) => setModels(e.target.value)} placeholder={"kimi-k2\nglm-5.1"} rows={4} />
      </div>
      <div className="form-actions">
        <button className="btn-ghost" onClick={handleProbe} disabled={probing || !baseUrl.trim()}>
          {probing ? <Loader size={12} className="spin" /> : null} 拉取模型列表
        </button>
        <button className="btn-primary" onClick={handleSave} disabled={pending}>保存</button>
        <button className="btn-ghost" onClick={onCancel}>取消</button>
      </div>
      {error && <div className="provider-error">{error}</div>}
      <div className="form-note">注意：自定义 provider 默认用 openai-completions API。如果需要 openai-responses（如 Echoly relay），请手动编辑 ~/.pi/agent/models.json。</div>
    </div>
  );
}

/* ============ 系统提示词（用户可编辑） ============ */
function SystemPromptSection() {
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (window as any).piApp.getBusinessPrompt().then((p: string) => {
      setPrompt(p);
      setDraft(p);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await (window as any).piApp.saveBusinessPrompt(draft);
      setPrompt(saved);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  const handleReset = () => {
    setDraft(prompt);
    setEditing(false);
  };

  return (
    <section className="settings-section">
      <h2>系统提示词</h2>
      <p className="section-desc">
        定义 AI 助手的角色、能力和工作方式。修改后新会话即时生效。这是写入 workspace 的 AGENTS.md，
        pi 会自动读取作为系统提示词。
      </p>
      {editing ? (
        <>
          <textarea
            className="prompt-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={18}
            autoFocus
            spellCheck={false}
          />
          <div className="form-actions">
            <button className="btn-primary" onClick={handleSave} disabled={saving || draft === prompt}>
              {saving ? <Loader size={12} className="spin" /> : <Check size={12} />} 保存
            </button>
            <button className="btn-ghost" onClick={handleReset}>取消</button>
          </div>
        </>
      ) : (
        <>
          <pre className="prompt-preview">{prompt.slice(0, 300)}{prompt.length > 300 ? "…" : ""}</pre>
          <div className="form-actions">
            <button className="btn-ghost" onClick={() => { setDraft(prompt); setEditing(true); }}><KeyRound size={12} /> 编辑</button>
            {saved && <span className="hint" style={{ color: "var(--success)", display: "inline-flex", alignItems: "center", gap: 4 }}><Check size={12} /> 已保存</span>}
          </div>
        </>
      )}
    </section>
  );
}

/* ============ 关于 ============ */
/* ============ Agent 设置（#2 工具开关 + #4 steering + #6 压缩/重试）============ */
function AgentSettingsSection() {
  const [tools, setTools] = useState<{ all: string[]; active: string[] }>({ all: [], active: [] });
  const [autoCompact, setAutoCompact] = useState(true);
  const [todoRules, setTodoRules] = useState("");
  const [rulesDraft, setRulesDraft] = useState("");
  const [editingRules, setEditingRules] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  useEffect(() => {
    (window.piApp as any).getSessionTools?.().then((t: any) => setTools(t ?? { all: [], active: [] }));
    (window.piApp as any).getTodoRules?.().then((r: string) => { setTodoRules(r); setRulesDraft(r); });
    (window.piApp as any).getAutoCompact?.().then((v: boolean) => setAutoCompact(v));
  }, []);

  const handleAutoCompact = async (v: boolean) => {
    setAutoCompact(v);
    await (window.piApp as any).setAutoCompact?.(v);
  };

  const toggleTool = (name: string) => {
    const isActive = tools.active.includes(name);
    const newActive = isActive ? tools.active.filter((t) => t !== name) : [...tools.active, name];
    setTools({ ...tools, active: newActive });
  };

  const handleSaveRules = async () => {
    setSavingRules(true);
    try {
      await (window.piApp as any).saveTodoRules(rulesDraft);
      setTodoRules(rulesDraft);
      setEditingRules(false);
    } finally { setSavingRules(false); }
  };

  return (
    <>
      <section className="settings-section">
        <h2>自动行为</h2>
        <div className="settings-row">
          <label>自动压缩（对话过长时自动摘要）</label>
          <Toggle checked={autoCompact} onChange={handleAutoCompact} />
        </div>
      </section>

      <section className="settings-section">
        <h2>待办排序规则</h2>
        <p className="section-desc">定义 AI 如何对待办进行优先级排序。AI 创建/更新待办时会根据此规则打分（priority 1-5）。</p>
        {editingRules ? (
          <>
            <textarea
              className="prompt-editor"
              value={rulesDraft}
              onChange={(e) => setRulesDraft(e.target.value)}
              rows={16}
              autoFocus
              spellCheck={false}
            />
            <div className="form-actions">
              <button className="btn-primary" onClick={handleSaveRules} disabled={savingRules || rulesDraft === todoRules}>
                {savingRules ? <Loader size={12} className="spin" /> : <Check size={12} />} 保存
              </button>
              <button className="btn-ghost" onClick={() => { setRulesDraft(todoRules); setEditingRules(false); }}>取消</button>
            </div>
          </>
        ) : (
          <>
            <pre className="prompt-preview">{todoRules.slice(0, 400)}{todoRules.length > 400 ? "…" : ""}</pre>
            <div className="form-actions">
              <button className="btn-ghost" onClick={() => { setRulesDraft(todoRules); setEditingRules(true); }}><KeyRound size={12} /> 编辑规则</button>
            </div>
          </>
        )}
      </section>

      <section className="settings-section">
        <h2>工具开关</h2>
        <p className="section-desc">启用或禁用 AI 可用的工具。禁用后 AI 不再调用该工具。</p>
        {tools.all.length === 0 ? (
          <p className="hint">暂无已注册工具</p>
        ) : (
          <div className="tool-toggle-list">
            {tools.all.map((name) => (
              <div key={name} className="tool-toggle-row">
                <span className="tool-toggle-name">{name}</span>
                <Toggle checked={tools.active.includes(name)} onChange={() => toggleTool(name)} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle-switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  );
}

/* ============ Wiki 知识库设置 ============ */
interface WikiConfigState {
  autoWrite: boolean;
  autoReadMemory: boolean;
  autoUpdateContext: boolean;
  pipelineEnabled: boolean;
  dangerousOpConfirm: boolean;
  scheduleEnabled: boolean;
  dailyBriefing: boolean;
  dailyBriefingTime: string;
  selfModifyPlugins: boolean;
  pluginCreateConfirm: boolean;
  selfLearningSkills: boolean;
  ingestAutoCrossRef: boolean;
  discoverThreshold: number;
  showWikiStatsCard: boolean;
}

function WikiSettingsSection() {
  const [config, setConfig] = useState<WikiConfigState | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 定时任务（仅用于设置页显示数量，管理界面在独立弹窗）
  const [schedules, setSchedules] = useState<any[]>([]);

  const loadSchedules = async () => {
    try {
      const list = await (window as any).piApp?.listSchedulesUI?.();
      if (Array.isArray(list)) setSchedules(list);
    } catch { /* 静默 */ }
  };

  useEffect(() => {
    const fn = (window.piApp as any)?.getWikiConfig;
    if (typeof fn !== "function") {
      setLoadError(true);
      return;
    }
    fn().then((c: WikiConfigState) => setConfig(c)).catch(() => setLoadError(true));
    loadSchedules();
  }, []);

  if (loadError) return (
    <section className="settings-section">
      <h2>Wiki 知识库</h2>
      <p className="hint">无法加载配置。请重启应用使新的 preload 生效（设置页的 Wiki 功能需要重新构建）。</p>
    </section>
  );
  if (!config) return <section className="settings-section"><p className="hint">加载中...</p></section>;

  const patch = async (p: Partial<WikiConfigState>) => {
    const next = { ...config, ...p };
    setConfig(next);
    setSaving(true);
    try {
      await (window.piApp as any).patchWikiConfig?.(p);
    } finally { setSaving(false); }
  };

  return (
    <>
      {/* 自动写入 */}
      <section className="settings-section">
        <h2>自动写入</h2>
        <div className="settings-row">
          <label>自动写入知识库（对话中有价值信息时自动存入 wiki）</label>
          <Toggle checked={config.autoWrite} onChange={(v) => patch({ autoWrite: v })} />
        </div>
        <div className="settings-row">
          <label>会话启动自动读记忆（恢复对用户的认知）</label>
          <Toggle checked={config.autoReadMemory} onChange={(v) => patch({ autoReadMemory: v })} />
        </div>
        <div className="settings-row">
          <label>会话切换自动更新工作上下文</label>
          <Toggle checked={config.autoUpdateContext} onChange={(v) => patch({ autoUpdateContext: v })} />
        </div>
      </section>

      {/* 工具执行管道（A2） */}
      <section className="settings-section">
        <h2>工具执行管道</h2>
        <p className="hint" style={{ marginBottom: 12 }}>三层管道：审计日志 → 执行 → 结果后处理。记录所有工具调用到 log.md。</p>
        <div className="settings-row">
          <label>启用工具审计管道</label>
          <Toggle checked={config.pipelineEnabled} onChange={(v) => patch({ pipelineEnabled: v })} />
        </div>
        <div className="settings-row">
          <label>危险操作需确认（修改 OKR/维保等关键数据时）</label>
          <Toggle checked={config.dangerousOpConfirm} onChange={(v) => patch({ dangerousOpConfirm: v })} />
        </div>
      </section>

      {/* Schedule 子系统（A4）— 精简为开关 + 入口 */}
      <section className="settings-section">
        <h2>定时服务</h2>
        <p className="hint" style={{ marginBottom: 12 }}>到指定时间时 Agent 主动在对话中执行任务并汇报结果。</p>
        <div className="settings-row">
          <label>启用定时规则自动触发</label>
          <Toggle checked={config.scheduleEnabled} onChange={(v) => patch({ scheduleEnabled: v })} />
        </div>
        <div className="settings-row" style={{ paddingTop: 8 }}>
          <label>定时任务管理{schedules.length > 0 ? `（当前 ${schedules.length} 个任务）` : ""}</label>
          <button className="btn-ghost" onClick={() => window.dispatchEvent(new CustomEvent("open-schedule-manager"))}>
            <Clock size={12} /> 打开定时任务
          </button>
        </div>
      </section>

      {/* 自我修改插件（A1） */}
      <section className="settings-section">
        <h2>Agent 自我修改插件</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          Agent 发现缺少能力时，自己写工具插件代码到 .pi/extensions/。插件管理（查看/删除）在「扩展能力」标签页。
        </p>
        <div className="settings-row">
          <label>允许 Agent 创建工具插件</label>
          <Toggle checked={config.selfModifyPlugins} onChange={(v) => patch({ selfModifyPlugins: v })} />
        </div>
        <div className="settings-row">
          <label>创建插件时需用户确认代码</label>
          <Toggle checked={config.pluginCreateConfirm} onChange={(v) => patch({ pluginCreateConfirm: v })} />
        </div>
      </section>

      {/* Agent 自学习 */}
      <section className="settings-section">
        <h2>Agent 自学习</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          对话结束后自动评估是否出现可复用的流程或偏好，蒸馏成 Skill 沉淀（learned- 前缀，
          在「技能」标签页可查看/停用）。每次沉淀会记录到 wiki 日志并弹桌面通知。
        </p>
        <div className="settings-row">
          <label>自动从对话沉淀 Skill</label>
          <Toggle checked={config.selfLearningSkills} onChange={(v) => patch({ selfLearningSkills: v })} />
        </div>
      </section>

      {/* 知识摄取 */}
      <section className="settings-section">
        <h2>知识摄取</h2>
        <div className="settings-row">
          <label>摄取文档时自动建立交叉引用</label>
          <Toggle checked={config.ingestAutoCrossRef} onChange={(v) => patch({ ingestAutoCrossRef: v })} />
        </div>
        <div className="settings-row">
          <label>领域发现关键词频次阈值</label>
          <input
            type="number"
            min={1}
            max={50}
            className="setting-select"
            style={{ width: 80 }}
            value={config.discoverThreshold}
            onChange={(e) => patch({ discoverThreshold: parseInt(e.target.value) || 3 })}
          />
        </div>
      </section>

      {/* 可视化 */}
      <section className="settings-section">
        <h2>可视化</h2>
        <div className="settings-row">
          <label>状态面板显示"知识库概览"卡片</label>
          <Toggle checked={config.showWikiStatsCard} onChange={(v) => patch({ showWikiStatsCard: v })} />
        </div>
      </section>

      {/* 旧知识库 */}
      <section className="settings-section">
        <h2>旧知识库导入</h2>
        <p className="hint" style={{ marginBottom: 12 }}>
          之前的 Karpathy 式知识库目录（含 wiki/concepts、journals、pages）。配置后「初始化工作环境」会自动导入：概念页进知识库、客户档案变动态类型、旧目录并入精炼索引。
        </p>
        <div className="settings-row">
          <input
            className="setting-select"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="如 D:\Workspace\Workspace"
            value={(config as any).legacyWikiPath ?? ""}
            onChange={(e) => patch({ legacyWikiPath: e.target.value } as any)}
          />
        </div>
      </section>

      {saving && <p className="hint" style={{ textAlign: "center" }}><Loader size={12} className="spin" /> 保存中...</p>}
    </>
  );
}

/* ============ Skills 设置（列表 + 新建） ============ */
function SkillsTab() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: boolean; reason?: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleImport = async () => {
    setImporting(true); setResult(null);
    try {
      const api = window as any;
      const token = await api.piApp.pickDirectory?.();
      if (!token) { setImporting(false); return; } // 用户取消
      // token 是一次性目录令牌（主进程签发），非裸路径
      const r = await api.piApp.importSkill?.(token);
      setResult(r);
      if (r?.imported) setRefreshKey((k) => k + 1);
    } catch (e) {
      setResult({ imported: false, reason: (e as Error).message });
    } finally { setImporting(false); }
  };

  return (
    <section className="settings-section">
      <h2>Skills</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        Agent 按需自动调用的技能包。完整的技能通常在与 Agent 对话中沉淀（直接说"把这个流程做成技能"），
        这里用于导入本地已有的技能包（含 SKILL.md 的目录）和管理。
      </p>
      <div className="form-actions" style={{ marginBottom: 8 }}>
        <button className="schedule-new-btn" style={{ marginLeft: 0 }} onClick={handleImport} disabled={importing}>
          {importing ? <Loader size={11} className="spin" /> : <Upload size={11} />} 导入 Skill
        </button>
      </div>
      {result && !result.imported && (
        <p className="hint" style={{ color: "var(--danger)", marginTop: 0 }}>{result.reason}</p>
      )}
      {result?.imported && (
        <p className="hint" style={{ color: "var(--success)", marginTop: 0 }}><Check size={11} style={{ verticalAlign: -1 }} /> 已导入，新会话中立即可用</p>
      )}
      <SkillsSection key={refreshKey} />
    </section>
  );
}

/* ============ Hooks 设置（P2：事件规则） ============ */
interface HookRule {
  id: string;
  name: string;
  enabled: boolean;
  event: string;
  toolName: string;
  action: string;
  message: string;
}

const HOOK_EVENT_OPTIONS = [
  { value: "tool_call", label: "工具调用前（可阻止）" },
  { value: "tool_result", label: "工具执行后" },
  { value: "session_start", label: "会话启动" },
  { value: "agent_end", label: "Agent 回合结束" },
];

const HOOK_ACTION_OPTIONS = [
  { value: "log", label: "记入日志" },
  { value: "notify", label: "桌面通知" },
  { value: "block", label: "阻止执行" },
  { value: "terminate", label: "拦截并终止本轮" },
];

function HooksSettingsSection() {
  const [rules, setRules] = useState<HookRule[] | null>(null);
  const [hooksEnabled, setHooksEnabled] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", event: "tool_call", toolName: "", action: "log", message: "" });
  const api = window as any;

  const load = async () => {
    try {
      const list = await api.piApp?.listHooks?.();
      setRules(Array.isArray(list) ? list : []);
      const cfg = await api.piApp?.getWikiConfig?.();
      if (cfg) setHooksEnabled(cfg.hooksEnabled !== false);
    } catch { setRules([]); }
  };
  useEffect(() => { load(); }, []);

  const toggleEnabled = async (v: boolean) => {
    setHooksEnabled(v);
    await api.piApp?.patchWikiConfig?.({ hooksEnabled: v });
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    await api.piApp?.addHook?.({
      name: form.name.trim(),
      event: form.event,
      toolName: form.toolName.trim() || "*",
      action: form.action,
      message: form.message.trim(),
    });
    setForm({ name: "", event: "tool_call", toolName: "", action: "log", message: "" });
    setShowForm(false);
    load();
  };

  const handleRemove = async (id: string) => {
    await api.piApp?.removeHook?.(id);
    load();
  };

  const eventLabel = (v: string) => HOOK_EVENT_OPTIONS.find((o) => o.value === v)?.label ?? v;
  const actionLabel = (v: string) => HOOK_ACTION_OPTIONS.find((o) => o.value === v)?.label ?? v;

  return (
    <section className="settings-section">
      <h2>Hooks</h2>
      <p className="hint" style={{ marginBottom: 12 }}>事件规则：匹配的事件发生时执行动作。规则存在 wiki/hooks.md，Agent 也可读写。</p>
      <div className="settings-row">
        <label>启用 Hook 规则</label>
        <Toggle checked={hooksEnabled} onChange={toggleEnabled} />
      </div>

      {rules === null ? (
        <p className="hint" style={{ padding: 8 }}>加载中...</p>
      ) : (
        <div className="schedule-list" style={{ marginTop: 8 }}>
          {rules.length === 0 ? (
            <p className="hint" style={{ padding: 4 }}>暂无规则。如：工具调用前阻止 update_entity 修改 OKR。</p>
          ) : rules.map((r) => (
            <div key={r.id} className="schedule-item">
              <div className="schedule-item-main">
                <div className="schedule-item-title-row">
                  <Webhook size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  <span className="schedule-item-title">{r.name}</span>
                  <span className={`schedule-item-badge ${r.enabled ? "" : "off"}`}>{r.enabled ? "启用" : "禁用"}</span>
                </div>
                <div className="schedule-item-trigger">{eventLabel(r.event)} · 匹配 {r.toolName} · {actionLabel(r.action)}</div>
                {r.message && <div className="schedule-item-action">{r.message}</div>}
              </div>
              <div className="schedule-item-actions">
                <button className="action-btn danger" title="删除" onClick={() => handleRemove(r.id)}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm ? (
        <div className="schedule-form" style={{ marginTop: 8 }}>
          <input
            className="schedule-form-input"
            placeholder="规则名称（如：保护 OKR）"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select className="setting-select" style={{ flex: 1, minWidth: 120 }} value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })}>
              {HOOK_EVENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="setting-select" style={{ width: 110 }} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
              {HOOK_ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <input
            className="schedule-form-input"
            placeholder="匹配工具名（* 全部 / wiki_* 前缀 / 精确名，仅工具类事件）"
            value={form.toolName}
            onChange={(e) => setForm({ ...form, toolName: e.target.value })}
          />
          <input
            className="schedule-form-input"
            placeholder="提示消息（阻止时显示给 Agent / 通知内容，可选）"
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
          />
          <div className="schedule-form-actions">
            <button className="schedule-new-btn" style={{ marginLeft: 0 }} onClick={handleCreate} disabled={!form.name.trim()}>
              <Check size={11} /> 创建规则
            </button>
            <button className="btn-ghost" onClick={() => setShowForm(false)}>取消</button>
          </div>
        </div>
      ) : (
        <button className="schedule-new-btn" style={{ marginTop: 8 }} onClick={() => setShowForm(true)}>
          <Plus size={11} /> 新建规则
        </button>
      )}
    </section>
  );
}

function AboutSection() {
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | undefined>();

  const handleCheck = async () => {
    setChecking(true);
    setUpdateResult(undefined);
    try {
      const result = await (window.piApp as any).checkUpdate();
      if (result.status === "up-to-date") {
        setUpdateResult(`已是最新版本 (${result.latestVersion})`);
      } else if (result.status === "update-available") {
        setUpdateResult(`发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）`);
        if (await appConfirm(`发现新版本 ${result.latestVersion}，是否前往下载？`)) {
          await (window.piApp as any).openReleases(result.releaseUrl);
        }
      } else {
        setUpdateResult(`检查失败: ${result.message}`);
      }
    } catch (e) {
      setUpdateResult(`检查失败: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>关于</h2>
      <div className="settings-row"><label>版本</label><span className="hint">Workecho</span></div>
      <div className="settings-row"><label>平台</label><span className="hint">{window.piApp.platform}</span></div>
      <div className="settings-row" style={{ paddingTop: 12 }}>
        <label>更新</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn-primary" onClick={handleCheck} disabled={checking}>
            {checking ? <Loader size={12} className="spin" /> : <Check size={12} />} 检查更新
          </button>
          {updateResult && <span className="hint">{updateResult}</span>}
        </div>
      </div>
    </section>
  );
}
