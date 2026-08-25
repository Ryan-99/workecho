import { useEffect, useState } from "react";
import { Cloud, KeyRound, Loader, LogIn, ShieldCheck, X } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";
import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";

/**
 * 模型服务配置引导弹窗。
 *
 * 背景:首次发消息时 pi 运行时对未认证 provider 会弹"Enter your API key"
 * 裸输入框(上游英文文案)——体验差且内网用户本应走 CoStrict。主进程在
 * onPrompt 拦截 API Key 型认证请求,推送 workbench:provider-setup-needed,
 * 由本弹窗给出完整的 provider 列表引导当场配置。
 */
export function ProviderSetupDialog({
  state,
  reason,
  onClose,
  onOpenSettings,
}: {
  state: DesktopAppState;
  reason?: string;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const wsId = state.selectedWorkspaceId;
  const runtime = state.runtimeByWorkspace[wsId];
  const providers = runtime?.providers ?? [];
  const models = runtime?.models ?? [];

  // CoStrict 行内合成(与设置页一致:登录/断开走 loginProvider 主进程特判)
  const [costrict, setCostrict] = useState<{ apiKeySaved?: boolean } | null>(null);
  useEffect(() => {
    const api = window as unknown as { piApp?: { costrictStatus?: () => Promise<{ apiKeySaved?: boolean }> } };
    api.piApp?.costrictStatus?.().then(setCostrict).catch(() => {});
  }, [providers.length]);
  const costrictRecord: RuntimeProviderRecord = {
    id: "costrict",
    name: "CoStrict（内网一键接入）",
    hasAuth: Boolean(costrict?.apiKeySaved),
    authType: costrict?.apiKeySaved ? "oauth" : "none",
    authSource: costrict?.apiKeySaved ? "oauth" : "none",
    oauthSupported: true,
    apiKeySetupSupported: false,
  };

  const connected = providers.filter((p) => p.hasAuth);
  const oauthProviders = [costrictRecord, ...providers.filter((p) => p.oauthSupported && p.id !== "costrict")];
  const apiKeyProviders = providers.filter((p) => p.apiKeySetupSupported && !p.oauthSupported);

  return (
    <div className="app-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-dialog provider-setup-dialog">
        <button className="app-dialog__close" onClick={onClose} title="关闭"><X size={14} /></button>
        <div className="app-dialog__message">配置模型服务</div>
        <div className="app-dialog__detail">
          {reason ? `${reason}。` : ""}发送消息前需要至少接入一个模型服务——从下面选择一种方式，配好后重新发送即可。
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

        <div className="provider-setup-group">
          <div className="provider-setup-group-title">直接登录（推荐）</div>
          {oauthProviders.map((p) => (
            <ProviderRow key={p.id} provider={p} wsId={wsId} onDone={onClose} models={models} />
          ))}
        </div>

        {apiKeyProviders.length > 0 && (
          <div className="provider-setup-group">
            <div className="provider-setup-group-title">API Key 配置</div>
            {apiKeyProviders.map((p) => (
              <ProviderRow key={p.id} provider={p} wsId={wsId} onDone={onClose} models={models} />
            ))}
          </div>
        )}

        <div className="provider-setup-footer">
          自定义 OpenAI 兼容端点请在
          <button
            type="button"
            className="link-btn"
            onClick={() => { onClose(); onOpenSettings(); }}
          >设置 → 模型 Provider</button>
          中添加。
        </div>
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

  /** 配置成功后把默认模型切到该 provider 的首个可用模型，避免配好了仍用旧 provider */
  const applyDefaultModel = async () => {
    try {
      const firstModel = models.find((m) => m.providerId === provider.id && m.available)
        ?? models.find((m) => m.providerId === provider.id);
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
