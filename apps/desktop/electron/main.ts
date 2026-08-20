import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  shell,
  Notification,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { isValidHttpBaseUrl } from "@pi-gui/pi-sdk-driver";
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionContext } from "./pi-compat";
import { readFile, stat } from "node:fs/promises";
import { existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { augmentPosixPath } from "../scripts/augment-path.cjs";
import { DesktopAppStore, type DesktopAppViewState } from "./app-store";
import {
  createOrchestrationRuntimeExtension,
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "./orchestration-runtime";
import { createBusinessRuntimeExtension } from "./business-runtime";
import {
  PROVIDER_ID as COSTRICT_PROVIDER_ID, LOCAL_BASE_URL as COSTRICT_LOCAL_URL, DEFAULT_BASE_URL as COSTRICT_DEFAULT_URL,
  costrictLogin, costrictStart, costrictStop, costrictStatus, downloadBinary, installBundledBinary, fetchCostrictModels, readState as costrictReadState, writeState as costrictWriteState, setSecretCodec as setCostrictSecretCodec, managedBinaryPath,
} from "./costrict-service";
import type { CustomProviderInput } from "@pi-gui/pi-sdk-driver";
import { createPolicyExtension, setHookNotifier, setDangerousOpConfirmer } from "./tool-pipeline";
import { createMemoryInjectionExtension } from "./memory-injection";
import { updateMemory, getWikiStats, getWikiGraph, searchWiki, listWikiPages, readWikiPage } from "./wiki-manager";
import { getBusinessSummary, getCardData, readEntity, entityFile } from "./business-store";
import { createMcpExtension, summarizeMcpChanges } from "./mcp-client";
import { readCardConfig, saveCardConfig, type CardConfig } from "./card-config";
import { readTodoRules, writeTodoRules } from "./todo-rules";
import { readWikiConfig, writeWikiConfig, patchWikiConfig, getActiveWikiConfig, setActiveWikiUserDataDir, type WikiConfig } from "./wiki-config";
import { ensureScheduleFile, readScheduleRules, addScheduleRule, removeScheduleRule } from "./schedule-service";
import { readSessionGroups, createGroup, removeGroup, assignSessionToGroup } from "./session-groups";
import { listPlugins, removePlugin, createPlugin } from "./plugin-service";
import { createSkill, importSkill, userSkillsRoot } from "./skill-service";
import { ensureHooksFile, readHookRules, addHookRule, removeHookRule } from "./hooks-service";
import { setProgressWindowsProvider } from "./progress-broadcaster";
import { initWorkspaceDir, runInitScan } from "./workbench-init";
import { importFiles, scanDocs, getCommonDocDirs } from "./knowledge-service";
import { readBusinessPrompt, writeBusinessPrompt, syncPromptToWorkspace } from "./business-prompt";
import { ReminderScheduler } from "./reminder-scheduler";
import { TodoReminderService } from "./todo-reminder";
import * as orchestrationTools from "./app-store-orchestration";
import { getChangedFiles, getFileDiff, stageFile } from "./app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "./app-store-files";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./notification-manager";
import {
  NotificationPermissionService,
} from "./notification-permission";
import { checkForUpdate, initUpdateChecker, openReleasesPage } from "./update-checker";
import { ThemeManager } from "./theme-manager";
import { TerminalService } from "./terminal-service";
import type { AppView, DesktopAppState, ThemeMode, ThemePresetId } from "../src/desktop-state";
import {
  desktopIpc,
  getDesktopCommandFromShortcut,
  type ChangedFilesResult,
  type CustomProviderConfig,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../src/ipc";
import { SUPPORTED_COMPOSER_IMAGE_TYPES } from "../src/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  ForkThreadInput,
  RemoveWorktreeInput,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  StartThreadInput,
  WorkspaceSessionTarget,
} from "../src/desktop-state";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import type { GenerateThreadTitleOptions } from "@pi-gui/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@pi-gui/session-driver";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appTestMode = resolveAppTestMode(process.env.PI_APP_TEST_MODE);
const windowTestMode = appTestMode ?? "foreground";
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
// dev 诊断：PI_APP_CDP=1 时开 CDP 端口（http://127.0.0.1:9223/json）
if (process.env.PI_APP_CDP === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}
let store: DesktopAppStore;
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let integratedTerminalShell = "";

interface WindowViewState {
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly activeView: AppView;
  readonly sidebarCollapsed: boolean;
}

interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

const appWindows = new Set<BrowserWindow>();
const windowViews = new Map<number, WindowViewState>();
const stopPublishingStateByWebContentsId = new Map<number, () => void>();
const stopPublishingSelectedTranscriptByWebContentsId = new Map<number, () => void>();
const stopTrackingWindowActivationByWebContentsId = new Map<number, () => void>();
let stopNotifications: (() => void) | undefined;
let stopUpdateChecker: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let reminderScheduler: ReminderScheduler | undefined;
let todoReminder: TodoReminderService | undefined;
let retainedTerminalWorkspacePathSignature = "";
const terminalFocusedWebContentsIds = new Set<number>();
let quittingAfterStoreFlush = false;
let windowScopedActionQueue: Promise<void> = Promise.resolve();
let currentComposerDraftPersistOriginWebContentsId: number | undefined;
let currentWindowScopedWebContentsId: number | undefined;
let deferredActivationWebContentsId: number | undefined;

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType));
const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";

function createStoreBackedOrchestrationRuntimeBridge(): OrchestrationRuntimeBridge {
  return {
    createChildThread: async (ctx, input) => {
      await store.initialize();
      return orchestrationTools.createChildThreadToolResult(store, sessionRefFromExtensionContext(ctx), input);
    },
    listThreads: async (ctx) => {
      await store.initialize();
      return orchestrationTools.listThreadsToolResult(store, sessionRefFromExtensionContext(ctx));
    },
    readThread: async (ctx, threadId) => {
      await store.initialize();
      return orchestrationTools.readThreadToolResult(store, sessionRefFromExtensionContext(ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      await store.initialize();
      return orchestrationTools.sendMessageToThreadToolResult(store, sessionRefFromExtensionContext(ctx), input);
    },
  };
}

function sessionRefFromExtensionContext(ctx: ExtensionContext): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
  const workspace = store.state.workspaces.find(
    (entry) => path.resolve(entry.path) === cwd && entry.sessions.some((session) => session.id === sessionId),
  );
  if (!workspace) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return {
    workspaceId: workspace.id,
    sessionId,
  };
}

async function runOrchestrationRuntimeToolForTest(
  bridge: OrchestrationRuntimeBridge,
  input: OrchestrationRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createOrchestrationRuntimeTools(bridge).find((entry) => entry.name === input.toolName);
  if (!tool) {
    throw new Error(`Unknown orchestration runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

function createTestExtensionContext(sessionRef: SessionRef): ExtensionContext {
  const workspace = store.state.workspaces.find(
    (entry) => entry.id === sessionRef.workspaceId && entry.sessions.some((session) => session.id === sessionRef.sessionId),
  );
  if (!workspace) {
    throw new Error(`Unknown test session: ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }

  return {
    hasUI: false,
    mode: "json",
    cwd: workspace.path,
    sessionManager: {
      getSessionId: () => sessionRef.sessionId,
      getCwd: () => workspace.path,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    scopedModels: [],
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
}
/* ============ MCP 配置信任链辅助（安全审核 F-29/MCP-1） ============ */

function mcpConfigPath(agentDir: string): string {
  return path.join(agentDir, "mcp-servers.json");
}

function mcpConfigSha256(agentDir: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(mcpConfigPath(agentDir))).digest("hex");
  } catch {
    return null;
  }
}

function readStoredMcpHash(): string | null {
  try {
    return JSON.parse(readFileSync(path.join(configuredUserDataDir, "mcp-config-hash.json"), "utf-8")).sha256 ?? null;
  } catch {
    return null;
  }
}

function recordMcpHash(agentDir: string): void {
  const sha = mcpConfigSha256(agentDir);
  if (!sha) return;
  try {
    writeFileSync(path.join(configuredUserDataDir, "mcp-config-hash.json"), JSON.stringify({ sha256: sha }, null, 2), "utf-8");
  } catch { /* 记录失败：下次启动会再次 TOFU，无害 */ }
}

/** 解析现有 MCP 配置（供保存前 diff；解析失败返回 null） */
function readCurrentMcpServers(agentDir: string): Record<string, { command: string; args?: string[] }> | null {
  try {
    const raw = JSON.parse(readFileSync(mcpConfigPath(agentDir), "utf-8"));
    return raw.servers ?? raw;
  } catch {
    return null;
  }
}

const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const CHECK_FOR_UPDATES_MENU_ITEM_ID = "app.check-for-updates";
const QUIT_FLUSH_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_DIMENSION = 8_192;

function getTerminalService(): TerminalService {
  if (!terminalService) {
    terminalService = new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => integratedTerminalShell,
      isPackaged: app.isPackaged,
    });
  }
  return terminalService;
}

// Resolve the bundled application icon. In dev the repo's `resources/icon.png`
// sits two levels up from the compiled `out/main/main.js`; in a packaged build
// it is copied to `process.resourcesPath` via `extraResources` in
// electron-builder.yml. On macOS packaged builds the window/dock icon already
// comes from `icon.icns` in the app bundle, so we only need the PNG for dev
// and for Linux/Windows window chrome. On Windows prefer the ICO — the
// taskbar renders it more reliably than PNG.
const resourcesDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..", "..", "resources");
const icoPath = path.join(resourcesDir, "icon.ico");
const appIconPath = process.platform === "win32" && existsSync(icoPath)
  ? icoPath
  : path.join(resourcesDir, "icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);

function parseExternalWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function appRendererUrl(): string {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  return pathToFileURL(indexPath).toString();
}

function isInAppNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const appUrl = new URL(appRendererUrl());
    return parsed.href === appUrl.href || (isDev && parsed.origin === appUrl.origin);
  } catch {
    return false;
  }
}

function openExternalWebUrl(url: string): boolean {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    return false;
  }
  void shell.openExternal(parsed.toString()).catch((error) => {
    console.error(`Failed to open external URL: ${parsed.toString()}`, error);
  });
  return true;
}

function readClipboardImageAttachment(): ComposerImageAttachment | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }

  const size = image.getSize();
  if (size.width > MAX_CLIPBOARD_IMAGE_DIMENSION || size.height > MAX_CLIPBOARD_IMAGE_DIMENSION) {
    return null;
  }

  const png = image.toPNG();
  if (png.length === 0 || png.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    return null;
  }

  return {
    id: randomUUID(),
    kind: "image",
    name: "pasted-image.png",
    mimeType: "image/png",
    data: png.toString("base64"),
  };
}

function createWindow(): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = store ? store.state.enableTransparency : false;
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 560,
    minHeight: 600,
    transparent: enableTransparency,
    vibrancy: process.platform === "darwin" && enableTransparency ? "under-window" : undefined,
    titleBarStyle: "hidden",
    frame: process.platform === "darwin" ? undefined : false,
    backgroundColor: enableTransparency ? "#00000000" : "#ffffff",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep hidden test windows responsive so Playwright exercises the same UI flows.
      backgroundThrottling: !backgroundTestMode,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInAppNavigationUrl(url)) {
      openExternalWebUrl(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isInAppNavigationUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalWebUrl(url);
  });

  window.once("ready-to-show", () => {
    if (!backgroundTestMode) {
      window.show();
    }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    const lowerKey = input.key.toLowerCase();
    const platformModifier = process.platform === "darwin" ? input.meta : input.control;
    const terminalFocused = terminalFocusedWebContentsIds.has(window.webContents.id);
    if (terminalFocused) {
      return;
    }
    if (platformModifier && !input.shift && lowerKey === "n") {
      event.preventDefault();
      createAppWindow(viewForWebContents(window.webContents.id));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window);
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "v") {
      const clipboardImage = readClipboardImageAttachment();
      if (clipboardImage) {
        event.preventDefault();
        window.webContents.send(desktopIpc.clipboardImagePasted, clipboardImage);
        return;
      }
    }

    const command = getDesktopCommandFromShortcut({
      modifier: process.platform === "darwin" ? input.meta : input.control,
      shift: input.shift,
      key: input.key,
      code: input.code,
    });
    if (command) {
      event.preventDefault();
      window.webContents.send(desktopIpc.appCommand, command);
    }
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string);
    // DevTools 默认不打开（按需：PI_APP_OPEN_DEVTOOLS=1 时才带出调试窗口）
    if (process.env.PI_APP_OPEN_DEVTOOLS === "1") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(appRendererUrl());
  }

  return window;
}

