import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, Terminal, PanelRightClose, PanelRightOpen, Minus, Square, X } from "lucide-react";
import workechoMarkUrl from "./assets/workecho-mark.svg?url";
import type { DesktopAppState, AppView } from "./desktop-state";
import type { SelectedTranscriptRecord } from "./desktop-state";
import type { PiDesktopApi } from "./ipc";
import { Sidebar } from "./shell/Sidebar";
import { ChatPanel } from "./shell/ChatPanel";
import { appConfirm, appAlert } from "./shell/app-dialog";
import { StatusPanel } from "./shell/StatusPanel";
import { SettingsView, SETTINGS_TABS, type SettingsTab } from "./shell/SettingsView";
import { WelcomeView } from "./shell/WelcomeView";
import { DialogHost } from "./shell/app-dialog";
import { OnboardingView } from "./shell/OnboardingView";
import { ProviderSetupDialog } from "./shell/ProviderSetupDialog";
import { ArchiveView } from "./shell/ArchiveView";
import { ScheduleManagerView } from "./shell/ScheduleManagerView";
import { WikiView } from "./shell/WikiView";
import { ExtensionDialogs } from "./shell/ExtensionUI";
import { TreeModal } from "./shell/TreeModal";
import { TerminalPanel } from "./shell/TerminalPanel";
import "./shell/app.css";

