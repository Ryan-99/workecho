import { contextBridge, ipcRenderer, webUtils } from "electron";
import { PRELOAD_DEV_RELOAD_MARKER } from "./dev-reload-preload-probe";
import {
  desktopIpc,
  type CustomProviderConfig,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
  type ChangedFilesResult,
  type DesktopNotificationPermissionStatus,
  type WorkspaceFilePreview,
  type PiDesktopCommand,
  type TerminalDataEvent,
  type TerminalErrorEvent,
  type TerminalExitEvent,
  type TerminalPanelSnapshot,
  type TerminalSize,
} from "../src/ipc";
import type {
  NavigateSessionTreeOptions,
  NavigateSessionTreeResult,
  SessionTreeSnapshot,
} from "@pi-gui/session-driver/types";
import type {
  HostUiResponse,
} from "@pi-gui/session-driver";
import type { RuntimeSettingsSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  AppView,
  ComposerAttachment,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  ForkThreadInput,
  NotificationPreferences,
  RemoveWorktreeInput,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  SelectedTranscriptRecord,
  StartThreadInput,
  ThemePresetId,
  WorkspaceSessionTarget,
} from "../src/desktop-state";

const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";

function resolveDevReloadMarkers() {
  if (!devReloadMarkersEnabled) {
    return undefined;
  }

  return {
    preload: PRELOAD_DEV_RELOAD_MARKER,
  };
}

const devReloadMarkers = resolveDevReloadMarkers();

if (devReloadMarkers) {
  contextBridge.exposeInMainWorld("__piDevReloadHost", devReloadMarkers);
}