function viewFromState(state: DesktopAppState): WindowViewState {
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
  };
}

function resolveWindowView(sourceView?: DesktopAppViewState): WindowViewState {
  return viewFromState(store.projectStateForView({ ...viewFromState(store.state), ...sourceView }, store.state));
}

function viewForWebContents(webContentsId: number): WindowViewState {
  return windowViews.get(webContentsId) ?? viewFromState(store.state);
}

function rememberWindowView(webContentsId: number, state: DesktopAppState): void {
  windowViews.set(webContentsId, viewFromState(state));
}

function applyWindowViewToStore(webContentsId: number): void {
  store.state = store.projectStateForView(viewForWebContents(webContentsId), store.state);
}

function projectStateForWindow(
  webContentsId: number,
  state: DesktopAppState = store.state,
  view: WindowViewState = viewForWebContents(webContentsId),
  previousView: WindowViewState | undefined = windowViews.get(webContentsId),
): DesktopAppState {
  const projected = store.projectStateForView(view, state, previousView);
  if (
    projected.composerDraftSyncSource === "persist" &&
    currentComposerDraftPersistOriginWebContentsId !== undefined &&
    webContentsId !== currentComposerDraftPersistOriginWebContentsId
  ) {
    return {
      ...projected,
      composerDraftSyncSource: "remote-persist",
    };
  }
  return projected;
}

function publishStateToWindow(window: BrowserWindow, state: DesktopAppState = store.state): void {
  if (!canPublishToWindow(window)) {
    return;
  }
  const webContentsId = window.webContents.id;
  const view = webContentsId === currentWindowScopedWebContentsId ? viewFromState(state) : viewForWebContents(webContentsId);
  const projected = projectStateForWindow(webContentsId, state, view);
  rememberWindowView(webContentsId, projected);
  window.webContents.send(desktopIpc.stateChanged, projected);
}

async function publishSelectedTranscriptToWindow(window: BrowserWindow): Promise<void> {
  if (!canPublishToWindow(window)) {
    return;
  }
  const webContentsId = window.webContents.id;
  const payload = await store.getSelectedTranscriptForView(viewForWebContents(webContentsId));
  if (canPublishToWindow(window)) {
    const projected = projectStateForWindow(webContentsId);
    if (payload) {
      if (projected.selectedWorkspaceId !== payload.workspaceId || projected.selectedSessionId !== payload.sessionId) {
        return;
      }
    } else if (projected.selectedSessionId) {
      return;
    }
    window.webContents.send(desktopIpc.selectedTranscriptChanged, payload);
  }
}

function setActiveWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  mainWindow = window;
  notificationManager?.trackWindow(window);
  notificationPermissionService?.trackWindow(window);
}

function windowForWebContentsId(webContentsId: number): BrowserWindow | undefined {
  return [...appWindows].find((window) => !window.isDestroyed() && window.webContents.id === webContentsId);
}

function applyWindowActivation(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  setActiveWindow(window);
  applyWindowViewToStore(webContentsId);
  store.handleWindowActivation();
  rememberWindowView(webContentsId, store.state);
}

function applyDeferredWindowActivation(): boolean {
  const webContentsId = deferredActivationWebContentsId;
  deferredActivationWebContentsId = undefined;
  if (webContentsId === undefined) {
    return false;
  }
  const window = windowForWebContentsId(webContentsId);
  if (!window || !canPublishToWindow(window)) {
    return false;
  }
  applyWindowActivation(window);
  return true;
}

function getForegroundAppWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && windowViews.has(focusedWindow.webContents.id) && canPublishToWindow(focusedWindow)) {
    return focusedWindow;
  }
  if (mainWindow && canPublishToWindow(mainWindow)) {
    return mainWindow;
  }
  return [...appWindows].find((window) => canPublishToWindow(window)) ?? null;
}

function getForegroundAppView(): DesktopAppViewState | undefined {
  const window = getForegroundAppWindow();
  return window ? viewForWebContents(window.webContents.id) : undefined;
}

function restoreStoreToView(view: DesktopAppViewState | undefined): void {
  if (!view) {
    return;
  }
  store.state = store.projectStateForView(view, store.state);
}

function restoreStoreToViewAndEmit(view: DesktopAppViewState | undefined): void {
  restoreStoreToView(view);
  store.emit();
}

function restoreStoreToForegroundUnlessSender(senderWebContentsId: number | undefined): void {
  const foregroundWindow = getForegroundAppWindow();
  if (!foregroundWindow) {
    return;
  }
  if (senderWebContentsId !== undefined && foregroundWindow.webContents.id === senderWebContentsId) {
    return;
  }
  restoreStoreToViewAndEmit(viewForWebContents(foregroundWindow.webContents.id));
}

function isSessionVisibleInAnotherWindow(sessionRef: SessionRef): boolean {
  for (const window of appWindows) {
    if (!canPublishToWindow(window) || window.isMinimized() || !window.isVisible()) {
      continue;
    }
    const webContentsId = window.webContents.id;
    if (webContentsId === currentWindowScopedWebContentsId) {
      continue;
    }
    const view = windowViews.get(webContentsId);
    if (
      view?.activeView === "threads" &&
      view.selectedWorkspaceId === sessionRef.workspaceId &&
      view.selectedSessionId === sessionRef.sessionId
    ) {
      return true;
    }
  }
  return false;
}

function enqueueWindowScopedAction<T>(action: () => Promise<T>): Promise<T> {
  const run = windowScopedActionQueue.then(action, action);
  windowScopedActionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface WindowScopedActionOptions {
  readonly forceActiveWindow?: boolean;
}

async function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: WindowScopedActionOptions = {},
): Promise<DesktopAppState> {
  return enqueueWindowScopedAction(async () => {
    const webContentsId = window && !window.isDestroyed() ? window.webContents.id : undefined;
    const foregroundWindow = getForegroundAppWindow();
    const senderIsForeground =
      Boolean(window && foregroundWindow && window.webContents.id === foregroundWindow.webContents.id);
    const windowIsFocused =
      Boolean(window && !window.isDestroyed() && window.isFocused()) ||
      senderIsForeground ||
      options.forceActiveWindow === true;
    if (window && webContentsId !== undefined) {
      if (windowIsFocused) {
        setActiveWindow(window);
      }
      applyWindowViewToStore(webContentsId);
    }

    const previousWindowScopedWebContentsId = currentWindowScopedWebContentsId;
    currentWindowScopedWebContentsId = webContentsId;
    try {
      const state = await action();
      if (!window || webContentsId === undefined) {
        return state;
      }

      const previousView = windowViews.get(webContentsId);
      const projected = projectStateForWindow(webContentsId, state, viewFromState(state), previousView);
      rememberWindowView(webContentsId, projected);
      publishStateToWindow(window, projected);
      void publishSelectedTranscriptToWindow(window);
      return projected;
    } finally {
      currentWindowScopedWebContentsId = previousWindowScopedWebContentsId;
      if (!applyDeferredWindowActivation()) {
        restoreStoreToForegroundUnlessSender(webContentsId);
      }
    }
  });
}

function runWindowScopedForEvent(
  event: IpcMainInvokeEvent,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  return runWindowScopedForWindow(BrowserWindow.fromWebContents(event.sender), action);
}

async function runUnscopedStateResultForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  const state = await action();
  if (!window || !canPublishToWindow(window)) {
    return state;
  }
  const webContentsId = window.webContents.id;
  const projected = projectStateForWindow(webContentsId, state);
  rememberWindowView(webContentsId, projected);
  return projected;
}

async function runImmediateStateResultForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
): Promise<DesktopAppState> {
  const state = await action();
  if (!window || !canPublishToWindow(window)) {
    return state;
  }

  const webContentsId = window.webContents.id;
  const projected = projectStateForWindow(webContentsId, state);
  rememberWindowView(webContentsId, projected);
  window.webContents.send(desktopIpc.stateChanged, projected);
  void publishSelectedTranscriptToWindow(window);
  return projected;
}

async function runWindowScopedStateResult<T extends { readonly state: DesktopAppState }>(
  window: BrowserWindow | null | undefined,
  action: () => Promise<T>,
  options: WindowScopedActionOptions = {},
): Promise<T> {
  return enqueueWindowScopedAction(async () => {
    const webContentsId = window && !window.isDestroyed() ? window.webContents.id : undefined;
    const foregroundWindow = getForegroundAppWindow();
    const senderIsForeground =
      Boolean(window && foregroundWindow && window.webContents.id === foregroundWindow.webContents.id);
    const windowIsFocused =
      Boolean(window && !window.isDestroyed() && window.isFocused()) ||
      senderIsForeground ||
      options.forceActiveWindow === true;
    if (window && webContentsId !== undefined) {
      if (windowIsFocused) {
        setActiveWindow(window);
      }
      applyWindowViewToStore(webContentsId);
    }

    const previousWindowScopedWebContentsId = currentWindowScopedWebContentsId;
    currentWindowScopedWebContentsId = webContentsId;
    try {
      const result = await action();
      if (!window || webContentsId === undefined) {
        return result;
      }

      const previousView = windowViews.get(webContentsId);
      const projected = projectStateForWindow(webContentsId, result.state, viewFromState(result.state), previousView);
      rememberWindowView(webContentsId, projected);
      publishStateToWindow(window, projected);
      void publishSelectedTranscriptToWindow(window);
      return { ...result, state: projected };
    } finally {
      currentWindowScopedWebContentsId = previousWindowScopedWebContentsId;
      if (!applyDeferredWindowActivation()) {
        restoreStoreToForegroundUnlessSender(webContentsId);
      }
    }
  });
}

