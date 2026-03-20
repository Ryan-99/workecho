import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiSdkDriver, type PiSdkDriverConfig } from "@pi-app/pi-sdk-driver";
import type {
  SessionCatalogEntry,
  WorkspaceCatalogEntry,
} from "@pi-app/catalogs";
import type { SessionDriverEvent, SessionRef, WorkspaceRef } from "@pi-app/session-driver";
import {
  cloneDesktopAppState,
  createEmptyDesktopAppState,
  type CreateSessionInput,
  type DesktopAppState,
  type SessionRecord,
  type SessionRole,
  type TranscriptMessage,
  type WorkspaceRecord,
  type WorkspaceSessionTarget,
} from "../src/desktop-state";

type StateListener = (state: DesktopAppState) => void;

interface PersistedUiState {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly transcripts?: Record<string, readonly TranscriptMessage[]>;
}

interface RefreshStateOptions {
  readonly selectedWorkspaceId?: string;
  readonly selectedSessionId?: string;
  readonly composerDraft?: string;
  readonly clearLastError?: boolean;
}

export interface DesktopAppStoreOptions {
  readonly userDataDir: string;
  readonly initialWorkspacePaths: readonly string[];
}

export class DesktopAppStore {
  private state = createEmptyDesktopAppState();
  private readonly listeners = new Set<StateListener>();
  private readonly driver: PiSdkDriver;
  private readonly uiStateFilePath: string;
  private readonly transcriptCache = new Map<string, TranscriptMessage[]>();
  private readonly sessionSubscriptions = new Map<string, () => void>();
  private readonly activeAssistantMessageBySession = new Map<string, string>();
  private readonly initialWorkspacePaths: readonly string[];
  private initPromise: Promise<void> | undefined;

