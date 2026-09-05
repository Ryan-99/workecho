import { useEffect, useState } from "react";
import { Cloud, KeyRound, Loader, LogIn, Plus, ShieldCheck, X } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";
import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";
import type { CustomProviderConfig, CustomProviderProbeResult } from "../ipc";

/**
 * 模型服务配置引导弹窗。
 *
 * 背景:首次发消息时 pi 运行时对未认证 provider 会弹"Enter your API key"
 * 裸输入框(上游英文文案)——主进程在 onPrompt 拦截 API Key 型认证请求,
 * 推送 workbench:provider-setup-needed,由本弹窗给出完整 provider 列表
 * 引导当场配置(账号登录 / API Key / 自定义 OpenAI 兼容端点)。
 * 列表呈现保持中性,不带推荐倾向。
 */
export function ProviderSetupDialog({
  state,
  reason,
  onClose,
  onOpenSettings,
  hideSettingsLink,
}: {
  state: DesktopAppState;
  reason?: string;
  onClose: () => void;
  onOpenSettings: () => void;
  /** 引导期间不引导跳设置页（此时设置页不可达） */
  hideSettingsLink?: boolean;
}) {
  const wsId = state.selectedWorkspaceId;
  const runtime = state.runtimeByWorkspace[wsId];
  const providers = runtime?.providers ?? [];
  const models = runtime?.models ?? [];

  // CoStrict 行内合成(登录/断开走 loginProvider 主进程特判),与其他 OAuth 平级呈现
  const [costrict, setCostrict] = useState<{ apiKeySaved?: boolean } | null>(null);
  useEffect(() => {
    const api = window as unknown as { piApp?: { costrictStatus?: () => Promise<{ apiKeySaved?: boolean }> } };
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

  const withCostrict = [...providers, costrictRecord];
  const connected = withCostrict.filter((p) => p.hasAuth);
  const oauthProviders = withCostrict.filter((p) => p.oauthSupported && !p.hasAuth);
  const apiKeyProviders = providers.filter((p) => p.apiKeySetupSupported && !p.oauthSupported && !p.hasAuth);

  const [customsVersion, setCustomsVersion] = useState(0);
  const [customs, setCustoms] = useState<CustomProviderConfig[]>([]);
  useEffect(() => {
    let alive = true;
    window.piApp
      .listCustomProviders()
      .then((list) => {
        if (alive) setCustoms(list.filter((c) => c.providerId !== "costrict"));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [customsVersion]);

  return (
    <div className="app-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-dialog provider-setup-dialog">
        <button className="app-dialog__close" onClick={onClose} title="关闭"><X size={14} /></button>
        <div className="app-dialog__message">配置模型服务</div>
        <div className="app-dialog__detail">
          {reason ? `${reason}。` : ""}接入下面任意一种服务即可，配好后重新发送消息就能使用。
        </div>

        {connected.length > 0 && (
          <div className="provider-setup-group">
            <div className="provider-setup-group-title">已连接（点击直接使用）</div>
            {connected.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                wsId={wsId}
                primaryLabel="使用"
                onDone={onClose}
                models={models}
              />
            ))}
          </div>
        )}

        {oauthProviders.length > 0 && (
          <div className="provider-setup-group">
            <div className="provider-setup-group-title">账号登录</div>
            {oauthProviders.map((p) => (
              <ProviderRow key={p.id} provider={p} wsId={wsId} onDone={onClose} models={models} />
            ))}
          </div>
        )}

        {apiKeyProviders.length > 0 && (
          <div className="provider-setup-group">
            <div className="provider-setup-group-title">API Key</div>
            {apiKeyProviders.map((p) => (
              <ProviderRow key={p.id} provider={p} wsId={wsId} onDone={onClose} models={models} />
            ))}
          </div>
        )}

        <div className="provider-setup-group">
          <div className="provider-setup-group-title">自定义（OpenAI 兼容端点）</div>
          {customs.map((c) => (
            <CustomProviderRow
              key={c.providerId}
              config={c}
              wsId={wsId}
              onDone={onClose}
              models={models}
            />
          ))}
          <CustomProviderFormInline
            wsId={wsId}
            existingIds={providers.map((p) => p.id).concat(customs.map((c) => c.providerId))}
            onSaved={() => setCustomsVersion((v) => v + 1)}
          />
        </div>

        {!hideSettingsLink && (
          <div className="provider-setup-footer">
            更多选项见
            <button
              type="button"
              className="link-btn"
              onClick={() => { onClose(); onOpenSettings(); }}
            >设置 → 模型 Provider</button>。
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  wsId,
  primaryLabel,
  onDone,
  models,
}: {
  provider: RuntimeProviderRecord;
  wsId: string;
  /** 已连接行的动作文案（默认"登录"/"配置"） */
  primaryLabel?: string;
  onDone: () => void;
  models: readonly { providerId: string; modelId: string; available?: boolean }[];
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [keyInputOpen, setKeyInputOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");

  const api = window.piApp;

  /** 配置成功后把默认模型切到该 provider 的首个可用模型。
   * 注意不能用 props 里的 models（登录前渲染的闭包，还没有新 provider）——
   * 必须 getState 实时取刷新后的模型列表。 */
  const applyDefaultModel = async () => {
    try {
      const fresh = await api.getState();
      const freshModels = fresh.runtimeByWorkspace?.[wsId]?.models ?? [];
      const firstModel = freshModels.find((m) => m.providerId === provider.id && m.available)
        ?? freshModels.find((m) => m.providerId === provider.id);
      if (firstModel) {
        await api.setDefaultModel(wsId, provider.id, firstModel.modelId);
      }
    } catch { /* 模型切换失败不阻断——用户可手动选 */ }
  };

  const handleLogin = async () => {
    if (provider.apiKeySetupSupported && !provider.oauthSupported) {
      setKeyInputOpen((v) => !v);
      return;
    }
    setPending(true); setError(undefined);
    try {
      await api.loginProvider(wsId, provider.id);
      await applyDefaultModel();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const handleUseConnected = async () => {
    setPending(true); setError(undefined);
    try {
      await applyDefaultModel();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const submitKey = async () => {
    const trimmed = keyValue.trim();
    if (!trimmed) return;
    setPending(true); setError(undefined);
    try {
      await api.setProviderApiKey(wsId, provider.id, trimmed);
      await applyDefaultModel();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={`provider-setup-row ${provider.hasAuth ? "is-connected" : ""}`}>
      <div className="provider-setup-row-main">
        <span className="provider-setup-name">
          {provider.hasAuth ? <ShieldCheck size={13} /> : provider.oauthSupported ? <Cloud size={13} /> : <KeyRound size={13} />}
          {provider.name}
          {provider.hasAuth && <span className="provider-setup-badge">已连接</span>}
        </span>
        {provider.hasAuth && primaryLabel ? (
          <button type="button" className="app-dialog__btn" onClick={handleUseConnected} disabled={pending}>
            {pending ? <Loader size={12} className="spin" /> : null} {primaryLabel}
          </button>
        ) : (
          <button type="button" className="app-dialog__btn primary" onClick={handleLogin} disabled={pending}>
            {pending ? <Loader size={12} className="spin" /> : <LogIn size={12} />}
            {provider.apiKeySetupSupported && !provider.oauthSupported ? "配置" : "登录"}
          </button>
        )}
      </div>
      {keyInputOpen && !provider.hasAuth && (
        <div className="provider-setup-key">
          <input
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submitKey(); }}
            placeholder="粘贴 API Key（仅保存在本机）"
            autoFocus
          />
          <button type="button" className="app-dialog__btn primary" onClick={submitKey} disabled={pending || !keyValue.trim()}>
            保存
          </button>
        </div>
      )}
      {error && <div className="provider-setup-error">{error}</div>}
    </div>
  );
}

/** 已保存的自定义 provider 行：配置 key（或直接使用） */
function CustomProviderRow({
  config,
  wsId,
  onDone,
  models,
}: {
  config: CustomProviderConfig;
  wsId: string;
  onDone: () => void;
  models: readonly { providerId: string; modelId: string; available?: boolean }[];
}) {
  const [pending, setPending] = useState(false);
  const [keyInputOpen, setKeyInputOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const api = window.piApp;
  const hasKey = Boolean(config.apiKey);

  const applyDefaultModel = async () => {
    try {
      // props models 是保存前渲染的闭包——实时取刷新后的列表
      const fresh = await api.getState();
      const freshModels = fresh.runtimeByWorkspace?.[wsId]?.models ?? [];
      const firstModel = freshModels.find((m) => m.providerId === config.providerId && m.available)
        ?? freshModels.find((m) => m.providerId === config.providerId);
      if (firstModel) {
        await api.setDefaultModel(wsId, config.providerId, firstModel.modelId);
      }
    } catch { /* 用户可手动选 */ }
  };

  const saveWithKey = async () => {
    const trimmed = keyValue.trim();
    if (!trimmed) return;
    setPending(true); setError(undefined);
    try {
      // 重存配置带上新 key（setCustomProvider 全量覆写）
      await api.setCustomProvider(wsId, { ...config, apiKey: trimmed });
      await applyDefaultModel();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={`provider-setup-row ${hasKey ? "is-connected" : ""}`}>
      <div className="provider-setup-row-main">
        <span className="provider-setup-name">
          {hasKey ? <ShieldCheck size={13} /> : <KeyRound size={13} />}
          {config.providerId}
          {hasKey && <span className="provider-setup-badge">已配置</span>}
          <span className="provider-setup-sub">{config.baseUrl}</span>
        </span>
        {hasKey ? (
          <button type="button" className="app-dialog__btn" onClick={async () => { setPending(true); try { await applyDefaultModel(); onDone(); } finally { setPending(false); } }} disabled={pending}>
            {pending ? <Loader size={12} className="spin" /> : null} 使用
          </button>
        ) : (
          <button type="button" className="app-dialog__btn primary" onClick={() => setKeyInputOpen((v) => !v)} disabled={pending}>
            <KeyRound size={12} /> 配置 Key
          </button>
        )}
      </div>
      {keyInputOpen && !hasKey && (
        <div className="provider-setup-key">
          <input
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveWithKey(); }}
            placeholder="粘贴 API Key（仅保存在本机）"
            autoFocus
          />
          <button type="button" className="app-dialog__btn primary" onClick={saveWithKey} disabled={pending || !keyValue.trim()}>
            保存
          </button>
        </div>
      )}
      {error && <div className="provider-setup-error">{error}</div>}
    </div>
  );
}

/** 行内新增自定义 provider（OpenAI 兼容）：ID / Base URL / API Key / 接口类型 / 模型列表 */
function CustomProviderFormInline({
  wsId,
  existingIds,
  onSaved,
}: {
  wsId: string;
  existingIds: readonly string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiType, setApiType] = useState<"openai-completions" | "openai-responses">("openai-completions");
  const [modelsText, setModelsText] = useState("");
  const [pending, setPending] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const api = window.piApp;

  if (!open) {
    return (
      <button type="button" className="provider-setup-add" onClick={() => setOpen(true)}>
        <Plus size={12} /> 添加自定义端点
      </button>
    );
  }

  const handleProbe = async () => {
    setProbing(true); setError(undefined);
    try {
      const result: CustomProviderProbeResult = await api.probeCustomProviderModels({
        baseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      if (result.ok) {
        setModelsText(result.models.join("\n"));
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const handleSave = async () => {
    setError(undefined);
    const id = providerId.trim();
    if (!id) { setError("Provider ID 不能为空"); return; }
    if (existingIds.includes(id)) { setError(`Provider ID "${id}" 已存在`); return; }
    if (!baseUrl.trim()) { setError("Base URL 不能为空"); return; }
    const modelList = modelsText.split("\n").map((m) => m.trim()).filter(Boolean);
    if (modelList.length === 0) { setError("至少配置一个模型（可点「拉取模型列表」自动获取）"); return; }
    setPending(true);
    try {
      await api.setCustomProvider(wsId, {
        providerId: id,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        api: apiType,
        models: modelList.map((m) => ({ id: m })),
      });
      onSaved();
      setOpen(false);
      setProviderId(""); setBaseUrl(""); setApiKey(""); setModelsText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="provider-setup-custom-form">
      <div className="provider-setup-key">
        <input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="Provider ID（如 my-openai）" />
      </div>
      <div className="provider-setup-key">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL（https://…/v1）" />
      </div>
      <div className="provider-setup-key">
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key（可选）" />
        <button type="button" className="app-dialog__btn" onClick={handleProbe} disabled={probing || !baseUrl.trim()}>
          {probing ? <Loader size={12} className="spin" /> : null} 拉取模型列表
        </button>
      </div>
      <div className="provider-setup-key">
        <select className="provider-setup-api-select" value={apiType} onChange={(e) => setApiType(e.target.value as "openai-completions" | "openai-responses")}>
          <option value="openai-completions">Chat Completions（大多数端点）</option>
          <option value="openai-responses">Responses（Echoly 等中转）</option>
        </select>
      </div>
      <div className="provider-setup-key">
        <textarea
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder={"模型 ID，每行一个"}
          rows={3}
        />
      </div>
      <div className="provider-setup-key">
        <button type="button" className="app-dialog__btn primary" onClick={handleSave} disabled={pending}>
          {pending ? <Loader size={12} className="spin" /> : null} 保存
        </button>
        <button type="button" className="app-dialog__btn" onClick={() => setOpen(false)}>收起</button>
      </div>
      {error && <div className="provider-setup-error">{error}</div>}
    </div>
  );
}