function createAppWindow(sourceView?: DesktopAppViewState): BrowserWindow {
  const window = createWindow();
  const webContentsId = window.webContents.id;
  appWindows.add(window);
  windowViews.set(webContentsId, resolveWindowView(sourceView));
  setActiveWindow(window);
  themeManager.trackWindow(window);
  attachStatePublisher(window);
  attachViewedSessionTracking(window);

  window.once("closed", () => {
    appWindows.delete(window);
    windowViews.delete(webContentsId);
    terminalFocusedWebContentsIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store.cancelPendingDialogsWithoutVisibleWindow((sessionRef) => isSessionVisibleInAnotherWindow(sessionRef));
    if (mainWindow === window) {
      mainWindow = [...appWindows].find((candidate) => !candidate.isDestroyed()) ?? null;
      if (mainWindow) {
        setActiveWindow(mainWindow);
        applyWindowViewToStore(mainWindow.webContents.id);
      }
    }
    if (appWindows.size === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

function attachStatePublisher(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  const startPublishing = () => {
    stopPublishingStateByWebContentsId.get(webContentsId)?.();
    stopPublishingSelectedTranscriptByWebContentsId.get(webContentsId)?.();
    const stopPublishingState = store.subscribe((state) => {
      publishStateToWindow(window, state);
      void publishSelectedTranscriptToWindow(window);
    });
    const stopPublishingSelectedTranscript = store.subscribeToSelectedTranscript(() => {
      void publishSelectedTranscriptToWindow(window);
    });
    stopPublishingStateByWebContentsId.set(webContentsId, stopPublishingState);
    stopPublishingSelectedTranscriptByWebContentsId.set(webContentsId, stopPublishingSelectedTranscript);
  };
  const stopPublishing = () => {
    stopPublishingStateByWebContentsId.get(webContentsId)?.();
    stopPublishingStateByWebContentsId.delete(webContentsId);
    stopPublishingSelectedTranscriptByWebContentsId.get(webContentsId)?.();
    stopPublishingSelectedTranscriptByWebContentsId.delete(webContentsId);
  };

  startPublishing();

  // A renderer crash detaches the (now-dead) subscriptions, but View > Reload
  // brings the same webContents back — re-subscribe on recovery so the reloaded
  // window resumes live state pushes instead of going permanently stale.
  let recovering = false;
  window.webContents.on("render-process-gone", () => {
    recovering = true;
    stopPublishing();
  });
  window.webContents.on("did-finish-load", () => {
    if (!recovering) {
      return;
    }
    recovering = false;
    startPublishing();
    // Push the current state immediately so the reloaded UI is fresh.
    publishStateToWindow(window);
    void publishSelectedTranscriptToWindow(window);
  });
  window.once("closed", stopPublishing);
}

function attachViewedSessionTracking(window: BrowserWindow): void {
  const webContentsId = window.webContents.id;
  stopTrackingWindowActivationByWebContentsId.get(webContentsId)?.();

  const handleActivation = () => {
    if (currentWindowScopedWebContentsId !== undefined) {
      deferredActivationWebContentsId = webContentsId;
      return;
    }
    applyWindowActivation(window);
  };
  const clearTracking = () => {
    stopTrackingWindowActivationByWebContentsId.get(webContentsId)?.();
    stopTrackingWindowActivationByWebContentsId.delete(webContentsId);
  };

  window.on("focus", handleActivation);
  window.on("show", handleActivation);
  window.on("restore", handleActivation);
  window.once("closed", clearTracking);

  stopTrackingWindowActivationByWebContentsId.set(webContentsId, () => {
    window.off("focus", handleActivation);
    window.off("show", handleActivation);
    window.off("restore", handleActivation);
    window.off("closed", clearTracking);
  });
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed();
}

function resolveAppTestMode(value: string | undefined): "foreground" | "background" | undefined {
  return value === "foreground" || value === "background" ? value : undefined;
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  if (parentWindow && canPublishToWindow(parentWindow)) {
    return parentWindow;
  }
  if (mainWindow && canPublishToWindow(mainWindow)) {
    return mainWindow;
  }
  return undefined;
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  if (window && canPublishToWindow(window)) {
    return store.getStateForView(viewForWebContents(window.webContents.id));
  }
  return store.getState();
}

async function pickWorkspacePathViaDialog(parentWindow?: BrowserWindow | null): Promise<string | undefined> {
  const window = resolveDialogWindow(parentWindow);
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "Open workspace folder",
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Open workspace folder",
      });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return result.filePaths[0] as string;
}

async function addPickedWorkspace(window: BrowserWindow | null | undefined, workspacePath: string): Promise<DesktopAppState> {
  const nextState = await store.addWorkspace(workspacePath);
  if (!nextState.selectedWorkspaceId) {
    return nextState;
  }
  const newThreadState =
    nextState.activeView === "new-thread" ? nextState : await store.setActiveView("new-thread");
  if (window) {
    window.webContents.send(desktopIpc.workspacePicked, nextState.selectedWorkspaceId);
  }
  return newThreadState;
}

async function pickWorkspaceViaDialog(parentWindow?: BrowserWindow | null): Promise<DesktopAppState> {
  const window = resolveDialogWindow(parentWindow);
  const workspacePath = await pickWorkspacePathViaDialog(window);
  if (!workspacePath) {
    return stateForWindow(window);
  }
  return runWindowScopedForWindow(window, () => addPickedWorkspace(window, workspacePath));
}

async function runManualUpdateCheck(): Promise<void> {
  const window = mainWindow && canPublishToWindow(mainWindow) ? mainWindow : undefined;
  const showDialog = async (options: {
    message: string;
    detail?: string;
    buttons?: string[];
    type?: "info" | "warning" | "error";
    title?: string;
    defaultId?: number;
    cancelId?: number;
  }): Promise<{ response: number }> => {
    const buttons = options.buttons ?? ["OK"];
    const isConfirm = buttons.length > 1;
    const r = await showAppDialog(window, {
      kind: isConfirm ? "confirm" : "alert",
      message: options.message,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(isConfirm ? { confirmText: buttons[0], cancelText: buttons[1] ?? "取消" } : {}),
    });
    // 取消/失败 → 视为选择了非默认项（与原生 cancelId 语义一致）
    return { response: r?.ok ? 0 : 1 };
  };

  try {
    const result = await checkForUpdate();

    if (result.status === "update-available") {
      // The manual menu path always confirms with a dialog — a notification may
      // be silently suppressed if the OS permission is denied.
      const choice = await showDialog({
        type: "info",
        title: "pi-gui",
        message: `Version ${result.latestVersion} is available.`,
        detail: `You have ${result.currentVersion}.`,
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        await openReleasesPage(result.releaseUrl);
      }
      return;
    }

    if (result.status === "up-to-date") {
      await showDialog({
        type: "info",
        title: "pi-gui",
        message: `You're up to date on version ${result.currentVersion}.`,
        buttons: ["OK"],
      });
      return;
    }

    await showDialog({
      type: "warning",
      title: "pi-gui",
      message: "Could not check for updates right now.",
      detail: result.message,
      buttons: ["OK"],
    });
  } catch (error) {
    console.error("pi-gui: manual update check failed:", error);
    await showDialog({
      type: "warning",
      title: "pi-gui",
      message: "Could not check for updates right now.",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["OK"],
    }).catch(() => undefined);
  }
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          id: CHECK_FOR_UPDATES_MENU_ITEM_ID,
          label: "Check for Updates…",
          click: () => {
            void runManualUpdateCheck();
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          id: NEW_WINDOW_MENU_ITEM_ID,
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click: () => {
            createAppWindow(getForegroundAppView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: "Open Folder…",
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Ensure npm (and other Homebrew/npm-global binaries) are available even when
// pi-gui is launched via Finder/Dock (which hands the process a minimal PATH).
// POSIX-only; on Windows the PATH is left untouched (see augmentPosixPath).
const augmentedPath = augmentPosixPath();
if (augmentedPath.changed) {
  process.env.PATH = augmentedPath.path;
}

// Windows GPU 进程在某些驱动下会崩溃（exit_code=143）。禁用 GPU 硬件加速，
// 回退到软件渲染，代价是轻微的动画/滚动性能损失，但保证窗口能稳定显示。
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.disableHardwareAcceleration();

app.setName("pi");

const configuredUserDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
app.setPath("userData", configuredUserDataDir);
// 权威 userData 路径注入 wiki-config，工具门控/卡片配置等同步读取点
// 与设置页 IPC 读写同一份文件（安全审核 F-09：此前两套路径在生产构建中分叉）
setActiveWikiUserDataDir(configuredUserDataDir);
// 默认 workspace 路径（userData/Workbench）。
// 不自动创建——首次启动由引导页创建；已初始化则直接用。
const defaultWorkspacePath = path.join(configuredUserDataDir, "Workbench");
const alreadyInitialized = existsSync(path.join(defaultWorkspacePath, ".workbench-initialized"));
if (alreadyInitialized) {
  // 已初始化：确保目录存在（防御性），同步提示词
  initWorkspaceDir(defaultWorkspacePath);
  const businessPrompt = readBusinessPrompt(configuredUserDataDir);
  syncPromptToWorkspace(defaultWorkspacePath, businessPrompt);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  const window = getForegroundAppWindow();
  if (!window) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
});

// ── 全局崩溃日志：任何未捕获异常把堆栈写进 userData/crash.log（便于定位"无堆栈闪退"） ──
function appendCrashLog(kind: string, error: unknown): void {
  try {
    const stack = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    const line = `\n[${new Date().toISOString()}] ${kind}\n${stack}\n`;
    appendFileSync(path.join(app.getPath("userData"), "crash.log"), line, "utf-8");
  } catch { /* 日志本身失败则忽略 */ }
}
process.on("uncaughtException", (error) => {
  appendCrashLog("uncaughtException", error);
  // 保持默认行为（退出），但留下证据
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  appendCrashLog("unhandledRejection", reason);
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  // On macOS, packaged builds already render the dock icon from `icon.icns`
  // in the app bundle. In dev we override the generic Electron dock icon with
  // the real PNG so the running app looks right end-to-end.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(appIcon);
  }

  let generateThreadTitleOverride:
    | ((workspace: WorkspaceRef, options: GenerateThreadTitleOptions) => Promise<string | null | undefined>)
    | undefined;
  let deferredThreadTitle:
    | {
        resolve: (title: string | null) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const orchestrationRuntimeBridge = createStoreBackedOrchestrationRuntimeBridge();
  // MCP 扩展（异步初始化，读取 ~/.pi/agent/mcp-servers.json + 启动子进程）
  const mcpAgentDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent");
  // F-29/MCP-1 信任链：配置 hash 与上次 UI 保存的基准不一致 = 应用外被修改
  // （外部编辑/Agent 文件工具写入）。fail-closed：本次会话不加载 MCP 扩展，
  // 用户到 设置→MCP 检查保存（重新确认+记录新基准）后恢复。
  const mcpTampered = (() => {
    const current = mcpConfigSha256(mcpAgentDir);
    if (!current) return false; // 无配置文件 → 无可执行内容
    const stored = readStoredMcpHash();
    if (!stored) {
      recordMcpHash(mcpAgentDir); // 首次见到该文件（TOFU）：记录基准
      return false;
    }
    return current !== stored;
  })();
  if (mcpTampered) {
    console.warn("[mcp] mcp-servers.json 在应用外被修改，本次会话停用 MCP 扩展（fail-closed）");
    try {
      new Notification({
        title: "Workecho：MCP 扩展已停用",
        body: "检测到 MCP 配置在应用外被修改。请到 设置 → MCP 扩展 检查后保存以恢复。",
      }).show();
    } catch { /* 通知不可用忽略 */ }
  }
  const mcpExtension = await (mcpTampered ? Promise.resolve(null) : createMcpExtension(mcpAgentDir)).catch(() => null);
  registerAppDialogResultIpc();
  // 注意：costrictDir 必须在下方自愈 IIFE 之前声明（曾因 TDZ 报 Cannot access before initialization）
  const costrictDir = path.join(configuredUserDataDir, "costrict");
  // 安全审核 CS-3：apiKey 用系统凭据保护（Win DPAPI / Mac Keychain）加密落盘。
  // 不可用时回退明文（保持功能可用）；存量明文 key 在此立即迁移为加密形态。
  if (safeStorage.isEncryptionAvailable()) {
    setCostrictSecretCodec({
      encode: (plain) => safeStorage.encryptString(plain).toString("base64"),
      decode: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
    });
    try {
      const rawState = JSON.parse(readFileSync(path.join(costrictDir, "state.json"), "utf-8"));
      if (typeof rawState.apiKey === "string") costrictWriteState(costrictDir, {}); // 明文 → 加密
    } catch { /* 无 state.json 或解析失败：无需迁移 */ }
  }

  // CoStrict 服务自愈：已接入（key 已存）但本地代理未运行时，启动时自动拉起。
  // 否则应用/系统重启后 127.0.0.1:14567 不在，所有 costrict 模型请求静默失败。
  void (async () => {
    try {
      installBundledBinary({ resourcesDir: path.join(app.getAppPath(), "resources"), dir: costrictDir });
      const st = await costrictStatus({ dir: costrictDir });
      if (st.binaryPresent && st.apiKeySaved && !st.serviceRunning) {
        const r = await costrictStart({ dir: costrictDir, binPath: managedBinaryPath(costrictDir) });
        console.log(`[costrict] 启动自愈: healthy=${r.healthy}`);
      }
    } catch (e) {
      console.warn("[costrict] 启动自愈失败:", (e as Error).message);
    }
  })();

  // Hook 桌面通知（策略层解耦：不直接依赖 electron，见 tool-pipeline.ts）
  setHookNotifier((title, body) => {
    try { new Notification({ title, body }).show(); } catch { /* 通知失败忽略 */ }
  });
  // 危险操作确认（P2 补全）：应用内弹窗，拒绝则否决工具执行
  setDangerousOpConfirmer(async (title, body) => {
    const r = await showAppDialog(mainWindow, { kind: "confirm", message: title, detail: body, danger: true });
    return r?.ok === true;
  });
  const driverOptions = {
    extensionFactories: [
      createOrchestrationRuntimeExtension(orchestrationRuntimeBridge),
      createBusinessRuntimeExtension(),
      createMemoryInjectionExtension(), // P4：会话启动自动注入 memory
      createPolicyExtension(), // A2 工具执行管道（审计+安全拦截）
      ...(mcpExtension ? [mcpExtension] : []),
    ],
    inlineExtensionMetadata: [
      {
        displayName: "Thread orchestration",
        description: "Start child pi-gui threads from transcript tool calls",
      },
    ],
  };
  store = new DesktopAppStore({
    userDataDir: configuredUserDataDir,
    initialWorkspacePaths: resolveInitialWorkspacePaths(),
    getWindow: () => mainWindow,
    shouldKeepSessionDialogs: (sessionRef) => isSessionVisibleInAnotherWindow(sessionRef),
    driverOptions,
    generateThreadTitleOverride: async (workspace, options) => generateThreadTitleOverride?.(workspace, options),
  });
  await store.initialize();
  themeManager.setMode(store.state.themeMode);
  // 工具进度广播：把主进程工具进度推给所有窗口
  setProgressWindowsProvider(() => BrowserWindow.getAllWindows());
  // 启动定时提醒调度器（每日检查维保到期 + 逾期待办，推送桌面通知）
  reminderScheduler = new ReminderScheduler(() => {
    const st = store.state;
    const ws = st?.workspaces?.find((w) => w.id === st.selectedWorkspaceId);
    return ws?.path ?? defaultWorkspacePath;
  });
  reminderScheduler.start();
  // 待办提醒服务（提前10分钟提醒，5分钟检查一次）
  todoReminder = new TodoReminderService(() => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    return ws?.path ?? defaultWorkspacePath;
  }, configuredUserDataDir);
  todoReminder.start();

  // 首次启动文档扫描：只在已引导过（sentinel 存在）时自动补扫。
  // 全新用户走 OnboardingView 交互式引导，不在这里自动扫。
  // runInitScan 内部有 sentinel 检查，已扫过会直接跳过。
  // （引导页的 onboarding:scan / onboarding:finish 会写 sentinel）
  integratedTerminalShell = (await store.getState()).integratedTerminalShell;
  stopPruningTerminals = store.subscribe((state) => {
    integratedTerminalShell = state.integratedTerminalShell;
    const workspacePaths = state.workspaces.map((workspace) => workspace.path);
    const workspacePathSignature = workspacePaths.join("\0");
    if (workspacePathSignature !== retainedTerminalWorkspacePathSignature) {
      retainedTerminalWorkspacePathSignature = workspacePathSignature;
      terminalService?.retainWorkspacePaths(workspacePaths);
    }
  });
  installApplicationMenu();
  if (process.env.PI_APP_TEST_MODE) {
    Object.assign(globalThis, {
      __PI_APP_TEST_HOOKS: {
        emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
        handleWindowActivation: () => {
          if (mainWindow) {
            applyWindowActivation(mainWindow);
          }
        },
        promptForText: (message: string, placeholder?: string, allowEmpty?: boolean) =>
          promptForText(mainWindow, message, placeholder ?? "", allowEmpty ?? false),
        runOrchestrationRuntimeTool: (input: OrchestrationRuntimeToolTestInput) =>
          runOrchestrationRuntimeToolForTest(orchestrationRuntimeBridge, input),
        setDeferredThreadTitleMode: () => {
          generateThreadTitleOverride = () =>
            new Promise<string | null>((resolve, reject) => {
              deferredThreadTitle = { resolve, reject };
            });
        },
        hasDeferredThreadTitle: () => Boolean(deferredThreadTitle),
        resolveDeferredThreadTitle: (title: string) => {
          if (!deferredThreadTitle) {
            throw new Error("Deferred thread-title request is unavailable");
          }
          const pending = deferredThreadTitle;
          deferredThreadTitle = undefined;
          pending.resolve(title);
        },
        rejectDeferredThreadTitle: () => {
          if (!deferredThreadTitle) {
            throw new Error("Deferred thread-title request is unavailable");
          }
          const pending = deferredThreadTitle;
          deferredThreadTitle = undefined;
          pending.reject(new Error("Deferred thread-title rejected by test"));
        },
      },
    });
  }
  notificationPermissionService = new NotificationPermissionService(() => mainWindow);
  notificationPermissionService.subscribe((status) => {
    for (const window of appWindows) {
      if (canPublishToWindow(window)) {
        window.webContents.send(desktopIpc.notificationPermissionStatusChanged, status);
      }
    }
  });
  notificationManager = new NotificationManager(
    store,
    () => mainWindow,
    notificationPermissionService,
    async (sessionRef) => {
      const window = getForegroundAppWindow();
      await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), { forceActiveWindow: true });
    },
  );
  stopNotifications = notificationManager.start();
  if (!isDev) {
    stopUpdateChecker = initUpdateChecker();
  }

  ipcMain.handle(desktopIpc.ping, () =>
    devReloadMarkersEnabled ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}` : "pi desktop ready",
  );
  ipcMain.handle(desktopIpc.getThemeMode, () => themeManager.getMode());
  ipcMain.handle(desktopIpc.getResolvedTheme, () => themeManager.getResolvedTheme());
  ipcMain.handle(desktopIpc.setThemeMode, (event, mode: ThemeMode) => {
    themeManager.setMode(mode);
    return runWindowScopedForEvent(event, () => store.setThemeMode(mode));
  });
  ipcMain.handle(desktopIpc.setThemePresetId, (event, presetId: ThemePresetId) =>
    runWindowScopedForEvent(event, () => store.setThemePresetId(presetId)),
  );
  ipcMain.handle(desktopIpc.openExternal, (_event, url: string) => {
    const parsed = parseExternalWebUrl(url);
    if (!parsed) {
      throw new Error(`Refusing to open unsupported URL: ${url}`);
    }
    return shell.openExternal(parsed.toString());
  });
  // 业务数据汇总：给右侧状态面板用。从当前 workspace 的 workbench/ 目录读。
  ipcMain.handle("workbench:get-summary", async (event) => {
    const st = store.state;
    if (!st || !st.workspaces) return null;
    let ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    // 如果选中的 workspace 路径下没有 workbench/ 目录，回退到默认 workspace
    if (ws && !existsSync(path.join(ws.path, "workbench"))) {
      ws = st.workspaces.find((w) => w.path === defaultWorkspacePath) ?? st.workspaces[0];
    }
    if (!ws) return null;
    const summary = getBusinessSummary(ws.path);
    return summary;
  });
  // 业务提示词：读取 / 保存
  ipcMain.handle("workbench:get-prompt", () => readBusinessPrompt(configuredUserDataDir));
  ipcMain.handle("workbench:save-prompt", (_event, content: string) => {
    writeBusinessPrompt(configuredUserDataDir, content);
    // 同步到当前 workspace 的 AGENTS.md
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (ws) syncPromptToWorkspace(ws.path, content);
    return content;
  });
  // 默认工作目录路径（给引导页显示）
  ipcMain.handle("workbench:get-default-path", () => defaultWorkspacePath);
  // 首次启动检测：workspace 已初始化（.workbench-initialized 存在）则不弹引导
  ipcMain.handle("workbench:needs-onboarding", () => {
    return !existsSync(path.join(defaultWorkspacePath, ".workbench-initialized"));
  });
  // 首次启动引导：选择工作目录（弹原生文件夹选择器）
  ipcMain.handle("onboarding:pick-workspace", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "选择 Workbench 工作目录",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  // 确认工作目录：把选定目录注册为 workspace + 初始化 workbench 结构
  ipcMain.handle("onboarding:confirm-workspace", async (_event, workspacePath: string) => {
    initWorkspaceDir(workspacePath);  // 确保 workbench 子目录存在（幂等）
    const prompt = readBusinessPrompt(configuredUserDataDir);
    syncPromptToWorkspace(workspacePath, prompt);
    // 把这个 workspace 注册到 store（如果还没有）—— 防护 store 未就绪
    try {
      await store.initialize();
      const st = store.state;
      if (st?.workspaces && !st.workspaces.some((w) => w.path === workspacePath)) {
        await store.addWorkspace(workspacePath);
      }
    } catch (e) {
      console.warn("[onboarding] 注册 workspace 失败（store 可能未就绪）:", (e as Error).message);
    }
    return workspacePath;
  });
  // 首次启动引导：执行全 PC 扫描
  ipcMain.handle("onboarding:scan", async () => {
    // 扫描导入目标：当前选中的工作区（而不是写死的默认 Workbench——
    // 用户切换工作区后扫进默认库，会导致"导入完成但界面看不到"）
    const wsPath = store.state.workspaces.find((w) => w.id === store.state.selectedWorkspaceId)?.path ?? defaultWorkspacePath;
    const dirs = getCommonDocDirs();
    const allFiles: string[] = [];
    for (const d of dirs) { allFiles.push(...scanDocs(d, 5)); }
    const result = await importFiles(wsPath, allFiles);
    return result;
  });
  // 扩展能力：读取 MCP/命令/插件配置 + 打开对应目录
  ipcMain.handle("workbench:get-extensions-config", async () => {
    const agentDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent");
    const wsDir = store.state.workspaces.find((w) => w.id === store.state.selectedWorkspaceId)?.path ?? defaultWorkspacePath;
    const promptsDir = path.join(agentDir, "prompts");
    const extensionsDir = path.join(wsDir, ".pi", "extensions");
    const mcpConfigPath = path.join(agentDir, "mcp-servers.json");

    // MCP servers
    let mcpServers: Record<string, any> = {};
    try {
      if (existsSync(mcpConfigPath)) {
        const raw = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        mcpServers = raw.servers ?? raw;
      }
    } catch {}

    // 自定义命令
    const commands: string[] = [];
    try {
      if (existsSync(promptsDir)) {
        for (const f of readdirSync(promptsDir)) {
          if (f.endsWith(".md")) commands.push(f.replace(/\.md$/, ""));
        }
      }
    } catch {}

    // 插件
    const extensions: string[] = [];
    try {
      if (existsSync(extensionsDir)) {
        for (const f of readdirSync(extensionsDir)) {
          if (f.endsWith(".ts") || f.endsWith(".js")) extensions.push(f);
        }
      }
    } catch {}

    return { mcpServers, commands, extensions, paths: { agentDir, promptsDir, extensionsDir, mcpConfigPath } };
  });

  // 保存 MCP server 配置
  ipcMain.handle("workbench:save-mcp-config", async (_event, servers: Record<string, any>) => {
    const agentDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent");
    // F-29：MCP 配置 = 可执行命令清单。保存前展示新增/变更的启动项，确认才落盘
    const changes = summarizeMcpChanges(readCurrentMcpServers(agentDir), servers);
    if (changes.length > 0) {
      const r = await showAppDialog(mainWindow, {
        kind: "confirm",
        danger: true,
        message: "确认保存 MCP 服务器配置？",
        detail: "保存后 Agent 运行时将可启动以下进程：\n\n" + changes.join("\n"),
        confirmText: "保存",
        cancelText: "取消",
      });
      if (!r?.ok) return false;
    }
    writeFileSync(mcpConfigPath(agentDir), JSON.stringify({ servers }, null, 2), "utf-8");
    recordMcpHash(agentDir);
    // P1-a 热加载：MCP 变更后刷新运行时
    try {
      const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
      if (ws) await store.driver.runtimeSupervisor.refreshRuntime(ws);
    } catch { /* ignore */ }
    return true;
  });

  /* ============ CoStrict 一键接入（托管 costrict-router，入口=loginProvider("costrict")） ============ */
  const costrictEvent = (step: string, message: string) => {
    try { mainWindow?.webContents.send("workbench:costrict-event", { step, message }); } catch { /* 窗口未就绪忽略 */ }
  };

  ipcMain.handle("workbench:costrict-status", async () => {
    // 内置二进制随应用分发：查询状态时顺带完成首次安装（零网络）
    installBundledBinary({ resourcesDir: path.join(app.getAppPath(), "resources"), dir: costrictDir });
    const status = await costrictStatus({ dir: costrictDir });
    let providerRegistered = false;
    try {
      const customs = await store.driver.runtimeSupervisor.listCustomProviders();
      providerRegistered = customs.some((c: any) => c.providerId === COSTRICT_PROVIDER_ID);
    } catch { /* ignore */ }
    return { ...status, providerRegistered };
  });

  /** 一键登录：地址（记忆>询问）→ 二进制 → 浏览器 SSO → 启动捕获 key → 注册 provider */
  async function costrictOneClickLogin(opts: {
    baseUrl?: string;
    callbacks?: {
      onAuth: (info: { url: string; instructions?: string }) => Promise<void> | void;
      onPrompt: (p: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
      onProgress?: (m: string) => Promise<void> | void;
    };
  }): Promise<{ ok: boolean; error?: string }> {
    const binPath = managedBinaryPath(costrictDir);
    try {
      // 1. CoStrict 服务地址：显式传入 > 上次记忆 > 对话框询问（只问一次）
      let baseUrl = opts.baseUrl?.trim().replace(/\/$/, "");
      if (!baseUrl) baseUrl = costrictReadState(costrictDir).upstreamBaseUrl?.trim().replace(/\/$/, "");
      if (!baseUrl) {
        // 应用内弹窗预填默认地址：不输入直接确认 = 用默认
        const r = await showAppDialog(mainWindow, {
          kind: "prompt",
          message: "请输入 CoStrict 服务地址（企业内网地址，只需填写一次）",
          placeholder: COSTRICT_DEFAULT_URL,
          defaultValue: COSTRICT_DEFAULT_URL,
        });
        if (r === null || !r.ok) return { ok: false, error: "已取消登录" };
        baseUrl = ((r.value ?? "").trim().replace(/\/$/, "")) || COSTRICT_DEFAULT_URL;
      }
      if (!baseUrl || !/^https?:\/\/.+/.test(baseUrl)) return { ok: false, error: "需要有效的 CoStrict 服务地址（https://…）" };

      // 2. 确保二进制：优先应用内置（零网络依赖），未内置平台才下载
      const status = await costrictStatus({ dir: costrictDir });
      if (!status.binaryPresent) {
        const installed = installBundledBinary({ resourcesDir: path.join(app.getAppPath(), "resources"), dir: costrictDir });
        if (!installed) {
          await opts.callbacks?.onProgress?.("首次使用：正在下载 costrict-router...");
          const dl = await downloadBinary({ dir: costrictDir, fetchImpl: net.fetch as typeof fetch, log: (m) => costrictEvent("download", m) });
          if (!dl.ok) return { ok: false, error: `下载失败: ${dl.error}` };
        }
      }

      // 3. 登录（onAuth 打开浏览器并提示；等待 SSO 完成）
      const login = await costrictLogin({
        binPath, baseUrl,
        onLoginUrl: (url) => {
          void opts.callbacks?.onAuth?.({ url, instructions: "请在浏览器中完成 CoStrict 企业登录，完成后会自动继续。" });
        },
      });
      if (!login.ok) return { ok: false, error: `登录未完成: ${login.output.slice(-160)}` };
      costrictWriteState(costrictDir, { upstreamBaseUrl: baseUrl });

      // 4. 启动本地代理 + 捕获一次性 key
      await opts.callbacks?.onProgress?.("启动本地代理服务...");
      const started = await costrictStart({ dir: costrictDir, binPath });
      const apiKey = started.apiKey ?? costrictReadState(costrictDir).apiKey;
      if (!apiKey) return { ok: false, error: "服务已启动，但未能捕获本地 API Key（仅显示一次），请重试" };
      if (!started.healthy) return { ok: false, error: "本地代理服务未就绪，请稍后重试" };

      // 5. 注册 provider + 热刷新
      await opts.callbacks?.onProgress?.("注册 CoStrict 模型...");
      const registered = await registerCostrictProvider(apiKey);
      if (!registered) return { ok: false, error: "已登录并启动，但获取模型列表失败（服务端模型为空？）" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 把本地代理注册为 pi 自定义 Provider 并刷新运行时 */
  async function registerCostrictProvider(apiKey: string): Promise<boolean> {
    try {
      // 注意：本地回环请求用 Node 原生 fetch——net.fetch 走 Chromium 网络栈，
      // 会受系统代理规则影响请求 127.0.0.1（实测 ERR），GitHub 下载才需要 net.fetch
      const models = await fetchCostrictModels({ apiKey });
      if (models.length === 0) return false;
      const input: CustomProviderInput = {
        providerId: COSTRICT_PROVIDER_ID,
        baseUrl: COSTRICT_LOCAL_URL,
        apiKey,
        models,
      };
      const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
      if (ws) await store.driver.runtimeSupervisor.setCustomProvider(ws, input);
      if (ws) await store.driver.runtimeSupervisor.refreshRuntime(ws);
      return true;
    } catch (e) {
      console.warn("[costrict] 注册 provider 失败:", (e as Error).message);
      return false;
    }
  }

  /** 断开：停服务 + 清 key + 注销 provider */
  async function costrictDisconnect(): Promise<void> {
    try { await costrictStop(managedBinaryPath(costrictDir)); } catch { /* 服务可能未运行 */ }
    costrictWriteState(costrictDir, { apiKey: undefined });
    try {
      const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
      if (ws) await store.driver.runtimeSupervisor.deleteCustomProvider(ws, COSTRICT_PROVIDER_ID);
      if (ws) await store.driver.runtimeSupervisor.refreshRuntime(ws);
    } catch { /* ignore */ }
  }

  // 打开目录（系统文件管理器）。只接受真实存在的目录：
  // shell.openPath 对文件按系统默认方式打开（Windows 下 .exe/.bat 即执行），
  // 被入侵的渲染层可借任意路径直达执行（安全审核 F-28）
  ipcMain.handle("workbench:open-dir", async (_event, dirPath: string) => {
    try {
      const st = statSync(dirPath);
      if (!st.isDirectory()) return { ok: false, reason: "仅支持打开目录" };
      await shell.openPath(dirPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  });

  // 上下文用量（token 估算）
  ipcMain.handle("workbench:get-context-usage", async () => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (!ws) { console.log("[ctx-usage] no workspace"); return null; }
      const session = ws.sessions.find((s) => s.id === st.selectedSessionId);
      if (!session) { console.log("[ctx-usage] no session"); return null; }
      // 直接从 transcript 估算（不用 getSelectedTranscriptForView，避免 view 参数问题）
      // 用 renderer 已有的 transcript data 更可靠，但 main 端需要自己读
      // 改为从 store 的 transcript snapshot 取
      const transcript: any = (store as any).getSelectedTranscriptForView
        ? await (store as any).getSelectedTranscriptForView({ workspaceId: ws.id, sessionId: session.id })
        : null;
      const messages = transcript?.transcript ?? [];
      const totalChars = messages.reduce((sum: number, m: any) => {
        if (m.kind === "message") return sum + (m.text?.length ?? 0);
        if (m.kind === "tool") return sum + JSON.stringify(m.input ?? "").length + JSON.stringify(m.output ?? "").length;
        return sum;
      }, 0);
      const estimatedTokens = Math.max(1, Math.ceil(totalChars / 4));
      const runtime = st.runtimeByWorkspace[ws.id];
      const model = runtime?.models?.find((m: any) => m.available);
      const contextWindow = (model as any)?.contextWindow ?? 128000;
      const percent = Math.round((estimatedTokens / contextWindow) * 100);
      return { tokens: estimatedTokens, contextWindow, percent };
    } catch (e) { console.warn("[ctx-usage] error:", (e as Error).message); return null; }
  });

  // 工具开关：获取已注册工具列表
  ipcMain.handle("workbench:get-session-tools", async () => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (!ws?.id) return { all: [], active: [] };
      const runtime = st.runtimeByWorkspace[ws.id];
      // tools 是 string[]（工具名），从 extensions 里收集
      const all = (runtime?.extensions ?? []).flatMap((ext: any) => ext.tools ?? []);
      // 去重
      const unique = [...new Set(all)];
      return { all: unique, active: unique };
    } catch { return { all: [], active: [] }; }
  });

  // schema 版本检查
  ipcMain.handle("workbench:get-schema-info", async () => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (!ws?.id) return null;
      const session = ws.sessions.find((s) => s.id === st.selectedSessionId);
      if (!session) return null;
      return (session as any).schemaInfo ?? null;
    } catch { return null; }
  });

  // 检查更新
  ipcMain.handle("workbench:check-update", async () => {
    try {
      return await checkForUpdate();
    } catch (e) {
      return { status: "error", message: (e as Error).message };
    }
  });
  ipcMain.handle("workbench:open-releases", async (_event, url?: string) => {
    await openReleasesPage(url);
  });

  // 卡片配置：读取 / 保存
  ipcMain.handle("workbench:get-cards", () => readCardConfig(configuredUserDataDir));
  ipcMain.handle("workbench:save-cards", (_event, cards: CardConfig[]) => {
    saveCardConfig(configuredUserDataDir, cards);
    return cards;
  });
  // 卡片数据：按配置动态查询
  ipcMain.handle("workbench:get-card-data", async () => {
    const st = store.state;
    let ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (ws && !existsSync(path.join(ws.path, "workbench"))) {
      ws = st.workspaces.find((w) => w.path === defaultWorkspacePath) ?? st.workspaces[0];
    }
    if (!ws) return {};
    const cards = readCardConfig(configuredUserDataDir);
    const data = getCardData(ws.path, cards);
    return data;
  });

  // Phase 5: Wiki 统计（知识库概览卡片用）
  ipcMain.handle("workbench:wiki-stats", async () => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return null;
    return getWikiStats(ws.path);
  });

  // Phase 5: Wiki 知识图谱数据（graph view 用）
  // 知识库浏览页：页面列表 + 正文读取
  ipcMain.handle("workbench:wiki-pages", async () => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return [];
    return listWikiPages(ws.path);
  });
  ipcMain.handle("workbench:wiki-read-page", (_event, relPath: string) => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return null;
    return readWikiPage(ws.path, relPath);
  });

  ipcMain.handle("workbench:wiki-graph", async () => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return { nodes: [], edges: [] };
    return getWikiGraph(ws.path);
  });

  // Phase 5: Wiki 全文搜索（搜索 UI 用）
  ipcMain.handle("workbench:wiki-search", async (_event, query: string, limit?: number) => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return [];
    return searchWiki(ws.path, query, { limit: limit ?? 20 });
  });

  // 彻底删除会话（删 jsonl 文件 + 从 catalog 移除）
  ipcMain.handle("workbench:delete-session-forever", async (_event, workspaceId: string, sessionId: string) => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return null;
      // 先归档（从运行时移除 + catalog 移除）
      await store.archiveSession({ workspaceId, sessionId } as any);
      // 在 pi sessions 目录里找包含 sessionId 的 jsonl 文件并删除
      const agentDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent", "sessions");
      if (existsSync(agentDir)) {
        for (const dir of readdirSync(agentDir)) {
          const sessionDir = path.join(agentDir, dir);
          if (!existsSync(sessionDir)) continue;
          for (const file of readdirSync(sessionDir)) {
            if (file.includes(sessionId)) {
              try { unlinkSync(path.join(sessionDir, file)); } catch {}
              console.log(`[delete-forever] 已删除: ${file}`);
            }
          }
        }
      }
      return store.state;
    } catch (e) {
      console.warn("[delete-forever] 失败:", (e as Error).message);
      return null;
    }
  });

  // 手动压缩当前会话（pi 内置 compact）
  ipcMain.handle("workbench:compact-session", async (event) => {
    try {
      const view = viewForWebContents(event.sender.id);
      if (!view) return null;
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (!ws || !st.selectedSessionId) return null;
      await store.driver.compactSession({ workspaceId: ws.id, sessionId: st.selectedSessionId } as any);
      return store.state;
    } catch (e) {
      console.warn("[compact] 压缩失败:", (e as Error).message);
      return null;
    }
  });

  // 会话标题总结：用 LLM 总结对话内容生成标题，在切出会话时调用
  ipcMain.handle("workbench:generate-title", async (_event, workspaceId: string, sessionId: string) => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return null;
      const session = ws.sessions.find((s) => s.id === sessionId);
      if (!session) return null;
      // 只在标题是默认值时才生成（New thread / 新会话 / 空标题 / workspace 名）
      const isDefaultTitle = !session.title
        || session.title === "New thread"
        || session.title === "新会话"
        || session.title === ws.name
        || session.title === "Workbench";
      if (!isDefaultTitle) return session.title;
      // 取会话 transcript 作为总结输入
      const transcript = await store.getSelectedTranscriptForView({ workspaceId, sessionId } as any);
      const messages = transcript?.transcript ?? [];
      // 拼接对话文本（取前 6 条消息，避免太长）
      const dialogue = messages
        .filter((m: any) => m.kind === "message")
        .slice(0, 6)
        .map((m: any) => `${m.role === "user" ? "用户" : "助手"}: ${(m.text ?? "").slice(0, 200)}`)
        .join("\n");
      if (!dialogue.trim()) return null;
      // 通过 driver 生成标题
      const title = await store.driver.generateThreadTitle(
        { workspaceId, path: ws.path } as any,
        { prompt: dialogue },
      );
      if (title && title.trim()) {
        await store.renameSession({ workspaceId, sessionId } as any, title.trim());
        return title.trim();
      }
      return null;
    } catch (e) {
      console.warn("[title-gen] 生成标题失败:", (e as Error).message);
      return null;
    }
  });

  // 引导完成：标记 sentinel（不再自动扫描）+ 通知渲染层刷新业务数据
  ipcMain.handle("onboarding:finish", () => {
    const sentinel = path.join(defaultWorkspacePath, ".init-scan-done");
    writeFileSync(sentinel, new Date().toISOString(), "utf-8");
    // 通知渲染层：业务数据已就绪，立即刷新状态面板
    if (mainWindow) {
      mainWindow.webContents.send("workbench:data-refreshed");
    }
    return true;
  });
  ipcMain.handle(desktopIpc.stateRequest, (event) => store.getStateForView(viewForWebContents(event.sender.id)));
  ipcMain.handle(desktopIpc.selectedTranscriptRequest, (event) =>
    store.getSelectedTranscriptForView(viewForWebContents(event.sender.id)),
  );
  ipcMain.handle(desktopIpc.addWorkspacePath, (event, workspacePath: string) =>
    runWindowScopedForEvent(event, () => store.addWorkspace(workspacePath)),
  );
  ipcMain.handle(desktopIpc.pickWorkspace, (event) =>
    pickWorkspaceViaDialog(BrowserWindow.fromWebContents(event.sender)),
  );
  ipcMain.handle(desktopIpc.selectWorkspace, (event, workspaceId: string) =>
    runWindowScopedForEvent(event, () => store.selectWorkspace(workspaceId)),
  );
  ipcMain.handle(desktopIpc.renameWorkspace, (event, workspaceId: string, displayName: string) =>
    runWindowScopedForEvent(event, () => store.renameWorkspace(workspaceId, displayName)),
  );
  ipcMain.handle(desktopIpc.removeWorkspace, (event, workspaceId: string) =>
    runWindowScopedForEvent(event, () => store.removeWorkspace(workspaceId)),
  );
  ipcMain.handle(desktopIpc.reorderWorkspaces, (event, order: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.reorderWorkspaces(order)),
  );
  ipcMain.handle(desktopIpc.reorderPinnedSessions, (event, order: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.reorderPinnedSessions(order)),
  );
  ipcMain.handle(desktopIpc.openWorkspaceInFinder, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await shell.openPath(workspacePath);
  });
  ipcMain.handle(desktopIpc.createWorktree, (event, input: CreateWorktreeInput) =>
    runWindowScopedForEvent(event, () => store.createWorktree(input)),
  );
  ipcMain.handle(desktopIpc.removeWorktree, (event, input: RemoveWorktreeInput) =>
    runWindowScopedForEvent(event, () => store.removeWorktree(input)),
  );
  ipcMain.handle(desktopIpc.syncCurrentWorkspace, (event) =>
    runWindowScopedForEvent(event, () => store.syncCurrentWorkspace()),
  );
  ipcMain.handle(desktopIpc.selectSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, async () => {
      const result = store.selectSessionFast(target);
      // Phase 2: 会话切换时更新 working-context（受配置控制）
      try {
        const wikiConfig = readWikiConfig(configuredUserDataDir);
        if (wikiConfig.autoUpdateContext) {
          const st = store.state;
          const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
          if (ws?.path) {
            const ts = new Date().toLocaleString("zh-CN", { hour12: false });
            updateMemory(ws.path, "working-context", `\n## 会话切换\n- ${ts} 切换到会话`, "append");
          }
        }
      } catch { /* 非阻塞 */ }
      return result;
    }),
  );
  ipcMain.handle(desktopIpc.renameSession, (event, target: WorkspaceSessionTarget, title: string) =>
    runWindowScopedForEvent(event, () => store.renameSession(target, title)),
  );
  ipcMain.handle(desktopIpc.archiveSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.archiveSession(target)),
  );
  ipcMain.handle(desktopIpc.unarchiveSession, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.unarchiveSession(target)),
  );
  ipcMain.handle(desktopIpc.markSessionRead, (event, target: WorkspaceSessionTarget) =>
    runWindowScopedForEvent(event, () => store.markSessionRead(target)),
  );
  ipcMain.handle(desktopIpc.setSessionPinned, (event, target: WorkspaceSessionTarget, pinned: boolean) =>
    runWindowScopedForEvent(event, () => store.setSessionPinned(target, pinned)),
  );
  ipcMain.handle(desktopIpc.setActiveView, (event, activeView) =>
    runWindowScopedForEvent(event, () => store.setActiveView(activeView)),
  );
  ipcMain.handle(desktopIpc.setSidebarCollapsed, (event, collapsed: boolean) =>
    runWindowScopedForEvent(event, () => store.setSidebarCollapsed(collapsed)),
  );
  ipcMain.handle(desktopIpc.refreshRuntime, (event, workspaceId?: string) =>
    runWindowScopedForEvent(event, () => store.refreshRuntime(workspaceId)),
  );
  ipcMain.handle(desktopIpc.setModelSettingsScopeMode, (event, mode) =>
    runWindowScopedForEvent(event, () => store.setModelSettingsScopeMode(mode)),
  );
  ipcMain.handle(desktopIpc.setSessionModel, (event, workspaceId: string, sessionId: string, provider: string, modelId: string) =>
    runWindowScopedForEvent(event, () => store.setSessionModel({ workspaceId, sessionId }, provider, modelId)),
  );
  ipcMain.handle(desktopIpc.setDefaultModel, (event, workspaceId: string, provider: string, modelId: string) =>
    runWindowScopedForEvent(event, () => store.setDefaultModel(workspaceId, provider, modelId)),
  );
  ipcMain.handle(
    desktopIpc.setDefaultThinkingLevel,
    (event, workspaceId: string, thinkingLevel) =>
      runWindowScopedForEvent(event, () => store.setDefaultThinkingLevel(workspaceId, thinkingLevel)),
  );
  ipcMain.handle(
    desktopIpc.setSessionThinkingLevel,
    (event, workspaceId: string, sessionId: string, thinkingLevel) =>
      runWindowScopedForEvent(event, () => store.setSessionThinkingLevel({ workspaceId, sessionId }, thinkingLevel)),
  );
  ipcMain.handle(desktopIpc.loginProvider, (event, workspaceId: string, providerId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    // CoStrict：走托管 costrict-router 的一键登录（和 OAuth 行同款交互）
    if (providerId === "costrict") {
      return runUnscopedStateResultForWindow(window, async () => {
        const r = await costrictOneClickLogin({ callbacks: createRuntimeLoginCallbacks(window) });
        if (!r.ok) throw new Error(r.error);
        return store.emit();
      });
    }
    return runUnscopedStateResultForWindow(window, () =>
      store.loginProvider(workspaceId, providerId, createRuntimeLoginCallbacks(window)),
    );
  });
  ipcMain.handle(desktopIpc.logoutProvider, (event, workspaceId: string, providerId: string) => {
    if (providerId === "costrict") {
      return runWindowScopedForEvent(event, async () => {
        await costrictDisconnect();
        return store.emit();
      });
    }
    return runWindowScopedForEvent(event, () => store.logoutProvider(workspaceId, providerId));
  });
  ipcMain.handle(desktopIpc.setProviderApiKey, (event, workspaceId: string, providerId: string, apiKey: string) =>
    runWindowScopedForEvent(event, () => store.setProviderApiKey(workspaceId, providerId, apiKey)),
  );
  ipcMain.handle(desktopIpc.setEnableSkillCommands, (event, workspaceId: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setEnableSkillCommands(workspaceId, enabled)),
  );
  ipcMain.handle(desktopIpc.listCustomProviders, () => store.listCustomProviders());
  ipcMain.handle(desktopIpc.setCustomProvider, (event, workspaceId: string, config: CustomProviderConfig) =>
    runWindowScopedForEvent(event, () => store.setCustomProvider(workspaceId, config)),
  );
  ipcMain.handle(desktopIpc.deleteCustomProvider, (event, workspaceId: string, providerId: string) =>
    runWindowScopedForEvent(event, () => store.deleteCustomProvider(workspaceId, providerId)),
  );
  ipcMain.handle(desktopIpc.probeCustomProviderModels, (_event, input: CustomProviderProbeInput) =>
    probeCustomProviderModels(input),
  );
  ipcMain.handle(desktopIpc.setScopedModelPatterns, (event, workspaceId: string, patterns: readonly string[]) =>
    runWindowScopedForEvent(event, () => store.setScopedModelPatterns(workspaceId, patterns)),
  );
  ipcMain.handle(desktopIpc.setSkillEnabled, (event, workspaceId: string, filePath: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setSkillEnabled(workspaceId, filePath, enabled)),
  );
  ipcMain.handle(desktopIpc.setExtensionEnabled, (event, workspaceId: string, filePath: string, enabled: boolean) =>
    runWindowScopedForEvent(event, () => store.setExtensionEnabled(workspaceId, filePath, enabled)),
  );
  ipcMain.handle(desktopIpc.respondToHostUiRequest, (event, workspaceId: string, sessionId: string, response) =>
    runImmediateStateResultForWindow(
      BrowserWindow.fromWebContents(event.sender),
      () => store.respondToHostUiRequest({ workspaceId, sessionId }, response),
    ),
  );
  ipcMain.handle(desktopIpc.setNotificationPreferences, (event, preferences) =>
    runWindowScopedForEvent(event, () => store.setNotificationPreferences(preferences)),
  );
  ipcMain.handle(desktopIpc.setIntegratedTerminalShell, (event, shellPath: string) =>
    runWindowScopedForEvent(event, () => store.setIntegratedTerminalShell(shellPath)),
  );
  ipcMain.handle(desktopIpc.setEnableTransparency, async (_event, enabled: boolean) => {
    const nextState = await store.setEnableTransparency(enabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (process.platform === "darwin") {
        mainWindow.setVibrancy(enabled ? "under-window" : null);
      }
    }
    return nextState;
  });
  ipcMain.handle(desktopIpc.terminalEnsurePanel, (event, workspaceId: string, terminalScopeId: string, size) => {
    return getTerminalService().ensurePanel(event.sender, workspaceId, terminalScopeId, size);
  });
  ipcMain.handle(desktopIpc.terminalCreateSession, (event, workspaceId: string, terminalScopeId: string, size) => {
    return getTerminalService().createSession(event.sender, workspaceId, terminalScopeId, size);
  });
  ipcMain.handle(desktopIpc.terminalSetActiveSession, (event, workspaceId: string, terminalScopeId: string, terminalId: string) => {
    return getTerminalService().setActiveSession(event.sender, workspaceId, terminalScopeId, terminalId);
  });
  ipcMain.handle(desktopIpc.terminalWrite, (event, terminalId: string, data: string) => {
    terminalService?.write(event.sender, terminalId, data);
  });
  ipcMain.handle(desktopIpc.terminalResize, (event, terminalId: string, size) => {
    terminalService?.resize(event.sender, terminalId, size);
  });
  ipcMain.handle(desktopIpc.terminalRestartSession, (event, terminalId: string, size) => {
    return getTerminalService().restart(event.sender, terminalId, size);
  });
  ipcMain.handle(desktopIpc.terminalCloseSession, (event, terminalId: string) => {
    return getTerminalService().close(event.sender, terminalId);
  });
  ipcMain.handle(desktopIpc.terminalSetTitle, (event, terminalId: string, title: string) => {
    terminalService?.setTitle(event.sender, terminalId, title);
  });
  ipcMain.on(desktopIpc.terminalSetFocused, (event, focused: boolean) => {
    if (focused) {
      terminalFocusedWebContentsIds.add(event.sender.id);
    } else {
      terminalFocusedWebContentsIds.delete(event.sender.id);
    }
  });
  ipcMain.handle(desktopIpc.getNotificationPermissionStatus, () =>
    notificationPermissionService?.getCurrentStatus() ?? Promise.resolve("unknown"),
  );
  ipcMain.handle(desktopIpc.requestNotificationPermission, () =>
    notificationPermissionService?.requestPermission() ?? Promise.resolve("unknown"),
  );
  ipcMain.handle(desktopIpc.openSystemNotificationSettings, () =>
    notificationPermissionService?.openSystemSettings() ?? Promise.resolve(),
  );
  ipcMain.handle(desktopIpc.createSession, (event, input: CreateSessionInput) =>
    runWindowScopedForEvent(event, () => store.createSession(input)),
  );
  ipcMain.handle(desktopIpc.startThread, (event, input: StartThreadInput) =>
    runWindowScopedForEvent(event, () => store.startThread(input)),
  );
  ipcMain.handle(desktopIpc.forkThread, (event, input: ForkThreadInput) =>
    runWindowScopedForEvent(event, () => store.forkThread(input)),
  );
  ipcMain.handle(desktopIpc.sendChildThreadFollowUp, (event, input: SendChildThreadFollowUpInput) =>
    runWindowScopedForEvent(event, () => store.sendChildThreadFollowUp(input)),
  );
  ipcMain.handle(desktopIpc.setChildSupervisionLoop, (event, input: SetChildSupervisionLoopInput) =>
    runWindowScopedForEvent(event, () => store.setChildSupervisionLoop(input)),
  );
  ipcMain.handle(desktopIpc.openSkillInFinder, async (_event, workspaceId: string, filePath: string) => {
    const resolved = store.getSkillFilePath(workspaceId, filePath);
    if (!resolved) {
      throw new Error(`Unknown skill: ${filePath}`);
    }
    await shell.openPath(path.dirname(resolved));
  });
  ipcMain.handle(desktopIpc.openExtensionInFinder, async (_event, workspaceId: string, filePath: string) => {
    const resolved = store.getExtensionFilePath(workspaceId, filePath);
    if (!resolved) {
      throw new Error(`Unknown extension: ${filePath}`);
    }
    await shell.openPath(path.dirname(resolved));
  });
  ipcMain.handle(desktopIpc.cancelCurrentRun, (event) =>
    runWindowScopedForEvent(event, () => store.cancelCurrentRun()),
  );
  ipcMain.handle(desktopIpc.pickComposerAttachments, async (event) => {
    const window = resolveDialogWindow(BrowserWindow.fromWebContents(event.sender));
    const result =
      window
        ? await dialog.showOpenDialog(window, {
            properties: ["openFile", "multiSelections"],
            title: "Attach files",
          })
        : await dialog.showOpenDialog({
            properties: ["openFile", "multiSelections"],
            title: "Attach files",
          });
    if (result.canceled || result.filePaths.length === 0) {
      return stateForWindow(window);
    }
    const attachments = await Promise.all(result.filePaths.map(readComposerAttachment));
    return runWindowScopedForWindow(window, () => store.addComposerAttachments(attachments));
  });
  ipcMain.on(desktopIpc.readClipboardImage, (event) => {
    event.returnValue = readClipboardImageAttachment();
  });
  ipcMain.handle(desktopIpc.addComposerAttachments, (event, attachments: readonly ComposerAttachment[]) => {
    const validated = attachments.flatMap(validateComposerAttachmentPayload);
    return runWindowScopedForEvent(event, () => store.addComposerAttachments(validated));
  });
  ipcMain.handle(desktopIpc.removeComposerAttachment, (event, attachmentId: string) =>
    runWindowScopedForEvent(event, () => store.removeComposerAttachment(attachmentId)),
  );
  ipcMain.handle(desktopIpc.editQueuedComposerMessage, (event, messageId: string, currentDraft?: string) =>
    runWindowScopedForEvent(event, () => store.editQueuedComposerMessage(messageId, currentDraft)),
  );
  ipcMain.handle(desktopIpc.cancelQueuedComposerEdit, (event) =>
    runWindowScopedForEvent(event, () => store.cancelQueuedComposerEdit()),
  );
  ipcMain.handle(desktopIpc.removeQueuedComposerMessage, (event, messageId: string) =>
    runWindowScopedForEvent(event, () => store.removeQueuedComposerMessage(messageId)),
  );
  ipcMain.handle(desktopIpc.steerQueuedComposerMessage, (event, messageId: string) =>
    runWindowScopedForEvent(event, () => store.steerQueuedComposerMessage(messageId)),
  );
  ipcMain.handle(desktopIpc.updateComposerDraft, (event, composerDraft: string) =>
    runWindowScopedForEvent(event, async () => {
      currentComposerDraftPersistOriginWebContentsId = event.sender.id;
      try {
        return await store.updateComposerDraft(composerDraft);
      } finally {
        currentComposerDraftPersistOriginWebContentsId = undefined;
      }
    }),
  );
  ipcMain.handle(
    desktopIpc.submitComposer,
    (event, text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) =>
      runWindowScopedForEvent(event, () => store.submitComposer(text, options)),
  );
  ipcMain.handle(desktopIpc.getSessionTree, (_event, target: WorkspaceSessionTarget) =>
    store.getSessionTree(target),
  );
  ipcMain.handle(
    desktopIpc.navigateSessionTree,
    (event, target: WorkspaceSessionTarget, targetId: string, options) =>
      runWindowScopedStateResult(BrowserWindow.fromWebContents(event.sender), () =>
        store.navigateSessionTree(target, targetId, options),
      ),
  );
  ipcMain.handle(desktopIpc.listWorkspaceFiles, async (_event, workspaceId: string, options?: { readonly force?: boolean }) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return [];
    }
    return listWorkspaceFiles(workspacePath, options);
  });
  ipcMain.handle(desktopIpc.readWorkspaceFile, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return readWorkspaceFile(workspacePath, filePath);
  });
  ipcMain.handle(desktopIpc.getChangedFiles, async (_event, workspaceId: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return {
        state: "unavailable",
        error: {
          code: "workspace-unavailable",
          message: "Changed files are unavailable because this workspace could not be found.",
        },
      } satisfies ChangedFilesResult;
    }
    return getChangedFiles(workspacePath);
  });
  ipcMain.handle(desktopIpc.getFileDiff, async (_event, workspaceId: string, filePath: string) => {
    const workspacePath = store.getWorkspacePath(workspaceId);
    if (!workspacePath) {
      return "";
    }
    return getFileDiff(workspacePath, filePath);
  });
  ipcMain.handle(
    desktopIpc.stageFile,
    async (_event, workspaceId: string, filePath: string, stagingSourcePath?: string) => {
      const workspacePath = store.getWorkspacePath(workspaceId);
      if (!workspacePath) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      await stageFile(workspacePath, filePath, { sourcePath: stagingSourcePath });
    },
  );
  // 会话统计（token/cost/消息数）
  ipcMain.handle("workbench:get-session-stats", async () => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (!ws?.id) return null;
      const session = ws.sessions.find((s) => s.id === st.selectedSessionId);
      if (!session) return null;
      // 从 transcript 估算
      const transcript = await store.getSelectedTranscriptForView({ workspaceId: ws.id, sessionId: session.id } as any);
      const messages = transcript?.transcript ?? [];
      const messageCount = messages.filter((m: any) => m.kind === "message").length;
      const toolCallCount = messages.filter((m: any) => m.kind === "tool").length;
      const totalChars = messages.reduce((sum: number, m: any) => {
        if (m.kind === "message") return sum + (m.text?.length ?? 0);
        if (m.kind === "tool") return sum + JSON.stringify(m.input ?? "").length;
        return sum;
      }, 0);
      return {
        messageCount,
        toolCallCount,
        estimatedTokens: Math.ceil(totalChars / 4),
      };
    } catch { return null; }
  });

  // 导出会话
  ipcMain.handle("workbench:export-session", async (_event, format: "html" | "jsonl", outputPath?: string) => {
    try {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (!ws?.id) return null;
      // 简易导出：transcript → text
      const transcript = await store.getSelectedTranscriptForView({ workspaceId: ws.id, sessionId: st.selectedSessionId } as any);
      const messages = transcript?.transcript ?? [];
      if (format === "jsonl") {
        const lines = messages.map((m: any) => JSON.stringify(m)).join("\n");
        return lines;
      }
      // html
      const html = messages.map((m: any) => {
        if (m.kind === "message") return `<div class="msg ${m.role}"><b>${m.role}</b>: ${(m.text ?? "").replace(/</g, "&lt;")}</div>`;
        if (m.kind === "tool") return `<div class="tool">🔧 ${m.toolName}</div>`;
        return "";
      }).join("\n");
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Session Export</title>
        <style>.msg{margin:8px 0;padding:8px;border-radius:8px}.user{background:#e8e8e8}.assistant{background:#f5f5f5}.tool{color:#666;font-size:12px}</style>
        </head><body>${html}</body></html>`;
    } catch (e) { return null; }
  });

  // 自动压缩设置 — 写入 pi settings.json
  ipcMain.handle("workbench:set-auto-compact", async (_event, enabled: boolean) => {
    try {
      const agentDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent");
      const settingsPath = path.join(agentDir, "settings.json");
      let settings: any = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
      settings.compaction = { ...settings.compaction, enabled };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      // 刷新当前 session 让设置生效
      const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
      if (ws) await store.driver.runtimeSupervisor.refreshRuntime(ws);
      return enabled;
    } catch (e) {
      console.warn("[auto-compact] 设置失败:", (e as Error).message);
      return null;
    }
  });

  // 读取自动压缩当前值
  ipcMain.handle("workbench:get-auto-compact", async () => {
    try {
      const agentDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".pi", "agent");
      const settingsPath = path.join(agentDir, "settings.json");
      if (!existsSync(settingsPath)) return true;  // 默认开启
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      return settings.compaction?.enabled ?? true;
    } catch { return true; }
  });

  // Steering/FollowUp 模式 — 通过 session supervisor 设置
  ipcMain.handle("workbench:set-steering-mode", async (_event, mode: string) => {
    // steering 模式目前仅由 renderer 本地记忆，下次 run 组装消息时生效，
    // 暂无主进程侧状态需要写入
    return mode;
  });

  // 待办排序规则：读取 / 保存
  ipcMain.handle("workbench:get-todo-rules", () => readTodoRules(configuredUserDataDir));
  ipcMain.handle("workbench:save-todo-rules", (_event, content: string) => {
    writeTodoRules(configuredUserDataDir, content);
    // 同步到 AGENTS.md
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (ws) {
      const prompt = readBusinessPrompt(configuredUserDataDir);
      const fullPrompt = prompt + "\n\n" + content;
      syncPromptToWorkspace(ws.path, fullPrompt);
    }
    return content;
  });

  // ── Wiki 知识库配置 ──
  ipcMain.handle("workbench:get-wiki-config", () => readWikiConfig(configuredUserDataDir));
  ipcMain.handle("workbench:save-wiki-config", (_event, config: WikiConfig) => {
    writeWikiConfig(configuredUserDataDir, config);
    return config;
  });
  ipcMain.handle("workbench:patch-wiki-config", async (_event, patch: Partial<WikiConfig>) => {
    const updated = patchWikiConfig(configuredUserDataDir, patch);
    // dailyBriefing toggle → 自动创建/删除每日早报定时规则
    if ("dailyBriefing" in patch || "dailyBriefingTime" in patch) {
      const st = store.state;
      const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (ws?.path) {
        try {
          ensureScheduleFile(ws.path);
          if (updated.dailyBriefing) {
            // upsert：固定 id "daily-briefing"，开启时创建/更新
            addScheduleRule(ws.path, {
              id: "daily-briefing",
              name: "每日早报",
              trigger: { type: "every", time: updated.dailyBriefingTime },
              action: "查询今日待办 + 维保到期 + 日程冲突，生成简报。用简洁的方式汇报重点事项。",
            });
          } else {
            removeScheduleRule(ws.path, "daily-briefing");
          }
        } catch { /* 非关键路径 */ }
      }
    }
    return updated;
  });

  // ── Agent 自我修改插件管理（与 Extensions 设置页联动） ──
  ipcMain.handle("workbench:list-plugins", async () => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return [];
    return listPlugins(ws.path);
  });
  ipcMain.handle("workbench:remove-plugin", async (_event, name: string) => {
    const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
    if (!ws) return false;
    const ok = removePlugin(ws.path, name);
    if (ok) {
      try { await store.driver.runtimeSupervisor.refreshRuntime(ws); } catch { /* ignore */ }
    }
    return ok;
  });
  // 设置页新建插件（带代码验证 + 热加载）。
  // 与 Agent 工具路径（business-runtime wiki_create_plugin）一致：受 selfModifyPlugins
  // 总开关门控——插件是可执行代码，写入即热加载（安全审核 F-27）
  ipcMain.handle("workbench:create-plugin", async (_event, name: string, code: string) => {
    let selfModifyEnabled = false;
    try { selfModifyEnabled = getActiveWikiConfig().selfModifyPlugins === true; } catch { /* 读取失败视为关闭 */ }
    if (!selfModifyEnabled) {
      return { created: false, reason: "插件自修改未开启（设置 → Wiki → 允许 Agent 创建插件）" };
    }
    const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
    if (!ws) return { created: false, reason: "无可用工作区" };
    const result = createPlugin(ws.path, name, code);
    // P1-a 热加载：创建成功后刷新运行时
    if ((result as any).created) {
      try { await store.driver.runtimeSupervisor.refreshRuntime(ws); (result as any).hotReloaded = true; } catch { /* 刷新失败保留重启提示 */ }
    }
    return result;
  });
  // 设置页新建 Skill（写 ~/.pi/agent/skills/<name>/SKILL.md + 热加载）
  ipcMain.handle("workbench:create-skill", async (_event, name: string, description: string, content: string) => {
    try {
      const result = createSkill(userSkillsRoot(), name, description, content);
      if (!result.created) return result;
      const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
      if (ws) {
        try { await store.driver.runtimeSupervisor.refreshRuntime(ws); (result as any).hotReloaded = true; } catch { /* 刷新失败不阻塞创建 */ }
      }
      return result;
    } catch (e) {
      return { created: false, reason: (e as Error).message };
    }
  });

  // ── Skill 导入（设置页：技能包 = 含 SKILL.md 的目录） ──
  // SK-1/F-32：pick-directory 返回一次性令牌而非裸路径——被入侵的渲染层
  // 无法用任意路径（网络盘/临时目录投放的"技能包"）静默安装实现持久化注入。
  // 令牌 10 分钟有效、用后即焚，只有真正经过系统对话框选择的目录能被导入。
  const directoryTokens = new Map<string, { dir: string; expiresAt: number }>();
  const DIRECTORY_TOKEN_TTL_MS = 10 * 60_000;
  const issueDirectoryToken = (dir: string): string => {
    const now = Date.now();
    for (const [t, e] of directoryTokens) {
      if (e.expiresAt < now) directoryTokens.delete(t);
    }
    const token = randomUUID();
    directoryTokens.set(token, { dir, expiresAt: now + DIRECTORY_TOKEN_TTL_MS });
    return token;
  };
  const consumeDirectoryToken = (token: string): string | null => {
    const entry = directoryTokens.get(token);
    directoryTokens.delete(token); // 用后即焚
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.dir;
  };
  ipcMain.handle("workbench:pick-directory", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "选择要导入的 Skill 目录（需包含 SKILL.md）",
      properties: ["openDirectory"],
    });
    return r.canceled || r.filePaths.length === 0 ? null : issueDirectoryToken(r.filePaths[0]!);
  });
  ipcMain.handle("workbench:import-skill", async (_event, token: string) => {
    try {
      const sourceDir = consumeDirectoryToken(String(token ?? ""));
      if (!sourceDir) return { imported: false, reason: "目录令牌无效或已过期，请重新选择目录" };
      const result = importSkill(userSkillsRoot(), sourceDir);
      if (!result.imported) return result;
      const ws = store.workspaceRefFromState(store.state.selectedWorkspaceId);
      if (ws) {
        try { await store.driver.runtimeSupervisor.refreshRuntime(ws); (result as any).hotReloaded = true; } catch { /* 刷新失败不阻塞导入 */ }
      }
      return result;
    } catch (e) {
      return { imported: false, reason: (e as Error).message };
    }
  });

  // ── 会话分组管理 ──
  ipcMain.handle("workbench:get-session-groups", () => {
    return readSessionGroups(configuredUserDataDir);
  });
  ipcMain.handle("workbench:create-session-group", (_event, name: string) => {
    return createGroup(configuredUserDataDir, name);
  });
  ipcMain.handle("workbench:remove-session-group", (_event, groupId: string) => {
    return removeGroup(configuredUserDataDir, groupId);
  });
  ipcMain.handle("workbench:assign-session-group", (_event, sessionId: string, groupId: string | null) => {
    return assignSessionToGroup(configuredUserDataDir, sessionId, groupId);
  });

  // ── Hooks 规则管理（P2，设置页 UI） ──
  ipcMain.handle("workbench:list-hooks", async () => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return [];
    ensureHooksFile(ws.path);
    return readHookRules(ws.path);
  });
  ipcMain.handle("workbench:add-hook", async (_event, input: { name: string; event: string; toolName: string; action: string; message: string }) => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return null;
    return addHookRule(ws.path, input as any);
  });
  ipcMain.handle("workbench:remove-hook", async (_event, ruleId: string) => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return false;
    return removeHookRule(ws.path, ruleId);
  });

  // ── 定时任务管理（渲染层读写 schedule.md） ──
  ipcMain.handle("workbench:list-schedules-ui", async () => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return [];
    ensureScheduleFile(ws.path);
    return readScheduleRules(ws.path);
  });
  ipcMain.handle("workbench:create-schedule-ui", async (_event, rule: { name: string; triggerType: "every" | "at" | "before_event"; time?: string; weekday?: number; days?: number; entityType?: string; field?: string; action: string }) => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return null;
    ensureScheduleFile(ws.path);
    return addScheduleRule(ws.path, {
      name: rule.name,
      trigger: {
        type: rule.triggerType,
        time: rule.time,
        weekday: rule.weekday,
        days: rule.days,
        entityType: rule.entityType,
        field: rule.field,
      },
      action: rule.action,
    });
  });
  ipcMain.handle("workbench:remove-schedule-ui", async (_event, ruleId: string) => {
    const st = store.state;
    const ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
    if (!ws) return false;
    return removeScheduleRule(ws.path, ruleId);
  });

  // 更新实体字段（供渲染层勾选待办等操作）
  ipcMain.handle("workbench:update-entity", async (_event, entityType: string, entityId: string, updates: Record<string, unknown>) => {
    try {
      const st = store.state;
      let ws = st.workspaces.find((w) => w.id === st.selectedWorkspaceId);
      if (ws && !existsSync(path.join(ws.path, "workbench"))) {
        ws = st.workspaces.find((w) => w.path === defaultWorkspacePath) ?? st.workspaces[0];
      }
      if (!ws) return null;
      const existing = readEntity(ws.path, entityType, entityId);
      if (!existing) return null;
      const updatedFm = { ...existing.frontmatter, ...updates };
      const fmText = Object.entries(updatedFm).map(([k, v]) => `${k}: ${v}`).join("\n");
      writeFileSync(entityFile(ws.path, entityType, entityId), `---\n${fmText}\n---\n${existing.body}\n`, "utf-8");
      // 如果是待办标记为完成，推送通知
      if (entityType === "todos" && updates.status === "done" && todoReminder) {
        todoReminder.notifyCompleted(String(existing.frontmatter.title ?? "待办"));
      }
      return true;
    } catch (e) {
      console.warn("[update-entity] 失败:", (e as Error).message);
      return null;
    }
  });

  // 最小化窗口
  ipcMain.handle("workbench:minimize-window", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.minimize();
  });

  ipcMain.handle(desktopIpc.toggleWindowMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
      return;
    }

    window.maximize();
  });

  createAppWindow();
  void notificationPermissionService.getCurrentStatus();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createAppWindow();
      void notificationPermissionService?.getCurrentStatus();
    }
  });
});

app.on("window-all-closed", () => {
  // macOS normally keeps the app alive after its final window closes. The
  // Electron harness closes windows to end each isolated run, so let explicit
  // test-mode launches quit instead of leaving their process behind forever.
  if (process.platform !== "darwin" || appTestMode !== undefined) {
    stopNotifications?.();
    stopNotifications = undefined;
    notificationManager = undefined;
    notificationPermissionService?.dispose();
    notificationPermissionService = undefined;
    stopUpdateChecker?.();
    stopUpdateChecker = undefined;
    stopPruningTerminals?.();
    stopPruningTerminals = undefined;
    terminalService?.dispose();
    terminalService = undefined;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  reminderScheduler?.stop();
  reminderScheduler = undefined;
  todoReminder?.stop();
  todoReminder = undefined;
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  notificationPermissionService?.dispose();
  notificationPermissionService = undefined;
  stopUpdateChecker?.();
  stopUpdateChecker = undefined;
  stopPruningTerminals?.();
  stopPruningTerminals = undefined;
  terminalService?.dispose();
  terminalService = undefined;
  if (quittingAfterStoreFlush || !store) {
    return;
  }

  event.preventDefault();
  quittingAfterStoreFlush = true;
  const flush = store
    .flushPersistence()
    .catch((error) => {
      console.error("pi-gui: persistence flush failed during quit:", error);
    });
  // Never let a hung flush block quit forever — quit after a bounded wait.
  const flushDeadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("pi-gui: persistence flush timed out during quit; quitting anyway.");
      resolve();
    }, QUIT_FLUSH_TIMEOUT_MS);
  });
  void Promise.race([flush, flushDeadline]).finally(() => {
    app.quit();
  });
});

function resolveInitialWorkspacePaths(): readonly string[] {
  const raw = process.env.PI_APP_INITIAL_WORKSPACES;
  const fromEnv = raw !== undefined
    ? raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [];
  // 首次启动把默认 workspace 加进去（已初始化过的会被 store 去重）
  return [defaultWorkspacePath, ...fromEnv];
}

async function readComposerAttachment(filePath: string): Promise<ComposerAttachment> {
  const mimeType = mimeTypeForPath(filePath);
  if (mimeType.startsWith("image/")) {
    return readComposerImageAttachment(filePath, mimeType);
  }

  const stats = await stat(filePath);
  return {
    id: randomUUID(),
    kind: "file",
    name: path.basename(filePath),
    mimeType,
    fsPath: filePath,
    ...(typeof stats.size === "number" ? { sizeBytes: stats.size } : {}),
  };
}

async function readComposerImageAttachment(filePath: string, mimeType: string): Promise<ComposerImageAttachment> {
  const buffer = await readFile(filePath);
  return {
    id: randomUUID(),
    kind: "image",
    name: path.basename(filePath),
    mimeType,
    data: buffer.toString("base64"),
  };
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const supported = SUPPORTED_IMAGE_TYPES.find((type) => type.extension === extension);
  if (supported) {
    return supported.mimeType;
  }
  return "application/octet-stream";
}

function validateComposerAttachmentPayload(attachment: ComposerAttachment): ComposerAttachment[] {
  if (attachment.kind === "image") {
    if (typeof attachment.data !== "string" || typeof attachment.mimeType !== "string" || !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return [];
    }
    return [
      {
        ...attachment,
        kind: "image",
      },
    ];
  }

  if (
    attachment.kind !== "file" ||
    typeof attachment.fsPath !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.name !== "string"
  ) {
    return [];
  }

  const normalized: ComposerFileAttachment = {
    ...attachment,
    kind: "file",
    fsPath: attachment.fsPath.trim(),
    name: attachment.name.trim() || path.basename(attachment.fsPath),
  };
  if (!normalized.fsPath) {
    return [];
  }
  return [normalized];
}

/* ============ 应用内弹窗（统一风格，替代原生 dialog/window.alert） ============ */
let appDialogSeq = 0;
const pendingAppDialogs = new Map<number, (r: { ok: boolean; value?: string }) => void>();

function showAppDialog(
  parentWindow: BrowserWindow | null | undefined,
  spec: {
    kind: "alert" | "confirm" | "prompt";
    message: string;
    detail?: string;
    placeholder?: string;
    defaultValue?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  },
): Promise<{ ok: boolean; value?: string } | null> {
  const w = resolveDialogWindow(parentWindow) ?? mainWindow;
  if (!w || w.isDestroyed()) return Promise.resolve(null);
  const id = ++appDialogSeq;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: { ok: boolean; value?: string }) => {
      if (settled) return;
      settled = true;
      pendingAppDialogs.delete(id);
      w.removeListener("closed", onClosed);
      clearTimeout(guard);
      resolve(r);
    };
    // 窗口关闭 → 视为取消；15 分钟安全兜底 → 防止调用方永久挂起
    const onClosed = () => settle({ ok: false });
    w.once("closed", onClosed);
    const guard = setTimeout(() => settle({ ok: false }), 15 * 60_000);
    pendingAppDialogs.set(id, settle);
    w.show();
    w.focus();
    w.webContents.send("workbench:app-dialog", { id, ...spec });
  });
}

function registerAppDialogResultIpc(): void {
  ipcMain.handle("workbench:app-dialog-result", (_e, id: number, result: { ok: boolean; value?: string }) => {
    pendingAppDialogs.get(id)?.(result ?? { ok: false });
    pendingAppDialogs.delete(id);
    return true;
  });
}

function createRuntimeLoginCallbacks(window?: BrowserWindow | null) {
  return {
    onAuth: async ({ url, instructions }: { readonly url: string; readonly instructions?: string }) => {
      await shell.openExternal(url);
      if (instructions?.trim()) {
        await showLoginInstructions(window, instructions.trim());
      }
    },
    onPrompt: async ({ message, placeholder, allowEmpty }: { readonly message: string; readonly placeholder?: string; readonly allowEmpty?: boolean }) =>
      promptForText(window, message, placeholder, allowEmpty ?? false),
  };
}

async function showLoginInstructions(parentWindow: BrowserWindow | null | undefined, message: string): Promise<void> {
  const r = await showAppDialog(parentWindow, { kind: "alert", message });
  if (r === null) {
    throw new Error("Main window is not available for login instructions.");
  }
}

// 登录等文本输入提示：应用内弹窗（保持原语义——取消/空值时抛错）
async function promptForText(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
  placeholder = "",
  allowEmpty = false,
): Promise<string> {
  const r = await showAppDialog(parentWindow, {
    kind: "prompt",
    message,
    placeholder,
  });
  if (r === null || !r.ok) {
    throw new Error("Login cancelled.");
  }
  const trimmed = (r.value ?? "").trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new Error("Login cancelled.");
  }
  return trimmed;
}


function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function probeCustomProviderModels(input: CustomProviderProbeInput): Promise<CustomProviderProbeResult> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl || !isValidHttpBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://" };
  }
  const target = `${baseUrl.replace(/\/+$/, "")}/models`;
  const apiKey = input.apiKey?.trim();
  try {
    const response = await net.fetch(target, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText} from ${target}` };
    }
    const payload = (await response.json()) as unknown;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { ok: false, error: `Response from ${target} is missing a "data" array` };
    }
    const models = data
      .map((entry) => {
        if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
          return (entry as { id: string }).id;
        }
        return undefined;
      })
      .filter((id): id is string => Boolean(id && id.length > 0));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: describeProbeError(error, target) };
  }
}

function describeProbeError(error: unknown, target: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timed out after 5s contacting ${target}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
