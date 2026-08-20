import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, Check, Brain } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

interface Props {
  state: DesktopAppState;
}

/**
 * 模型选择器（codex 风格）：底部输入框左侧，显示当前 provider/model，
 * 点击展开下拉选模型 + thinking level。
 */
export function ModelSelector({ state }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const runtime = state.runtimeByWorkspace[state.selectedWorkspaceId];
  // 只显示已配置/可用的模型（available=true 表示 provider 已配置 auth）
  const allModels = runtime?.models ?? [];
  const models = allModels.filter((m) => m.available);
  const settings = state.globalModelSettings;

  // 当前选中的模型：会话级配置优先（handleSelect 写的是 setSessionModel），
  // 无会话/未设置时回落全局默认——否则切换会话模型后按钮标签不变化
  const session = state.workspaces
    .find((w) => w.id === state.selectedWorkspaceId)
    ?.sessions.find((s) => s.id === state.selectedSessionId);
  const current = useMemo(() => {
    if (models.length === 0) return null;
    const sessionCfg = session?.config;
    if (sessionCfg?.provider && sessionCfg.modelId) {
      const found = models.find((m) => m.providerId === sessionCfg.provider && m.modelId === sessionCfg.modelId);
      if (found) return found;
    }
    if (settings) {
      return models.find((m) => m.providerId === settings.defaultProvider && m.modelId === settings.defaultModelId)
        ?? models[0];
    }
    return models[0];
  }, [models, settings, session]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = async (providerId: string, modelId: string) => {
    // 优先用 per-session 设置，fallback 到全局默认
    if (state.selectedSessionId) {
      try {
        await window.piApp.setSessionModel(state.selectedWorkspaceId, state.selectedSessionId, providerId, modelId);
        setOpen(false);
        return;
      } catch {}
    }
    await window.piApp.setDefaultModel(state.selectedWorkspaceId, providerId, modelId);
    setOpen(false);
  };

  if (!current) {
    return <button className="model-selector-btn" disabled>无可用模型</button>;
  }

  return (
    <div className="model-selector-wrap" ref={ref}>
      <button className="model-selector-btn" onClick={() => setOpen(!open)} title="切换模型">
        <Brain size={13} />
        <span className="model-label">{current.label || current.modelId}</span>
        <ChevronDown size={12} className={open ? "chev-up" : ""} />
      </button>
      {open && (
        <div className="model-dropdown">
          <div className="dropdown-title">选择模型</div>
          {models.map((m) => (
            <button
              key={`${m.providerId}/${m.modelId}`}
              className={`dropdown-item ${m.providerId === current.providerId && m.modelId === current.modelId ? "active" : ""}`}
              onClick={() => handleSelect(m.providerId, m.modelId)}
              disabled={!m.available}
            >
              <span className="item-label">
                {m.label || m.modelId}
                <span className="item-provider">{m.providerName}</span>
              </span>
              {m.providerId === current.providerId && m.modelId === current.modelId && <Check size={13} />}
            </button>
          ))}
          {models.length === 0 && <div className="dropdown-empty">暂无可用模型，请在设置中配置 Provider</div>}
        </div>
      )}
    </div>
  );
}
