export type SessionStatus = "idle" | "running" | "failed";
export type SessionRole = "user" | "assistant";

export interface TranscriptMessage {
  readonly id: string;
  readonly role: SessionRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly transcript: readonly TranscriptMessage[];
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lastOpenedAt: string;
  readonly sessions: readonly SessionRecord[];
}

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly selectedSessionId: string;
  readonly composerDraft: string;
  readonly revision: number;
  readonly lastError?: string;
}

export interface CreateSessionInput {
  readonly workspaceId: string;
  readonly title?: string;
}

export interface WorkspaceSessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export function createInitialDesktopAppState(): DesktopAppState {
  const workspaces = [
    createWorkspace("polymarket-agent", "polymarket-agent", "~/dev/polymarket-agent", "4h", [
      createSessionRecord("session-1", "Research Polymarket agent architecture", "4h", "idle", [
        createMessage("assistant", "Map the service boundaries and confirm the event model."),
        createMessage("user", "Review the agent architecture and identify the narrowest stable boundary."),
      ]),
    ]),
    createWorkspace("pi-app", "pi-app", "~/dev/pi-app", "57m", [
      createSessionRecord("session-2", "Explore pi mono repo", "4h", "running", [
        createMessage("assistant", "Investigate the SDK surface and where the driver should live."),
        createMessage("user", "Wire the desktop shell to a real state bridge and keep the Codex-style layout."),
      ]),
      createSessionRecord("session-3", "Interpret pi-mono tweet", "57m", "idle", [
        createMessage("assistant", "Summarize the product direction and next architecture steps."),
      ]),
    ]),
    createWorkspace("purposeproject", "purposeproject", "~/dev/purposeproject", "23h", [
      createSessionRecord("session-4", "Align app state with stitch q...", "23h", "failed", [
        createMessage("assistant", "Tighten state ownership before the next UI pass."),
      ]),
    ]),
    createWorkspace("openci", "openci", "~/dev/openci", "1d", [
      createSessionRecord("session-5", "Identify repo top priorities", "1d", "idle", [
        createMessage("assistant", "Rank the top issues and split them into P0/P1."),
      ]),
      createSessionRecord("session-6", "Can you spawn many subagents...", "1d", "idle", [
        createMessage("assistant", "Test parallel reviews and reassembly of findings."),
      ]),
      createSessionRecord("session-7", "reusme", "6d", "idle", [
        createMessage("assistant", "Recover the latest thread state and continue the run."),
      ]),
    ]),
  ];

  return {
    workspaces,
    selectedWorkspaceId: "pi-app",
    selectedSessionId: "session-2",
    composerDraft: "Read package.json and report only the name field",
    revision: 1,
  };
}

export function createEmptyDesktopAppState(): DesktopAppState {
  return {
    workspaces: [],
    selectedWorkspaceId: "",
    selectedSessionId: "",
    composerDraft: "",
    revision: 0,
  };
}

export function cloneDesktopAppState(state: DesktopAppState): DesktopAppState {
  return structuredClone(state);
}

export function getSelectedWorkspace(state: DesktopAppState): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

export function getSelectedSession(state: DesktopAppState): SessionRecord | undefined {
  return getSelectedWorkspace(state)?.sessions.find((session) => session.id === state.selectedSessionId);
}

export function selectWorkspace(state: DesktopAppState, workspaceId: string): DesktopAppState {
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    return state;
  }

  const workspaces = state.workspaces.map((entry) =>
    entry.id === workspaceId ? { ...entry, lastOpenedAt: "just now" } : entry,
  );

  return bumpRevision({
    ...state,
    workspaces,
    selectedWorkspaceId: workspaceId,
    selectedSessionId: workspace.sessions[0]?.id ?? "",
  });
}

