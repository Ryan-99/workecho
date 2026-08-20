import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, Terminal, PanelRightClose, PanelRightOpen, Minus, Square, X } from "lucide-react";
import workechoMarkUrl from "./assets/workecho-mark.svg?url";
import type { DesktopAppState, AppView } from "./desktop-state";
import type { SelectedTranscriptRecord } from "./desktop-state";
import type { PiDesktopApi } from "./ipc";
import { Sidebar } from "./shell/Sidebar";
import { ChatPanel } from "./shell/ChatPanel";
import { StatusPanel } from "./shell/StatusPanel";
import { SettingsView, SETTINGS_TABS, type SettingsTab } from "./shell/SettingsView";
import { WelcomeView } from "./shell/WelcomeView";
import { DialogHost } from "./shell/app-dialog";
import { OnboardingView } from "./shell/OnboardingView";
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

  // 订阅主进程状态推送（单一数据源：main 的 DesktopAppStore）
  useEffect(() => {
    const api = (window as any).piApp;
    if (!api) return; // 缺少 piApp 时由渲染层的诊断占位处理
    let rev = -1;
    api.getState().then((s: DesktopAppState) => {
      rev = s.revision;
      setState(s);
      setLocalView(s.activeView);
    }).catch((e: unknown) => console.error("[App] getState failed:", e));
    const off = api.onStateChanged((s: DesktopAppState) => {
      // revision 守卫：防止旧快照覆盖新快照
      if (s.revision > rev) {
        rev = s.revision;
        setState(s);
        setLocalView(s.activeView);
      }
    });
    return off;
  }, []);

  // 订阅选中会话的 transcript（对话内容）
  useEffect(() => {
    const api = window.piApp;
    api.getSelectedTranscript().then(setTranscript);
    const off = api.onSelectedTranscriptChanged(setTranscript);
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
    setState(s);
  }, []);

  // 发送消息
  const sendMessage = useCallback(async (text: string) => {
    const s = await window.piApp.submitComposer(text);
    setState(s);
  }, []);

  // 新建会话
  const newSession = useCallback(async () => {
    const s = await window.piApp.createSession({ workspaceId: state?.selectedWorkspaceId ?? "" });
    setState(s);
  }, [state?.selectedWorkspaceId]);

  // 选择会话：立即切 UI（不等 IPC 队列），避免 agent streaming 时卡住
  const selectSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    // 切出当前会话：异步生成标题（不阻塞切换）
    if (state.selectedSessionId && state.selectedSessionId !== sessionId) {
      const api = window.piApp as any;
      if (api.generateSessionTitle) {
        api.generateSessionTitle(state.selectedWorkspaceId, state.selectedSessionId)
          .then(() => api.getState().then((s: DesktopAppState) => setState(s)))
          .catch((e: unknown) => console.error("[App] 标题生成失败:", e));
      }
    }
    // 立即本地切换 UI（不等 IPC，避免串行队列阻塞）
    setLocalView("threads");
    // 乐观更新 transcript：清空当前，让新会话的 onSelectedTranscriptChanged 推送回来
    setTranscript(null);
    // 异步通知主进程（fire-and-forget，onStateChanged 会最终同步）
    window.piApp.selectSession({ workspaceId: state.selectedWorkspaceId, sessionId }).catch(() => {});
  }, [state]);

  // 归档会话（从列表收起，不删除数据）
  const archiveSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    try {
      const s = await window.piApp.archiveSession({ workspaceId: state.selectedWorkspaceId, sessionId });
      setState(s);
    } catch (e) {
      console.error("[App] 归档会话失败:", e);
    }
  }, [state]);

  // 删除会话（pi-gui 无独立删除 IPC，用 archive 实现）
  const deleteSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    try {
      const s = await window.piApp.archiveSession({ workspaceId: state.selectedWorkspaceId, sessionId });
      setState(s);
    } catch (e) {
      console.error("[App] 删除会话失败:", e);
    }
  }, [state]);

  // 恢复归档会话
  const restoreSession = useCallback(async (sessionId: string) => {
    if (!state) return;
    try {
      const s = await window.piApp.unarchiveSession({ workspaceId: state.selectedWorkspaceId, sessionId });
      setState(s);
    } catch (e) {
      console.error("[App] 恢复会话失败:", e);
    }
  }, [state]);

  // 停止生成
  const cancelRun = useCallback(async () => {
    const s = await window.piApp.cancelCurrentRun();
    setState(s);
  }, []);

  // 切换主题
  const setTheme = useCallback(async (mode: "system" | "light" | "dark") => {
    const s = await window.piApp.setThemeMode(mode);
    setState(s);
  }, []);

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
      <OnboardingView
        defaultPath={defaultPath}
        onPickWorkspace={async () => window.piApp.onboardingPickWorkspace()}
        onConfirmWorkspace={async (p) => { await window.piApp.onboardingConfirmWorkspace(p); }}
        onScan={async () => window.piApp.onboardingScan()}
        onFinish={async () => {
          await window.piApp.onboardingFinish();
          setOnboarding(false);
        }}
      />
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
            if (s) setState(s);
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