  constructor(options: DesktopAppStoreOptions) {
    const driverOptions: PiSdkDriverConfig = {
      catalogFilePath: join(options.userDataDir, "catalogs.json"),
    };

    this.driver = new PiSdkDriver(driverOptions);
    this.uiStateFilePath = join(options.userDataDir, "ui-state.json");
    this.initialWorkspacePaths = options.initialWorkspacePaths;
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeInternal();
    }
    return this.initPromise;
  }

  async getState(): Promise<DesktopAppState> {
    await this.initialize();
    return cloneDesktopAppState(this.state);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    void this.getState()
      .then((state) => listener(state))
      .catch(() => undefined);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async addWorkspace(path: string): Promise<DesktopAppState> {
    await this.initialize();
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return this.emit();
    }

    const existing = this.state.workspaces.find((workspace) => workspace.path === normalizedPath);
    if (existing) {
      return this.selectWorkspace(existing.id);
    }

    const workspace = workspaceRefFromPath(normalizedPath);
    try {
      const snapshot = await this.driver.createSession(workspace, {
        title: `New thread`,
      });
      await this.ensureSessionSubscribed(snapshot.ref);
      this.transcriptCache.set(sessionKey(snapshot.ref), []);
      return this.refreshState({
        selectedWorkspaceId: snapshot.ref.workspaceId,
        selectedSessionId: snapshot.ref.sessionId,
        composerDraft: "",
        clearLastError: true,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async selectWorkspace(workspaceId: string): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return this.emit();
    }

    return this.refreshState({
      selectedWorkspaceId: workspaceId,
      selectedSessionId: workspace.sessions[0]?.id,
      clearLastError: true,
    });
  }

  async selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState> {
    await this.initialize();
    const sessionRef = toSessionRef(target);
    const targetRecord = this.state.workspaces
      .find((workspace) => workspace.id === target.workspaceId)
      ?.sessions.find((session) => session.id === target.sessionId);

    if (!targetRecord) {
      return this.emit();
    }

    try {
      await this.driver.openSession(sessionRef);
      await this.ensureSessionSubscribed(sessionRef);
      return this.refreshState({
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
        clearLastError: true,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async createSession(input: CreateSessionInput): Promise<DesktopAppState> {
    await this.initialize();
    const workspace = this.workspaceRefFromState(input.workspaceId);
    if (!workspace) {
      return this.withError(`Unknown workspace: ${input.workspaceId}`);
    }

    try {
      const snapshot = await this.driver.createSession(workspace, {
        title: input.title?.trim() || "New thread",
      });
      await this.ensureSessionSubscribed(snapshot.ref);
      this.transcriptCache.set(sessionKey(snapshot.ref), []);
      return this.refreshState({
        selectedWorkspaceId: snapshot.ref.workspaceId,
        selectedSessionId: snapshot.ref.sessionId,
        composerDraft: "",
        clearLastError: true,
      });
    } catch (error) {
      return this.withError(error);
    }
  }

  async updateComposerDraft(composerDraft: string): Promise<DesktopAppState> {
    await this.initialize();
    this.state = {
      ...this.state,
      composerDraft,
      lastError: undefined,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }

  async submitComposerDraft(): Promise<DesktopAppState> {
    await this.initialize();
    const text = this.state.composerDraft.trim();
    if (!text) {
      return this.emit();
    }

    const sessionRef = this.selectedSessionRef();
    if (!sessionRef) {
      return this.withError("Select a session before sending a message.");
    }

    const key = sessionKey(sessionRef);
    const transcript = [...(this.transcriptCache.get(key) ?? [])];
    transcript.push(makeTranscriptMessage("user", text));
    this.transcriptCache.set(key, transcript);
    this.clearActiveAssistantMessage(sessionRef);

    try {
      await this.driver.openSession(sessionRef);
      await this.ensureSessionSubscribed(sessionRef);
      await this.driver.sendUserMessage(sessionRef, { text });
      return this.refreshState({
        composerDraft: "",
        clearLastError: true,
      });
    } catch (error) {
      this.transcriptCache.set(key, transcript.slice(0, -1));
      return this.withError(error);
    }
  }

  private async initializeInternal(): Promise<void> {
    try {
      const persisted = await this.readUiState();
      this.transcriptCache.clear();
      for (const [sessionKeyValue, transcript] of Object.entries(persisted.transcripts ?? {})) {
        this.transcriptCache.set(sessionKeyValue, transcript.map(cloneTranscriptMessage));
      }

      await this.refreshState({
        selectedWorkspaceId: persisted.selectedWorkspaceId,
        selectedSessionId: persisted.selectedSessionId,
        composerDraft: persisted.composerDraft ?? "",
        clearLastError: true,
      });
    } catch (error) {
      this.state = {
        ...createEmptyDesktopAppState(),
        lastError: error instanceof Error ? error.message : String(error),
        revision: 1,
      };
      await this.persistUiState();
      this.emit();
    }
  }

  private async refreshState(options: RefreshStateOptions = {}): Promise<DesktopAppState> {
    const [workspacesSnapshot, sessionsSnapshot] = await Promise.all([
      this.driver.listWorkspaces(),
      this.driver.listSessions(),
    ]);

    const workspaces = buildWorkspaceRecords(workspacesSnapshot.workspaces, sessionsSnapshot.sessions, this.transcriptCache);
    const selectedWorkspaceId = resolveSelectedWorkspaceId(
      options.selectedWorkspaceId ?? this.state.selectedWorkspaceId,
      workspaces,
    );
    const selectedSessionId = resolveSelectedSessionId(
      selectedWorkspaceId,
      options.selectedSessionId ?? this.state.selectedSessionId,
      workspaces,
    );

    this.state = {
      ...this.state,
      workspaces,
      selectedWorkspaceId,
      selectedSessionId,
      composerDraft: options.composerDraft ?? this.state.composerDraft,
      lastError: options.clearLastError ? undefined : this.state.lastError,
      revision: this.state.revision + 1,
    };

    await this.reconcileSessionSubscriptions(sessionsSnapshot.sessions);
    await this.persistUiState();
    return this.emit();
  }

  private async reconcileSessionSubscriptions(sessions: readonly SessionCatalogEntry[]): Promise<void> {
    const activeKeys = new Set<string>();
    for (const session of sessions) {
      const key = sessionKey(session.sessionRef);
      activeKeys.add(key);
      await this.ensureSessionSubscribed(session.sessionRef);
    }

    for (const [key, unsubscribe] of this.sessionSubscriptions) {
      if (!activeKeys.has(key)) {
        unsubscribe();
        this.sessionSubscriptions.delete(key);
      }
    }
  }

  private async ensureSessionSubscribed(sessionRef: SessionRef): Promise<void> {
    const key = sessionKey(sessionRef);
    if (this.sessionSubscriptions.has(key)) {
      return;
    }

    const unsubscribe = this.driver.subscribe(sessionRef, (event) => {
      void this.handleSessionEvent(event);
    });

    this.sessionSubscriptions.set(key, unsubscribe);
  }

  private async handleSessionEvent(event: SessionDriverEvent): Promise<void> {
    const key = sessionKey(event.sessionRef);
    switch (event.type) {
      case "assistantDelta":
        this.appendAssistantDelta(event.sessionRef, event.text);
        break;
      case "runCompleted":
      case "runFailed":
      case "sessionClosed":
        this.clearActiveAssistantMessage(event.sessionRef);
        if (event.type === "runFailed") {
          this.state = {
            ...this.state,
            lastError: event.error.message,
          };
        }
        break;
      case "sessionOpened":
      case "sessionUpdated":
      case "toolStarted":
      case "toolUpdated":
      case "toolFinished":
      case "hostUiRequest":
        break;
      default:
        break;
    }

    if (event.type === "sessionClosed") {
      const unsubscribe = this.sessionSubscriptions.get(key);
      unsubscribe?.();
      this.sessionSubscriptions.delete(key);
    }

    await this.refreshState();
  }

  private appendAssistantDelta(sessionRef: SessionRef, text: string): void {
    const key = sessionKey(sessionRef);
    const transcript = [...(this.transcriptCache.get(key) ?? [])];
    const activeId = this.activeAssistantMessageBySession.get(key);

    if (activeId) {
      const index = transcript.findIndex((message) => message.id === activeId);
      const current = index >= 0 ? transcript[index] : undefined;
      if (current) {
        transcript[index] = {
          ...current,
          text: `${current.text}${text}`,
        };
      } else {
        const message = makeTranscriptMessage("assistant", text);
        transcript.push(message);
        this.activeAssistantMessageBySession.set(key, message.id);
      }
    } else {
      const message = makeTranscriptMessage("assistant", text);
      transcript.push(message);
      this.activeAssistantMessageBySession.set(key, message.id);
    }

    this.transcriptCache.set(key, transcript);
  }

  private clearActiveAssistantMessage(sessionRef: SessionRef): void {
    this.activeAssistantMessageBySession.delete(sessionKey(sessionRef));
  }

  private workspaceRefFromState(workspaceId: string): WorkspaceRef | undefined {
    const workspace = this.state.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return undefined;
    }

    return {
      workspaceId: workspace.id,
      path: workspace.path,
      displayName: workspace.name,
    };
  }

  private selectedSessionRef(): SessionRef | undefined {
    if (!this.state.selectedWorkspaceId || !this.state.selectedSessionId) {
      return undefined;
    }

    return {
      workspaceId: this.state.selectedWorkspaceId,
      sessionId: this.state.selectedSessionId,
    };
  }

  private async readUiState(): Promise<PersistedUiState> {
    try {
      const raw = await readFile(this.uiStateFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedUiState;
      return {
        selectedWorkspaceId: parsed.selectedWorkspaceId,
        selectedSessionId: parsed.selectedSessionId,
        composerDraft: parsed.composerDraft ?? "",
        transcripts: parsed.transcripts,
      };
    } catch {
      return {};
    }
  }

  private async persistUiState(): Promise<void> {
    const payload: PersistedUiState = {
      selectedWorkspaceId: this.state.selectedWorkspaceId || undefined,
      selectedSessionId: this.state.selectedSessionId || undefined,
      composerDraft: this.state.composerDraft,
      transcripts: Object.fromEntries(
        [...this.transcriptCache.entries()].map(([key, transcript]) => [key, transcript.slice(-120)]),
      ),
    };

    await mkdir(dirname(this.uiStateFilePath), { recursive: true });
    await writeFile(this.uiStateFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private emit(): DesktopAppState {
    const snapshot = cloneDesktopAppState(this.state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async withError(error: unknown): Promise<DesktopAppState> {
    const message = error instanceof Error ? error.message : String(error);
    this.state = {
      ...this.state,
      lastError: message,
      revision: this.state.revision + 1,
    };
    await this.persistUiState();
    return this.emit();
  }
}

function buildWorkspaceRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  sessions: readonly SessionCatalogEntry[],
  transcriptCache: Map<string, TranscriptMessage[]>,
): WorkspaceRecord[] {
  return workspaces.map((workspace) => {
    const workspaceSessions = sessions
      .filter((session) => session.workspaceId === workspace.workspaceId)
      .map<SessionRecord>((session) => buildSessionRecord(session, transcriptCache));

    return {
      id: workspace.workspaceId,
      name: workspace.displayName,
      path: workspace.path,
      lastOpenedAt: workspace.lastOpenedAt,
      sessions: workspaceSessions,
    };
  });
}

function buildSessionRecord(
  session: SessionCatalogEntry,
  transcriptCache: Map<string, TranscriptMessage[]>,
): SessionRecord {
  const transcript = transcriptCache.get(sessionKey(session.sessionRef)) ?? [];
  const preview = transcript.at(-1)?.text ?? session.previewSnippet ?? session.title;
  return {
    id: session.sessionRef.sessionId,
    title: session.title,
    updatedAt: session.updatedAt,
    preview,
    status: session.status,
    transcript: transcript.map(cloneTranscriptMessage),
  };
}

function resolveSelectedWorkspaceId(preferredWorkspaceId: string, workspaces: readonly WorkspaceRecord[]): string {
  if (preferredWorkspaceId && workspaces.some((workspace) => workspace.id === preferredWorkspaceId)) {
    return preferredWorkspaceId;
  }
  return workspaces[0]?.id ?? "";
}

function resolveSelectedSessionId(
  workspaceId: string,
  preferredSessionId: string,
  workspaces: readonly WorkspaceRecord[],
): string {
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return "";
  }

  if (preferredSessionId && workspace.sessions.some((session) => session.id === preferredSessionId)) {
    return preferredSessionId;
  }

  return workspace.sessions[0]?.id ?? "";
}

function workspaceRefFromPath(path: string): WorkspaceRef {
  const normalizedPath = path.trim();
  const displayName = basename(normalizedPath) || normalizedPath;
  return {
    workspaceId: normalizedPath,
    path: normalizedPath,
    displayName,
  };
}

function toSessionRef(target: WorkspaceSessionTarget): SessionRef {
  return {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
  };
}

function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

function makeTranscriptMessage(role: SessionRole, text: string): TranscriptMessage {
  return {
    id: randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
  };
}

function cloneTranscriptMessage(message: TranscriptMessage): TranscriptMessage {
  return {
    ...message,
  };
}
