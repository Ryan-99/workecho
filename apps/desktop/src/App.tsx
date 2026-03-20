import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
} from "./desktop-state";

function useDesktopAppState() {
  const [snapshot, setSnapshot] = useState<DesktopAppState | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.piApp;
    if (!api) {
      return undefined;
    }

    void api.getState().then((state) => {
      if (active) {
        setSnapshot(state);
      }
    });

    const unsubscribe = api.onStateChanged((state) => {
      if (active) {
        setSnapshot(state);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return [snapshot, setSnapshot] as const;
}

function statusLabel(status: SessionRecord["status"]): string {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

function formatRelativeTime(value: string): string {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString();
}

function updateSnapshot(
  api: NonNullable<typeof window.piApp>,
  setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
  action: () => Promise<DesktopAppState>,
): Promise<void> {
  return action().then((state) => {
    setSnapshot(state);
  });
}

export default function App() {
  const [snapshot, setSnapshot] = useDesktopAppState();
  const api = window.piApp;

  if (!api || !snapshot) {
    return (
      <div className="shell shell--loading">
        <main className="loading-card">
          <div className="loading-card__eyebrow">pi desktop</div>
          <h1>Loading workspace catalog</h1>
          <p>
            The desktop shell is restoring folder and session state from the main process before the Codex-style UI
            becomes interactive.
          </p>
        </main>
      </div>
    );
  }

  const selectedWorkspace = getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0];
  const selectedSession = getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="brand">
            <div className="brand__mark">pi</div>
            <div>
              <div className="brand__name">pi desktop</div>
              <div className="brand__sub">workspace-driven sessions</div>
            </div>
          </div>

          <div className="sidebar__actions">
            <button
              className="sidebar__new"
              type="button"
              disabled={!selectedWorkspace}
              onClick={() => {
                if (!selectedWorkspace) {
                  return;
                }
                void updateSnapshot(api, setSnapshot, () =>
                  api.createSession({ workspaceId: selectedWorkspace.id, title: "New thread" }),
                );
              }}
            >
              New thread
            </button>
            <button
              className="sidebar__secondary"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              Open folder
            </button>
          </div>

          <nav className="rail">
            <a className="rail__item rail__item--active" href="#threads">
              Threads
            </a>
            <a className="rail__item" href="#automations">
              Automations
            </a>
            <a className="rail__item" href="#skills">
              Skills
            </a>
          </nav>
        </div>

        <div className="sidebar__section">
          <div className="section__head">
            <span>Threads</span>
            <div className="section__tools">
              <button
                aria-label="Open workspace"
                className="icon-button"
                type="button"
                onClick={() => {
                  void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
                }}
              >
                +
              </button>
            </div>
          </div>

          {snapshot.workspaces.length === 0 ? (
            <div className="empty-state" data-testid="empty-state">
              <h2>No folders yet</h2>
              <p>Open a project folder to start building a Codex-style workspace and session list.</p>
              <button
                className="chip"
                type="button"
                onClick={() => {
                  void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
                }}
              >
                Open first folder
              </button>
            </div>
          ) : (
            <div className="workspace-list" data-testid="workspace-list">
              {snapshot.workspaces.map((workspace: WorkspaceRecord) => {
                const workspaceActive = workspace.id === selectedWorkspace?.id;
                return (
                  <div key={workspace.id} className="workspace-card">
                    <button
                      className={`workspace-card__header ${workspaceActive ? "workspace-card__header--active" : ""}`}
                      onClick={() => {
                        void updateSnapshot(api, setSnapshot, () => api.selectWorkspace(workspace.id));
                      }}
                      type="button"
                    >
                      <span className="workspace-card__folder" aria-hidden="true">
                        ⌂
                      </span>
                      <span className="workspace-card__name">{workspace.name}</span>
                      <span className="workspace-card__time">{formatRelativeTime(workspace.lastOpenedAt)}</span>
                    </button>
                    <div className="workspace-card__path">{workspace.path}</div>

                    <div className="session-list">
                      {workspace.sessions.map((session) => {
                        const active = workspace.id === selectedWorkspace?.id && session.id === selectedSession?.id;
                        return (
                          <button
                            key={session.id}
                            className={`session-row ${active ? "session-row--active" : ""}`}
                            onClick={() => {
                              void updateSnapshot(api, setSnapshot, () =>
                                api.selectSession({ workspaceId: workspace.id, sessionId: session.id }),
                              );
                            }}
                            type="button"
                          >
                            <span className={`session-row__status session-row__status--${session.status}`} />
                            <span className="session-row__body">
                              <span className="session-row__title">{session.title}</span>
                              <span className="session-row__preview">{session.preview}</span>
                            </span>
                            <span className="session-row__time">{formatRelativeTime(session.updatedAt)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar__footer">
          <div className="sidebar__settings">
            <span className="sidebar__settings-mark">⚙</span>
            <span>Settings</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar__title">
            {selectedWorkspace && selectedSession ? (
              <>
                <span className="topbar__workspace">{selectedWorkspace.name}</span>
                <span className="topbar__separator">/</span>
                <span className="topbar__session">{selectedSession.title}</span>
              </>
            ) : (
              <span className="topbar__workspace">Open a folder to begin</span>
            )}
          </div>

          <div className="topbar__actions">
            <button
              className="chip chip--ghost"
              type="button"
              onClick={() => {
                void api.getState().then(setSnapshot);
              }}
            >
              Sync
            </button>
            <button
              className="chip"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              Add folder
            </button>
          </div>
        </header>

        {selectedWorkspace && selectedSession ? (
          <>
            <section className="canvas">
              <div className="canvas__hero">
                <div className="hero__eyebrow">Session</div>
                <h1>{selectedSession.title}</h1>
                <p>{selectedSession.preview}</p>
                <div className="hero__badges">
                  <span className="badge badge--soft">Local</span>
                  <span className={`badge badge--${selectedSession.status}`}>{statusLabel(selectedSession.status)}</span>
                  <span className="badge badge--soft">{selectedWorkspace.path}</span>
                </div>
              </div>

              {snapshot.lastError ? <div className="error-banner">{snapshot.lastError}</div> : null}

              <div className="timeline" data-testid="transcript">
                {selectedSession.transcript.length === 0 ? (
                  <article className="message message--assistant">
                    <div className="message__role">assistant</div>
                    <p>Start with a prompt to continue this thread.</p>
                  </article>
                ) : (
                  selectedSession.transcript.map((message) => (
                    <article className={`message message--${message.role}`} key={message.id}>
                      <div className="message__meta">
                        <span className="message__role">{message.role}</span>
                        <span className="message__time">{formatRelativeTime(message.createdAt)}</span>
                      </div>
                      <p>{message.text}</p>
                    </article>
                  ))
                )}
              </div>
            </section>

            <footer className="composer">
              <div className="composer__prompt">
                <div className="composer__label">Composer</div>
                <textarea
                  aria-label="Composer"
                  data-testid="composer"
                  value={snapshot.composerDraft}
                  onChange={(event) => {
                    void updateSnapshot(api, setSnapshot, () => api.updateComposerDraft(event.target.value));
                  }}
                  placeholder="Ask pi to inspect the repo, run a fix, or continue the current thread..."
                />
              </div>

              <div className="composer__bar">
                <div className="composer__meta">
                  <span className="badge badge--soft">{api.platform}</span>
                  <span className="badge badge--soft">Revision {snapshot.revision}</span>
                  <span className="badge badge--soft">{formatRelativeTime(selectedSession.updatedAt)}</span>
                </div>

                <div className="composer__buttons">
                  <button className="chip chip--ghost" type="button">
                    Attach
                  </button>
                  <button
                    className="chip"
                    data-testid="send"
                    type="button"
                    onClick={() => {
                      void updateSnapshot(api, setSnapshot, () => api.submitComposerDraft());
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            </footer>
          </>
        ) : selectedWorkspace ? (
          <section className="canvas canvas--empty">
            <div className="canvas__hero">
              <div className="hero__eyebrow">Workspace</div>
              <h1>{selectedWorkspace.name}</h1>
              <p>Create a thread for this folder, then jump between sessions from the sidebar.</p>
              <div className="hero__badges">
                <span className="badge badge--soft">{selectedWorkspace.path}</span>
                <span className="badge badge--soft">{formatRelativeTime(selectedWorkspace.lastOpenedAt)}</span>
              </div>
              <div className="topbar__actions">
                <button
                  className="chip"
                  type="button"
                  onClick={() => {
                    void updateSnapshot(api, setSnapshot, () =>
                      api.createSession({ workspaceId: selectedWorkspace.id, title: "New thread" }),
                    );
                  }}
                >
                  New thread
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="canvas canvas--empty">
            <div className="canvas__hero">
              <div className="hero__eyebrow">Workspace</div>
              <h1>Open a folder to start</h1>
              <p>Add project folders, group sessions under them, and jump between threads from the sidebar.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