export function selectSession(state: DesktopAppState, target: WorkspaceSessionTarget): DesktopAppState {
  const workspace = state.workspaces.find((entry) => entry.id === target.workspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === target.sessionId);
  if (!workspace || !session) {
    return state;
  }

  const workspaces = state.workspaces.map((entry) =>
    entry.id === workspace.id ? { ...entry, lastOpenedAt: "just now" } : entry,
  );

  return bumpRevision({
    ...state,
    workspaces,
    selectedWorkspaceId: workspace.id,
    selectedSessionId: session.id,
  });
}

export function createSession(state: DesktopAppState, input: CreateSessionInput): DesktopAppState {
  const workspaceIndex = state.workspaces.findIndex((entry) => entry.id === input.workspaceId);
  if (workspaceIndex < 0) {
    return state;
  }

  const workspace = state.workspaces[workspaceIndex];
  if (!workspace) {
    return state;
  }

  const sessionId = `session-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const title = input.title?.trim() || `New thread ${workspace.sessions.length + 1}`;
  const session: SessionRecord = {
    id: sessionId,
    title,
    updatedAt: "just now",
    preview: "Ready to continue.",
    status: "idle",
    transcript: [createMessage("assistant", "Session created. Start with a prompt to continue the thread.")],
  };

  const workspaces: WorkspaceRecord[] = state.workspaces.slice();
  workspaces[workspaceIndex] = {
    ...workspace,
    lastOpenedAt: "just now",
    sessions: [session, ...workspace.sessions],
  };

  return bumpRevision({
    ...state,
    workspaces,
    selectedWorkspaceId: workspace.id,
    selectedSessionId: session.id,
    composerDraft: "",
    lastError: undefined,
  });
}

export function updateComposerDraft(state: DesktopAppState, composerDraft: string): DesktopAppState {
  return bumpRevision({
    ...state,
    composerDraft,
  });
}

export function submitComposerDraft(state: DesktopAppState): DesktopAppState {
  const text = state.composerDraft.trim();
  if (!text) {
    return state;
  }

  const target = findSessionTarget(state, {
    workspaceId: state.selectedWorkspaceId,
    sessionId: state.selectedSessionId,
  });
  if (!target) {
    return state;
  }

  const message = createMessage("user", text);
  const workspaces: WorkspaceRecord[] = state.workspaces.map((workspace) => {
    if (workspace.id !== target.workspace.id) {
      return workspace;
    }

    return {
      ...workspace,
      lastOpenedAt: "just now",
      sessions: workspace.sessions.map((session) => {
        if (session.id !== target.session.id) {
          return session;
        }

        return {
          ...session,
          updatedAt: "just now",
          preview: text,
          status: "idle",
          transcript: [...session.transcript, message],
        };
      }),
    };
  });

  return bumpRevision({
    ...state,
    workspaces,
    composerDraft: "",
    lastError: undefined,
  });
}

export function findSessionTarget(
  state: DesktopAppState,
  target: WorkspaceSessionTarget,
): { workspace: WorkspaceRecord; session: SessionRecord } | undefined {
  const workspace = state.workspaces.find((entry) => entry.id === target.workspaceId);
  if (!workspace) {
    return undefined;
  }

  const session = workspace.sessions.find((entry) => entry.id === target.sessionId);
  if (!session) {
    return undefined;
  }

  return { workspace, session };
}

function bumpRevision(state: DesktopAppState): DesktopAppState {
  return {
    ...state,
    revision: state.revision + 1,
  };
}

function createWorkspace(
  id: string,
  name: string,
  path: string,
  lastOpenedAt: string,
  sessions: readonly SessionRecord[],
): WorkspaceRecord {
  return {
    id,
    name,
    path,
    lastOpenedAt,
    sessions,
  };
}

function createSessionRecord(
  id: string,
  title: string,
  updatedAt: string,
  status: SessionStatus,
  transcript: readonly TranscriptMessage[],
): SessionRecord {
  const preview = transcript.at(-1)?.text ?? title;
  return {
    id,
    title,
    updatedAt,
    preview,
    status,
    transcript,
  };
}

function createMessage(role: SessionRole, text: string): TranscriptMessage {
  return {
    id: globalThis.crypto.randomUUID(),
    role,
    text,
    createdAt: nowIso(),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