function subscribeIpc<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("piApp", {
  platform: process.platform,
  versions: process.versions,
  ping: () => ipcRenderer.invoke(desktopIpc.ping) as Promise<string>,
  getState: () => ipcRenderer.invoke(desktopIpc.stateRequest) as Promise<DesktopAppState>,
  onStateChanged: (listener: (state: DesktopAppState) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: DesktopAppState) => {
      listener(state);
    };
    ipcRenderer.on(desktopIpc.stateChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.stateChanged, handle);
    };
  },
  getSelectedTranscript: () =>
    ipcRenderer.invoke(desktopIpc.selectedTranscriptRequest) as Promise<SelectedTranscriptRecord | null>,
  onSelectedTranscriptChanged: (listener: (payload: SelectedTranscriptRecord | null) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: SelectedTranscriptRecord | null) => {
      listener(payload);
    };
    ipcRenderer.on(desktopIpc.selectedTranscriptChanged, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.selectedTranscriptChanged, handle);
    };
  },
  onCommand: (listener: (command: PiDesktopCommand) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, command: PiDesktopCommand) => {
      listener(command);
    };
    ipcRenderer.on(desktopIpc.appCommand, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.appCommand, handle);
    };
  },
  onWorkspacePicked: (listener: (workspaceId: string) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, workspaceId: string) => {
      listener(workspaceId);
    };
    ipcRenderer.on(desktopIpc.workspacePicked, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.workspacePicked, handle);
    };
  },
  onClipboardImagePasted: (listener: (attachment: ComposerImageAttachment) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, attachment: ComposerImageAttachment) => {
      listener(attachment);
    };
    ipcRenderer.on(desktopIpc.clipboardImagePasted, handle);
    return () => {
      ipcRenderer.removeListener(desktopIpc.clipboardImagePasted, handle);
    };
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  addWorkspacePath: (workspacePath: string) =>
    ipcRenderer.invoke(desktopIpc.addWorkspacePath, workspacePath) as Promise<DesktopAppState>,
  pickWorkspace: () => ipcRenderer.invoke(desktopIpc.pickWorkspace) as Promise<DesktopAppState>,
  selectWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.selectWorkspace, workspaceId) as Promise<DesktopAppState>,
  renameWorkspace: (workspaceId: string, displayName: string) =>
    ipcRenderer.invoke(desktopIpc.renameWorkspace, workspaceId, displayName) as Promise<DesktopAppState>,
  removeWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.removeWorkspace, workspaceId) as Promise<DesktopAppState>,
  reorderWorkspaces: (workspaceOrder: readonly string[]) =>
    ipcRenderer.invoke(desktopIpc.reorderWorkspaces, workspaceOrder) as Promise<DesktopAppState>,
  reorderPinnedSessions: (pinnedSessionOrder: readonly string[]) =>
    ipcRenderer.invoke(desktopIpc.reorderPinnedSessions, pinnedSessionOrder) as Promise<DesktopAppState>,
  openWorkspaceInFinder: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.openWorkspaceInFinder, workspaceId) as Promise<void>,
  createWorktree: (input: CreateWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.createWorktree, input) as Promise<DesktopAppState>,
  removeWorktree: (input: RemoveWorktreeInput) =>
    ipcRenderer.invoke(desktopIpc.removeWorktree, input) as Promise<DesktopAppState>,
  openSkillInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openSkillInFinder, workspaceId, filePath) as Promise<void>,
  openExtensionInFinder: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.openExtensionInFinder, workspaceId, filePath) as Promise<void>,
  syncCurrentWorkspace: () =>
    ipcRenderer.invoke(desktopIpc.syncCurrentWorkspace) as Promise<DesktopAppState>,
  selectSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.selectSession, target) as Promise<DesktopAppState>,
  renameSession: (target: WorkspaceSessionTarget, title: string) =>
    ipcRenderer.invoke(desktopIpc.renameSession, target, title) as Promise<DesktopAppState>,
  archiveSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.archiveSession, target) as Promise<DesktopAppState>,
  unarchiveSession: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.unarchiveSession, target) as Promise<DesktopAppState>,
  markSessionRead: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.markSessionRead, target) as Promise<DesktopAppState>,
  setSessionPinned: (target: WorkspaceSessionTarget, pinned: boolean) =>
    ipcRenderer.invoke(desktopIpc.setSessionPinned, target, pinned) as Promise<DesktopAppState>,
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke(desktopIpc.createSession, input) as Promise<DesktopAppState>,
  startThread: (input: StartThreadInput) =>
    ipcRenderer.invoke(desktopIpc.startThread, input) as Promise<DesktopAppState>,
  forkThread: (input: ForkThreadInput) =>
    ipcRenderer.invoke(desktopIpc.forkThread, input) as Promise<DesktopAppState>,
  sendChildThreadFollowUp: (input: SendChildThreadFollowUpInput) =>
    ipcRenderer.invoke(desktopIpc.sendChildThreadFollowUp, input) as Promise<DesktopAppState>,
  setChildSupervisionLoop: (input: SetChildSupervisionLoopInput) =>
    ipcRenderer.invoke(desktopIpc.setChildSupervisionLoop, input) as Promise<DesktopAppState>,
  cancelCurrentRun: () => ipcRenderer.invoke(desktopIpc.cancelCurrentRun) as Promise<DesktopAppState>,
  setActiveView: (view: AppView) =>
    ipcRenderer.invoke(desktopIpc.setActiveView, view) as Promise<DesktopAppState>,
  setSidebarCollapsed: (collapsed: boolean) =>
    ipcRenderer.invoke(desktopIpc.setSidebarCollapsed, collapsed) as Promise<DesktopAppState>,
  refreshRuntime: (workspaceId?: string) =>
    ipcRenderer.invoke(desktopIpc.refreshRuntime, workspaceId) as Promise<DesktopAppState>,
  setModelSettingsScopeMode: (mode: "app-global" | "per-repo") =>
    ipcRenderer.invoke(desktopIpc.setModelSettingsScopeMode, mode) as Promise<DesktopAppState>,
  setDefaultModel: (workspaceId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(desktopIpc.setDefaultModel, workspaceId, provider, modelId) as Promise<DesktopAppState>,
  setDefaultThinkingLevel: (workspaceId: string, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
    ipcRenderer.invoke(desktopIpc.setDefaultThinkingLevel, workspaceId, thinkingLevel) as Promise<DesktopAppState>,
  setSessionModel: (workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke(desktopIpc.setSessionModel, workspaceId, sessionId, provider, modelId) as Promise<DesktopAppState>,
  setSessionThinkingLevel: (workspaceId: string, sessionId: string, thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"]) =>
    ipcRenderer.invoke(desktopIpc.setSessionThinkingLevel, workspaceId, sessionId, thinkingLevel) as Promise<DesktopAppState>,
  loginProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(desktopIpc.loginProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  logoutProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(desktopIpc.logoutProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  setProviderApiKey: (workspaceId: string, providerId: string, apiKey: string) =>
    ipcRenderer.invoke(desktopIpc.setProviderApiKey, workspaceId, providerId, apiKey) as Promise<DesktopAppState>,
  listCustomProviders: () =>
    ipcRenderer.invoke(desktopIpc.listCustomProviders) as Promise<readonly CustomProviderConfig[]>,
  setCustomProvider: (workspaceId: string, config: CustomProviderConfig) =>
    ipcRenderer.invoke(desktopIpc.setCustomProvider, workspaceId, config) as Promise<DesktopAppState>,
  deleteCustomProvider: (workspaceId: string, providerId: string) =>
    ipcRenderer.invoke(desktopIpc.deleteCustomProvider, workspaceId, providerId) as Promise<DesktopAppState>,
  probeCustomProviderModels: (input: CustomProviderProbeInput) =>
    ipcRenderer.invoke(desktopIpc.probeCustomProviderModels, input) as Promise<CustomProviderProbeResult>,
  setEnableSkillCommands: (workspaceId: string, enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setEnableSkillCommands, workspaceId, enabled) as Promise<DesktopAppState>,
  setScopedModelPatterns: (workspaceId: string, patterns: readonly string[]) =>
    ipcRenderer.invoke(desktopIpc.setScopedModelPatterns, workspaceId, patterns) as Promise<DesktopAppState>,
  setSkillEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setSkillEnabled, workspaceId, filePath, enabled) as Promise<DesktopAppState>,
  setExtensionEnabled: (workspaceId: string, filePath: string, enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setExtensionEnabled, workspaceId, filePath, enabled) as Promise<DesktopAppState>,
  respondToHostUiRequest: (workspaceId: string, sessionId: string, response: HostUiResponse) =>
    ipcRenderer.invoke(desktopIpc.respondToHostUiRequest, workspaceId, sessionId, response) as Promise<DesktopAppState>,
  setNotificationPreferences: (preferences: Partial<NotificationPreferences>) =>
    ipcRenderer.invoke(desktopIpc.setNotificationPreferences, preferences) as Promise<DesktopAppState>,
  setIntegratedTerminalShell: (shellPath: string) =>
    ipcRenderer.invoke(desktopIpc.setIntegratedTerminalShell, shellPath) as Promise<DesktopAppState>,
  setEnableTransparency: (enabled: boolean) =>
    ipcRenderer.invoke(desktopIpc.setEnableTransparency, enabled) as Promise<DesktopAppState>,
  setThemePresetId: (presetId: ThemePresetId) =>
    ipcRenderer.invoke(desktopIpc.setThemePresetId, presetId) as Promise<DesktopAppState>,
  ensureTerminalPanel: (workspaceId: string, terminalScopeId: string, size?: Partial<TerminalSize>) =>
    ipcRenderer.invoke(desktopIpc.terminalEnsurePanel, workspaceId, terminalScopeId, size) as Promise<TerminalPanelSnapshot>,
  createTerminalSession: (workspaceId: string, terminalScopeId: string, size?: Partial<TerminalSize>) =>
    ipcRenderer.invoke(desktopIpc.terminalCreateSession, workspaceId, terminalScopeId, size) as Promise<TerminalPanelSnapshot>,
  setActiveTerminalSession: (workspaceId: string, terminalScopeId: string, terminalId: string) =>
    ipcRenderer.invoke(desktopIpc.terminalSetActiveSession, workspaceId, terminalScopeId, terminalId) as Promise<TerminalPanelSnapshot>,
  writeTerminal: (terminalId: string, data: string) =>
    ipcRenderer.invoke(desktopIpc.terminalWrite, terminalId, data) as Promise<void>,
  resizeTerminal: (terminalId: string, size: TerminalSize) =>
    ipcRenderer.invoke(desktopIpc.terminalResize, terminalId, size) as Promise<void>,
  restartTerminalSession: (terminalId: string, size?: Partial<TerminalSize>) =>
    ipcRenderer.invoke(desktopIpc.terminalRestartSession, terminalId, size) as Promise<TerminalPanelSnapshot>,
  closeTerminalSession: (terminalId: string) =>
    ipcRenderer.invoke(desktopIpc.terminalCloseSession, terminalId) as Promise<TerminalPanelSnapshot | null>,
  setTerminalTitle: (terminalId: string, title: string) =>
    ipcRenderer.invoke(desktopIpc.terminalSetTitle, terminalId, title) as Promise<void>,
  setTerminalFocused: (focused: boolean) => {
    ipcRenderer.send(desktopIpc.terminalSetFocused, focused);
    return Promise.resolve();
  },
  onTerminalData: (listener: (event: TerminalDataEvent) => void) =>
    subscribeIpc(desktopIpc.terminalData, listener),
  onTerminalExit: (listener: (event: TerminalExitEvent) => void) =>
    subscribeIpc(desktopIpc.terminalExit, listener),
  onTerminalError: (listener: (event: TerminalErrorEvent) => void) =>
    subscribeIpc(desktopIpc.terminalError, listener),
  getNotificationPermissionStatus: () =>
    ipcRenderer.invoke(desktopIpc.getNotificationPermissionStatus) as Promise<DesktopNotificationPermissionStatus>,
  requestNotificationPermission: () =>
    ipcRenderer.invoke(desktopIpc.requestNotificationPermission) as Promise<DesktopNotificationPermissionStatus>,
  openSystemNotificationSettings: () =>
    ipcRenderer.invoke(desktopIpc.openSystemNotificationSettings) as Promise<void>,
  onNotificationPermissionStatusChanged: (callback: (status: DesktopNotificationPermissionStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopNotificationPermissionStatus) => callback(status);
    ipcRenderer.on(desktopIpc.notificationPermissionStatusChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.notificationPermissionStatusChanged, handler);
    };
  },
  pickComposerAttachments: () => ipcRenderer.invoke(desktopIpc.pickComposerAttachments) as Promise<DesktopAppState>,
  readClipboardImage: () => ipcRenderer.sendSync(desktopIpc.readClipboardImage) as ComposerImageAttachment | null,
  addComposerAttachments: (attachments: readonly ComposerAttachment[]) =>
    ipcRenderer.invoke(desktopIpc.addComposerAttachments, attachments) as Promise<DesktopAppState>,
  removeComposerAttachment: (attachmentId: string) =>
    ipcRenderer.invoke(desktopIpc.removeComposerAttachment, attachmentId) as Promise<DesktopAppState>,
  editQueuedComposerMessage: (messageId: string, currentDraft?: string) =>
    ipcRenderer.invoke(desktopIpc.editQueuedComposerMessage, messageId, currentDraft) as Promise<DesktopAppState>,
  cancelQueuedComposerEdit: () =>
    ipcRenderer.invoke(desktopIpc.cancelQueuedComposerEdit) as Promise<DesktopAppState>,
  removeQueuedComposerMessage: (messageId: string) =>
    ipcRenderer.invoke(desktopIpc.removeQueuedComposerMessage, messageId) as Promise<DesktopAppState>,
  steerQueuedComposerMessage: (messageId: string) =>
    ipcRenderer.invoke(desktopIpc.steerQueuedComposerMessage, messageId) as Promise<DesktopAppState>,
  updateComposerDraft: (composerDraft: string) =>
    ipcRenderer.invoke(desktopIpc.updateComposerDraft, composerDraft) as Promise<DesktopAppState>,
  submitComposer: (text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) =>
    ipcRenderer.invoke(desktopIpc.submitComposer, text, options) as Promise<DesktopAppState>,
  getSessionTree: (target: WorkspaceSessionTarget) =>
    ipcRenderer.invoke(desktopIpc.getSessionTree, target) as Promise<SessionTreeSnapshot>,
  navigateSessionTree: (target: WorkspaceSessionTarget, targetId: string, options?: NavigateSessionTreeOptions) =>
    ipcRenderer.invoke(desktopIpc.navigateSessionTree, target, targetId, options) as Promise<{
      readonly state: DesktopAppState;
      readonly result: NavigateSessionTreeResult;
    }>,
  listWorkspaceFiles: (workspaceId: string, options?: { readonly force?: boolean }) =>
    ipcRenderer.invoke(desktopIpc.listWorkspaceFiles, workspaceId, options) as Promise<string[]>,
  readWorkspaceFile: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.readWorkspaceFile, workspaceId, filePath) as Promise<WorkspaceFilePreview>,
  getChangedFiles: (workspaceId: string) =>
    ipcRenderer.invoke(desktopIpc.getChangedFiles, workspaceId) as Promise<ChangedFilesResult>,
  getFileDiff: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.getFileDiff, workspaceId, filePath) as Promise<string>,
  stageFile: (workspaceId: string, filePath: string, stagingSourcePath?: string) =>
    ipcRenderer.invoke(desktopIpc.stageFile, workspaceId, filePath, stagingSourcePath) as Promise<void>,
  discardFile: (workspaceId: string, filePath: string) =>
    ipcRenderer.invoke(desktopIpc.discardFile, workspaceId, filePath) as Promise<void>,
  toggleWindowMaximize: () => ipcRenderer.invoke(desktopIpc.toggleWindowMaximize) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke(desktopIpc.openExternal, url) as Promise<void>,
  getThemeMode: () => ipcRenderer.invoke(desktopIpc.getThemeMode) as Promise<"system" | "light" | "dark">,
  getResolvedTheme: () => ipcRenderer.invoke(desktopIpc.getResolvedTheme) as Promise<"light" | "dark">,
  setThemeMode: (mode: "system" | "light" | "dark") =>
    ipcRenderer.invoke(desktopIpc.setThemeMode, mode) as Promise<DesktopAppState>,
  onThemeChanged: (callback: (theme: "light" | "dark") => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: "light" | "dark") => callback(theme);
    ipcRenderer.on(desktopIpc.themeChanged, handler);
    return () => {
      ipcRenderer.removeListener(desktopIpc.themeChanged, handler);
    };
  },
  // 业务数据汇总（右侧状态面板用）
  getBusinessSummary: () => ipcRenderer.invoke("workbench:get-summary"),
  // 业务提示词（设置页可编辑）
  getBusinessPrompt: () => ipcRenderer.invoke("workbench:get-prompt") as Promise<string>,
  saveBusinessPrompt: (content: string) => ipcRenderer.invoke("workbench:save-prompt", content) as Promise<string>,
  // 首次启动引导
  onboardingPickWorkspace: () => ipcRenderer.invoke("onboarding:pick-workspace") as Promise<string | null>,
  onboardingConfirmWorkspace: (p: string) => ipcRenderer.invoke("onboarding:confirm-workspace", p) as Promise<string>,
  onboardingScan: () => ipcRenderer.invoke("onboarding:scan") as Promise<{ total: number; ok: number; categories: Record<string, number> }>,
  onboardingFinish: () => ipcRenderer.invoke("onboarding:finish") as Promise<boolean>,
  // 默认工作目录路径（给引导页显示）
  getDefaultWorkspacePath: () => ipcRenderer.invoke("workbench:get-default-path") as Promise<string>,
  needsOnboarding: () => ipcRenderer.invoke("workbench:needs-onboarding") as Promise<boolean>,
  generateSessionTitle: (workspaceId: string, sessionId: string) =>
    ipcRenderer.invoke("workbench:generate-title", workspaceId, sessionId) as Promise<string | null>,
  compactSession: () => ipcRenderer.invoke("workbench:compact-session") as Promise<DesktopAppState | null>,
  getExtensionsConfig: () => ipcRenderer.invoke("workbench:get-extensions-config"),
  saveMcpConfig: (servers: Record<string, any>) => ipcRenderer.invoke("workbench:save-mcp-config", servers),
  openDir: (dirPath: string) => ipcRenderer.invoke("workbench:open-dir", dirPath),
  getCards: () => ipcRenderer.invoke("workbench:get-cards"),
  saveCards: (cards: any[]) => ipcRenderer.invoke("workbench:save-cards", cards),
  getCardData: () => ipcRenderer.invoke("workbench:get-card-data"),
  deleteSessionForever: (workspaceId: string, sessionId: string) =>
    ipcRenderer.invoke("workbench:delete-session-forever", workspaceId, sessionId) as Promise<DesktopAppState | null>,
  checkUpdate: () => ipcRenderer.invoke("workbench:check-update"),
  openReleases: (url?: string) => ipcRenderer.invoke("workbench:open-releases", url),
  minimizeWindow: () => ipcRenderer.invoke("workbench:minimize-window"),
  updateEntity: (entityType: string, entityId: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke("workbench:update-entity", entityType, entityId, updates),
  getTodoRules: () => ipcRenderer.invoke("workbench:get-todo-rules") as Promise<string>,
  saveTodoRules: (content: string) => ipcRenderer.invoke("workbench:save-todo-rules", content) as Promise<string>,
  getSessionStats: () => ipcRenderer.invoke("workbench:get-session-stats"),
  exportSession: (format: "html" | "jsonl") => ipcRenderer.invoke("workbench:export-session", format) as Promise<string | null>,
  setAutoCompact: (enabled: boolean) => ipcRenderer.invoke("workbench:set-auto-compact", enabled),
  getAutoCompact: () => ipcRenderer.invoke("workbench:get-auto-compact") as Promise<boolean>,
  getContextUsage: () => ipcRenderer.invoke("workbench:get-context-usage"),
  getSessionTools: () => ipcRenderer.invoke("workbench:get-session-tools"),
  getSchemaInfo: () => ipcRenderer.invoke("workbench:get-schema-info"),
  // Wiki 知识库配置
  getWikiConfig: () => ipcRenderer.invoke("workbench:get-wiki-config"),
  saveWikiConfig: (config: Record<string, unknown>) => ipcRenderer.invoke("workbench:save-wiki-config", config),
  patchWikiConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("workbench:patch-wiki-config", patch),
  // Agent 自我修改插件管理（与 Extensions 设置页联动）
  listPlugins: () => ipcRenderer.invoke("workbench:list-plugins"),
  removePlugin: (name: string) => ipcRenderer.invoke("workbench:remove-plugin", name),
  createPlugin: (name: string, code: string) => ipcRenderer.invoke("workbench:create-plugin", name, code),
  createSkill: (name: string, description: string, content: string) => ipcRenderer.invoke("workbench:create-skill", name, description, content),
  pickDirectory: () => ipcRenderer.invoke("workbench:pick-directory"),
  importSkill: (sourceDir: string) => ipcRenderer.invoke("workbench:import-skill", sourceDir),
  // Hooks 规则管理（P2）
  listHooks: () => ipcRenderer.invoke("workbench:list-hooks"),
  addHook: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:add-hook", input),
  removeHook: (ruleId: string) => ipcRenderer.invoke("workbench:remove-hook", ruleId),
  // 工具进度（长任务进度条）
  onToolProgress: (listener: (p: { tool: string; phase: string; current: number; total: number; message?: string }) => void) => {
    const handler = (_e: unknown, payload: any) => listener(payload);
    ipcRenderer.on("workbench:tool-progress", handler);
    return () => ipcRenderer.removeListener("workbench:tool-progress", handler);
  },
  // 会话分组管理
  getSessionGroups: () => ipcRenderer.invoke("workbench:get-session-groups"),
  createSessionGroup: (name: string) => ipcRenderer.invoke("workbench:create-session-group", name),
  removeSessionGroup: (groupId: string) => ipcRenderer.invoke("workbench:remove-session-group", groupId),
  assignSessionGroup: (sessionId: string, groupId: string | null) => ipcRenderer.invoke("workbench:assign-session-group", sessionId, groupId),
  // 定时任务管理（渲染层 UI 用）
  listSchedulesUI: () => ipcRenderer.invoke("workbench:list-schedules-ui"),
  createScheduleUI: (rule: Record<string, unknown>) => ipcRenderer.invoke("workbench:create-schedule-ui", rule),
  removeScheduleUI: (ruleId: string) => ipcRenderer.invoke("workbench:remove-schedule-ui", ruleId),
  // Wiki 统计/图谱/搜索（Phase 5）
  // CoStrict 一键接入（托管 costrict-router，登录/断开走 loginProvider/logoutProvider）
  costrictStatus: () => ipcRenderer.invoke("workbench:costrict-status"),
  // 应用内弹窗（主进程发起 → 渲染层展示 → 结果回传）
  onAppDialog: (listener: (spec: any) => void) => {
    const handler = (_e: unknown, payload: any) => listener(payload);
    ipcRenderer.on("workbench:app-dialog", handler);
    return () => ipcRenderer.removeListener("workbench:app-dialog", handler);
  },
  appDialogResult: (id: number, result: { ok: boolean; value?: string }) =>
    ipcRenderer.invoke("workbench:app-dialog-result", id, result),
  onCostrictEvent: (listener: (e: { step: string; message: string }) => void) => {
    const handler = (_e: unknown, payload: any) => listener(payload);
    ipcRenderer.on("workbench:costrict-event", handler);
    return () => ipcRenderer.removeListener("workbench:costrict-event", handler);
  },
  getWikiStats: () => ipcRenderer.invoke("workbench:wiki-stats"),
  getWikiGraph: () => ipcRenderer.invoke("workbench:wiki-graph"),
  checkProviderHealth: (providerId: string) =>
    ipcRenderer.invoke("workbench:provider-health", providerId) as Promise<{
      providerId: string; configured: boolean; online: boolean | null; message: string;
    }>,
  getPlanMode: () => ipcRenderer.invoke("workbench:plan-mode") as Promise<boolean>,
  setPlanMode: (on: boolean) => ipcRenderer.invoke("workbench:plan-mode-set", on) as Promise<boolean>,
  getWikiPages: () => ipcRenderer.invoke("workbench:wiki-pages"),
  readWikiPage: (relPath: string) => ipcRenderer.invoke("workbench:wiki-read-page", relPath),
  wikiSearch: (query: string, limit?: number) => ipcRenderer.invoke("workbench:wiki-search", query, limit),
});