export default function App() {
  const [state, setState] = useState<DesktopAppState | null>(null);
  const [transcript, setTranscript] = useState<SelectedTranscriptRecord | null>(null);
  const [view, setLocalView] = useState<AppView>("threads");
  const [onboarding, setOnboarding] = useState(false);
  const [defaultPath, setDefaultPath] = useState("");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [showArchive, setShowArchive] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showTree, setShowTree] = useState(false);

  // 分支管理入口：从设置页 Extensions tab 触发
  useEffect(() => {
    const handler = () => setShowTree(true);
    window.addEventListener("open-tree-modal", handler);
    return () => window.removeEventListener("open-tree-modal", handler);
  }, []);

  // 定时任务管理入口：从侧边栏按钮 / 设置页触发（与知识库页互斥切换）
  useEffect(() => {
    const handler = () => { setShowSchedule(true); setShowWiki(false); };
    window.addEventListener("open-schedule-manager", handler);
    return () => window.removeEventListener("open-schedule-manager", handler);
  }, []);

  // 知识库页面入口（与定时任务页互斥切换）
  const [showWiki, setShowWiki] = useState(false);
  useEffect(() => {
    const handler = () => { setShowWiki(true); setShowSchedule(false); };
    window.addEventListener("open-wiki-manager", handler);
    return () => window.removeEventListener("open-wiki-manager", handler);
  }, []);

  // 从消息重开分支（P1-6）：时间线 hover 触发，走上游 forkThread（本地 fork）
  useEffect(() => {
    const handler = async (e: Event) => {
      const messageId = (e as CustomEvent<{ messageId?: string }>).detail?.messageId;
      const st = state;
      if (!messageId || !st?.selectedWorkspaceId || !st.selectedSessionId) return;
      const wsId = st.selectedWorkspaceId;
      const sid = st.selectedSessionId;
      const ok = await appConfirm("从这条消息重开分支？将创建一个新会话，保留到这条消息为止的上下文，之后的内容不带过去。");
      if (!ok) return;
      // fork 校验匹配的是 pi 会话分支条目 id，而时间线对无 id 消息会展示合成 id
      // （assistant-N）——两套 id 空间不通用。驱动层支持按"渲染消息序号"定位
      // 分支条目（findBranchEntryForRenderedMessageIndex），优先用它；transcript
      // 不可用时退回 messageId。
      const rendered = (transcript?.transcript ?? []).filter(
        (item): item is Extract<typeof item, { kind: "message" }> => item.kind === "message",
      );
      const renderedIndex = rendered.findIndex((item) => item.id === messageId);
      try {
        await window.piApp.forkThread({
          sourceWorkspaceId: wsId,
          sourceSessionId: sid,
          rootWorkspaceId: wsId,
          environment: "local",
          // 与旧 fork-modal 语义一致：包含所选消息（before 会把它丢掉）
          position: "after",
          ...(renderedIndex >= 0 ? { sourceMessageIndex: renderedIndex } : { sourceMessageId: messageId }),
        });
      } catch (err) {
        appAlert(`创建分支失败: ${(err as Error).message}`);
      }
    };
    window.addEventListener("fork-from-message", handler as EventListener);
    return () => window.removeEventListener("fork-from-message", handler as EventListener);
  }, [state, transcript]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(252);
  const [statusWidth, setStatusWidth] = useState(300);

  // 拖拽调整左栏宽度
  const handleSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(200, Math.min(400, startW + ev.clientX - startX));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // 拖拽调整右栏宽度
  const handleStatusResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = statusWidth;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(240, Math.min(480, startW + startX - ev.clientX));
      setStatusWidth(newW);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [statusWidth]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // R-12：revision 单调守卫——所有 setState(invoke 响应) 都要过这道闸，
  // 否则 await 期间到达的更新事件会被旧快照回滚（正确实现此前只在死代码岛里）
  const stateRevisionRef = useRef(-1);
  const applyState = useCallback((s: DesktopAppState | null | undefined) => {
    if (!s) return;
    const rev = typeof s.revision === "number" ? s.revision : -1;
    if (rev < stateRevisionRef.current) return; // 过期快照，丢弃
    stateRevisionRef.current = Math.max(stateRevisionRef.current, rev);
    setState(s);
    setLocalView(s.activeView);
  }, []);

  // 订阅主进程状态推送（单一数据源：main 的 DesktopAppStore）
  useEffect(() => {
    const api = (window as any).piApp;
    if (!api) return; // 缺少 piApp 时由渲染层的诊断占位处理
    api.getState().then((s: DesktopAppState) => {
      applyState(s);
    }).catch((e: unknown) => console.error("[App] getState failed:", e));
    const off = api.onStateChanged((s: DesktopAppState) => {
      // revision 守卫在 applyState 内：防止旧快照覆盖新快照
      applyState(s);
    });
    return off;
  }, [applyState]);

  // 订阅选中会话的 transcript（对话内容）
  useEffect(() => {
    const api = window.piApp;
    // R-13：初始拉取与推送竞态——用户快速切换会话时，A 会话的初始拉取结果
    // 可能晚于 B 会话的推送到达，把 B 的内容覆盖成 A。首个推送到达后初始
    // 拉取结果作废。
    let receivedPushedTranscript = false;
    api.getSelectedTranscript().then((t) => {
      if (!receivedPushedTranscript) setTranscript(t);
    });
    const off = api.onSelectedTranscriptChanged((t) => {
      receivedPushedTranscript = true;
      setTranscript(t);
    });
    return off;
  }, []);

  // 首次启动检测：是否需要引导
  useEffect(() => {
    const api = window.piApp as any;
    Promise.all([
      api.needsOnboarding(),
      api.getDefaultWorkspacePath(),
    ]).then(([needs, p]) => {
      setOnboarding(needs);
      setDefaultPath(p);
    });
  }, []);

  // 默认模型兜底：任何路径（引导/设置页/导入配置）配好 provider 后，若会话没有
  // 默认模型但已存在可用模型，自动选第一个——避免"已登录却要求先选模型"的断档
  const activeRuntime = state?.runtimeByWorkspace?.[state.selectedWorkspaceId ?? ""];
  useEffect(() => {
    if (!state?.selectedWorkspaceId || !activeRuntime?.settings) return;
    if (activeRuntime.settings.defaultModelId) return;
    const first = activeRuntime.models?.find((m) => m.available);
    if (!first) return;
    window.piApp
      .setDefaultModel(state.selectedWorkspaceId, first.providerId, first.modelId)
      .then((s) => applyState(s))
      .catch(() => {});
  }, [activeRuntime, state?.selectedWorkspaceId, applyState]);

  // 模型服务配置引导：首次发消息 pi 要 API key 时主进程拦截推送 → 弹完整 provider 列表
  const [providerSetup, setProviderSetup] = useState<{ reason?: string } | null>(null);

  // 引导第三步用：是否已有可用的模型服务。三类来源都要覆盖——
  // 内置 provider（runtime.providers.hasAuth）、CoStrict（apiKeySaved，注册为
  // pi 自定义 provider 不进内置列表）、自定义 OpenAI 兼容端点（带 apiKey）
  const [providerReady, setProviderReady] = useState(false);
  const runtimeProviders = state?.runtimeByWorkspace?.[state.selectedWorkspaceId ?? ""]?.providers;
  useEffect(() => {
    let alive = true;
    (async () => {
      const builtin = runtimeProviders?.some((p) => p.hasAuth) ?? false;
      let costrictOk = false;
      let customOk = false;
      try {
        const api = window as unknown as { piApp?: { costrictStatus?: () => Promise<{ apiKeySaved?: boolean }> } };
        costrictOk = Boolean((await api.piApp?.costrictStatus?.())?.apiKeySaved);
      } catch { /* 不可达时按未配置处理 */ }
      try {
        customOk = (await window.piApp.listCustomProviders()).some((c) => Boolean(c.apiKey));
      } catch { /* 忽略 */ }
      if (alive) setProviderReady(builtin || costrictOk || customOk);
    })();
    return () => { alive = false; };
  }, [runtimeProviders, providerSetup]);
  useEffect(() => {
    const api = (window as any).piApp;
    if (!api?.onProviderSetupNeeded) return;
    const off = api.onProviderSetupNeeded((p: { message: string }) => {
      setProviderSetup({ reason: "发送消息需要先接入一个模型服务" });
    });
    return off;
  }, []);

  // 长工具进度（init_workspace 等）：顶部细进度条
  const [toolProgress, setToolProgress] = useState<{ tool: string; phase: string; current: number; total: number; message?: string } | null>(null);
  useEffect(() => {
    const api = (window as any).piApp;
    if (!api?.onToolProgress) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onToolProgress((p: any) => {
      setToolProgress(p);
      // done 后 2 秒自动隐藏
      if (timer) clearTimeout(timer);
      if (p.phase === "done") {
        timer = setTimeout(() => setToolProgress(null), 2000);
      }
    });
    return () => { off?.(); if (timer) clearTimeout(timer); };
  }, []);

  // 切换视图（通知主进程，主进程回推新状态）
  const setActiveView = useCallback(async (v: AppView) => {
    setLocalView(v);
    const s = await window.piApp.setActiveView(v);
    applyState(s);
  }, [applyState]);

  // 发送消息
  const sendMessage = useCallback(async (text: string) => {
    const s = await window.piApp.submitComposer(text);
    applyState(s);
  }, []);

  // 新建会话
  const newSession = useCallback(async () => {
    const s = await window.piApp.createSession({ workspaceId: state?.selectedWorkspaceId ?? "" });
    applyState(s);
  }, [state?.selectedWorkspaceId, applyState]);

  // 选择会话：立即切 UI（不等 IPC 队列），避免 agent streaming 时卡住
  const selectSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    // 切出当前会话：异步生成标题（不阻塞切换）
    if (state.selectedSessionId && state.selectedSessionId !== sessionId) {
      const api = window.piApp as any;
      if (api.generateSessionTitle) {
        api.generateSessionTitle(state.selectedWorkspaceId, state.selectedSessionId)
          .then(() => api.getState().then((s: DesktopAppState) => applyState(s)))
          .catch((e: unknown) => console.error("[App] 标题生成失败:", e));
      }
    }
    // 立即本地切换 UI（不等 IPC，避免串行队列阻塞）
    setLocalView("threads");
    // 乐观更新 transcript：清空当前，让新会话的 onSelectedTranscriptChanged 推送回来
    setTranscript(null);
    // 异步通知主进程（fire-and-forget，onStateChanged 会最终同步）
    window.piApp.selectSession({ workspaceId: state.selectedWorkspaceId, sessionId }).catch(() => {});
  }, [state, applyState]);

  // 归档会话（从列表收起，不删除数据）
  const archiveSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    try {
      const s = await window.piApp.archiveSession({ workspaceId: state.selectedWorkspaceId, sessionId });
      applyState(s);
    } catch (e) {
      console.error("[App] 归档会话失败:", e);
    }
  }, [state]);

  // 删除会话（pi-gui 无独立删除 IPC，用 archive 实现）
  const deleteSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    try {
      const s = await window.piApp.archiveSession({ workspaceId: state.selectedWorkspaceId, sessionId });
      applyState(s);
    } catch (e) {
      console.error("[App] 删除会话失败:", e);
    }
  }, [state, applyState]);

  // 恢复归档会话
  const restoreSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    try {
      const s = await window.piApp.unarchiveSession({ workspaceId: state.selectedWorkspaceId, sessionId });
      applyState(s);
    } catch (e) {
      console.error("[App] 恢复会话失败:", e);
    }
  }, [state, applyState]);

  // 停止生成
  const cancelRun = useCallback(async () => {
    const s = await window.piApp.cancelCurrentRun();
    applyState(s);
  }, [applyState]);

  // 切换主题
  const setTheme = useCallback(async (mode: "system" | "light" | "dark") => {
    const s = await window.piApp.setThemeMode(mode);
    applyState(s);
  }, [applyState]);

  // 应用主题 class（light/dark）
  useEffect(() => {
    const apply = async () => {
      const resolved = await window.piApp.getResolvedTheme();
      document.documentElement.classList.toggle("dark", resolved === "dark");
    };
    apply();
    const off = window.piApp.onThemeChanged((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });
    return off;
  }, []);

  if (!state) {
    if (typeof window !== "undefined" && !(window as any).piApp) {
      return <div className="loading" style={{ color: "var(--danger)" }}>
        preload 未注入 window.piApp（sandbox 错误）。请检查控制台。
      </div>;
    }
    return <div className="loading">加载中…</div>;
  }

  // 首次启动引导（优先于一切）
  if (onboarding) {
    return (
      <>
      {/* 引导分支也必须挂 DialogHost：登录/确认类 app-dialog（如 provider 登录过程
          的 prompt）走全局 DialogHost 渲染，缺了它 await 会永远挂住（曾致登录卡死） */}
      <DialogHost />
      <OnboardingView
        defaultPath={defaultPath}
        onPickWorkspace={async () => window.piApp.onboardingPickWorkspace()}
        onConfirmWorkspace={async (p) => { await window.piApp.onboardingConfirmWorkspace(p); }}
        onScan={async () => window.piApp.onboardingScan()}
        onImport={async () => window.piApp.onboardingImport()}
        onConfigureProvider={() => setProviderSetup({ reason: "配置模型服务后即可开始对话" })}
        providerReady={providerReady}
        onFinish={async () => {
          await window.piApp.onboardingFinish();
          setOnboarding(false);
        }}
      />
      {/* 引导期间主界面未渲染，配置弹窗必须挂在引导分支里（否则点击无反应） */}
      {providerSetup && (
        <ProviderSetupDialog
          state={state}
          reason={providerSetup.reason}
          hideSettingsLink
          onClose={() => setProviderSetup(null)}
          onOpenSettings={() => setProviderSetup(null)}
        />
      )}
      </>
    );
  }

  const selectedWs = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  const allSessions = selectedWs?.sessions ?? [];
  const sessions = allSessions.filter((s) => !s.archivedAt);  // 过滤掉已归档/删除的
  const archivedSessions = allSessions.filter((s) => s.archivedAt);
  const hasSession = !!state.selectedSessionId && sessions.some((s) => s.id === state.selectedSessionId);

  return (
    <div className="app-shell">
      <DialogHost />
      {providerSetup && (
        <ProviderSetupDialog
          state={state}
          reason={providerSetup.reason}
          onClose={() => setProviderSetup(null)}
          onOpenSettings={() => { setActiveView("settings"); setSettingsTab("providers"); }}
        />
      )}
      {/* 统一标题栏：横跨三栏，深色背景，只有窗口控制 */}
      <div className="app-titlebar">
        <span className="app-titlebar__brand"><img src={workechoMarkUrl} alt="Workecho" className="app-titlebar__logo" /> Workecho</span>
        <div className="titlebar-drag__controls">
          <button className="titlebar-icon-btn" onClick={() => setShowTerminal(!showTerminal)} title="终端">
            <Terminal size={15} />
          </button>
          <button className="titlebar-icon-btn" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}>
            {sidebarCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
          </button>
          <button className="titlebar-icon-btn" onClick={() => (window as any).piApp?.minimizeWindow?.()} title="最小化"><Minus size={15} /></button>
          <button className="titlebar-icon-btn" onClick={() => (window as any).piApp?.toggleWindowMaximize?.()} title="最大化"><Square size={14} /></button>
          <button className="titlebar-icon-btn close" onClick={() => window.close()} title="关闭"><X size={15} /></button>
        </div>
      </div>

      {/* 长工具进度条（初始化等） */}
      {toolProgress && toolProgress.phase !== "done" && (
        <div className="tool-progress-bar">
          <div className="tool-progress-info">
            <span className="tool-progress-label">
              {toolProgress.message ?? toolProgress.phase}
              {toolProgress.total > 0 ? `（${toolProgress.current}/${toolProgress.total}）` : ""}
            </span>
          </div>
          <div className="tool-progress-track">
            <div
              className="tool-progress-fill"
              style={{ width: toolProgress.total > 0 ? `${Math.min(100, (toolProgress.current / toolProgress.total) * 100)}%` : "100%" }}
            />
          </div>
        </div>
      )}
      {toolProgress?.phase === "done" && (
        <div className="tool-progress-bar done">
          <span className="tool-progress-label">{toolProgress.message === "已中止" ? "已中止" : "初始化完成"}</span>
        </div>
      )}

      <div className="app-body">
      {view === "settings" ? (
        <>
          <aside className="sidebar">
            <div className="sidebar-header"><span className="sidebar-brand">设置</span></div>
            <div className="session-list">
              {SETTINGS_TABS.map((t) => (
                <div
                  key={t.id}
                  className={`session-item ${settingsTab === t.id ? "active" : ""}`}
                  onClick={() => setSettingsTab(t.id)}
                >
                  {t.icon} <span className="title">{t.label}</span>
                </div>
              ))}
            </div>
            <div className="sidebar-footer">
              <button onClick={() => setActiveView("threads")}><ArrowLeft size={14} /> 返回对话</button>
            </div>
          </aside>
          <main className="main-area">
            <SettingsView state={state} tab={settingsTab} onThemeChange={setTheme} />
          </main>
        </>
      ) : (
        <>
          <Sidebar
            sessions={sessions}
            orchestrationChildren={state.orchestrationChildren}
            activeSessionId={state.selectedSessionId}
            collapsed={state.sidebarCollapsed}
            workspaceId={state.selectedWorkspaceId}
            width={sidebarWidth}
            onNewSession={() => { setShowSchedule(false); setShowWiki(false); newSession(); }}
            onSelectSession={(id) => { setShowSchedule(false); setShowWiki(false); selectSession(id); }}
            onArchiveSession={archiveSession}
            onDeleteSession={deleteSession}
            onOpenSettings={() => setActiveView("settings")}
            onOpenArchive={() => setShowArchive(true)}
            onResize={handleSidebarResize}
            archivedCount={archivedSessions.length}
          />
          <main className="main-area">
            {showWiki ? (
              <WikiView onClose={() => setShowWiki(false)} />
            ) : showSchedule ? (
              <ScheduleManagerView onClose={() => setShowSchedule(false)} />
            ) : view === "new-thread" || !hasSession ? (
              <WelcomeView onSend={sendMessage} />
            ) : (
          <ChatPanel
            state={state}
            transcript={transcript}
            sending={isRunning(state)}
            showTerminal={showTerminal}
            onSend={sendMessage}
            onCancel={cancelRun}
            onStateRefresh={setState}
            scrollRef={scrollRef}
          />
            )}
          </main>
          <StatusPanel state={state} sidebarCollapsed={sidebarCollapsed} width={statusWidth} onResize={handleStatusResize} />
        </>
      )}
      <ExtensionDialogs state={state} />
      {showTree && <TreeModal state={state} onClose={() => setShowTree(false)} />}
      {showArchive && (
        <ArchiveView
          archivedSessions={archivedSessions}
          onRestore={restoreSession}
          onDeleteForever={async (id) => {
            if (!state) return;
            const s = await (window.piApp as any).deleteSessionForever(state.selectedWorkspaceId, id);
            if (s) applyState(s);
          }}
          onClose={() => setShowArchive(false)}
        />
      )}
      </div>
    </div>
  );
}

/** 当前选中会话是否有 run 在跑 */
function isRunning(state: DesktopAppState): boolean {
  const ws = state.workspaces.find((w) => w.id === state.selectedWorkspaceId);
  if (!ws) return false;
  const session = ws.sessions.find((s) => s.id === state.selectedSessionId);
  return session?.status === "running";
}
