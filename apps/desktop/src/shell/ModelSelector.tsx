import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, Check, Brain } from "lucide-react";
import type { DesktopAppState } from "../desktop-state";

interface Props {
  state: DesktopAppState;
}

/** 会话模型不在可用列表里时的占位展示——必须如实显示会话真正在用的模型，
 *  而不是悄悄回落到默认模型（否则按钮显示 A、实际发送用 B，用户无从发现）。 */
function staleModelEntry(providerId: string, modelId: string) {
  return {
    providerId,
    modelId,
    providerName: providerId,
    label: modelId,
    available: true,
    stale: true as const,
  };
}

/**
 * 模型选择器（codex 风格）：底部输入框左侧，显示当前 provider/model，
 * 点击展开下拉选模型 + thinking level。
 */
export function ModelSelector({ state }: Props) {
  const [open, setOpen] = useState(false);
  const [selectError, setSelectError] = useState<string | undefined>();
  const ref = useRef<HTMLDivElement>(null);

  const runtime = state.runtimeByWorkspace[state.selectedWorkspaceId];
  // 只显示已配置/可用的模型（available=true 表示 provider 已配置 auth）
  const allModels = runtime?.models ?? [];
  const models = allModels.filter((m) => m.available);
  const settings = state.globalModelSettings;

  // 当前选中的模型：会话级配置优先（handleSelect 写的是 setSessionModel），
  // 无会话/未设置时回落全局默认——否则切换会话模型后按钮标签不变化。
  // 会话模型已不在列表（provider 重配/手改 models.json）时如实展示原模型并标不可用。
  const session = state.workspaces
    .find((w) => w.id === state.selectedWorkspaceId)
    ?.sessions.find((s) => s.id === state.selectedSessionId);
  const current = useMemo(() => {
    if (models.length === 0) return null;
    const sessionCfg = session?.config;
    if (sessionCfg?.provider && sessionCfg.modelId) {
      const found = models.find((m) => m.providerId === sessionCfg.provider && m.modelId === sessionCfg.modelId);
      if (found) return found;
      return staleModelEntry(sessionCfg.provider, sessionCfg.modelId);
    }
    if (settings) {
      return models.find((m) => m.providerId === settings.defaultProvider && m.modelId === settings.defaultModelId)
        ?? models[0];
    }
    return models[0];
  }, [models, settings, session]);
  const isStale = Boolean((current as { stale?: boolean } | undefined)?.stale);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSelectError(undefined);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = async (providerId: string, modelId: string) => {
    setSelectError(undefined);
    // 优先用 per-session 设置，fallback 到全局默认。
    // IPC 失败不会 throw，而是把错误写进返回 state 的 lastError——
    // 之前静默吞掉会让"点了没反应"，现在在下拉里明确提示。
    if (state.selectedSessionId) {
      const result = await window.piApp.setSessionModel(state.selectedWorkspaceId, state.selectedSessionId, providerId, modelId);
      if (result.lastError) {
        setSelectError(`切换失败：${result.lastError}`);
        return;
      }
      setOpen(false);
      return;
    }
    const result = await window.piApp.setDefaultModel(state.selectedWorkspaceId, providerId, modelId);
    if (result.lastError) {
      setSelectError(`切换失败：${result.lastError}`);
      return;
    }
    setOpen(false);
  };

  if (!current) {
    return <button className="model-selector-btn" disabled>无可用模型</button>;
  }

  return (
    <div className="model-selector-wrap" ref={ref}>
      <button
        className={`model-selector-btn ${isStale ? "model-selector-btn--stale" : ""}`}
        onClick={() => { setOpen(!open); setSelectError(undefined); }}
        title={isStale ? "当前模型已不可用，发送时会自动切换到可用模型；也可在此手动选择" : "切换模型"}
      >
        <Brain size={13} />
        <span className="model-label">{current.label || current.modelId}{isStale ? "（不可用）" : ""}</span>
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
          {selectError && <div className="dropdown-error">{selectError}</div>}
        </div>
      )}
    </div>
  );
}
