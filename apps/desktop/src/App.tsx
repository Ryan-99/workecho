import { useEffect, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import {
  getSelectedSession,
  getSelectedWorkspace,
  type DesktopAppState,
  type SessionRecord,
  type WorkspaceRecord,
} from "./desktop-state";
import { ClockIcon, FolderIcon, PlusIcon, SettingsIcon, SparkIcon } from "./icons";
import { MessageMarkdown } from "./message-markdown";

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
) {
  return action().then((state) => {
    setSnapshot(state);
    return state;
  });
}

export default function App() {
  const [snapshot, setSnapshot] = useDesktopAppState();
  const [composerDraft, setComposerDraft] = useState("");
  const api = window.piApp;

  const selectedWorkspace = snapshot ? (getSelectedWorkspace(snapshot) ?? snapshot.workspaces[0]) : undefined;
  const selectedSession = snapshot ? (getSelectedSession(snapshot) ?? selectedWorkspace?.sessions[0]) : undefined;
  const selectedSessionKey = `${selectedWorkspace?.id ?? ""}:${selectedSession?.id ?? ""}`;

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setComposerDraft(snapshot.composerDraft);
  }, [selectedSessionKey, snapshot]);

  useEffect(() => {
    if (!api || !snapshot || composerDraft === snapshot.composerDraft) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      void updateSnapshot(api, setSnapshot, () => api.updateComposerDraft(composerDraft));
    }, 350);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [api, composerDraft, setSnapshot, snapshot]);

  if (!api || !snapshot) {
    return (
      <div className="shell shell--loading">
        <main className="loading-card">
          <div className="loading-card__eyebrow">pi-app</div>
          <h1>Loading sessions</h1>
          <p>The desktop shell is restoring folder and thread state from the main process.</p>
        </main>
      </div>
    );
  }

  const submitComposerDraft = () => {
    void (async () => {
      if (composerDraft !== snapshot.composerDraft) {
        await updateSnapshot(api, setSnapshot, () => api.updateComposerDraft(composerDraft));
      }
      const nextState = await updateSnapshot(api, setSnapshot, () => api.submitComposerDraft());
      setComposerDraft(nextState.composerDraft);
    })();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!composerDraft.trim()) {
      return;
    }

    submitComposerDraft();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__top">
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
            <PlusIcon />
            <span>New thread</span>
          </button>

          <nav className="rail" aria-label="Primary">
            <button className="rail__item rail__item--active" disabled type="button">
              <FolderIcon />
              <span>Threads</span>
            </button>
            <button className="rail__item" disabled type="button">
              <ClockIcon />
              <span>Automations</span>
            </button>
            <button className="rail__item" disabled type="button">
              <SparkIcon />
              <span>Skills</span>
            </button>
          </nav>
        </div>

        <div className="sidebar__section">
          <div className="section__head">
            <span>Threads</span>
            <div className="section__tools">
              <button
                aria-label="Open folder"
                className="icon-button"
                type="button"
                onClick={() => {
                  void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
                }}
              >
                <FolderIcon />
              </button>
            </div>
          </div>

          {snapshot.workspaces.length === 0 ? (
            <div className="empty-state" data-testid="empty-state">
              <h2>No folders yet</h2>
              <p>Open a project folder to start building a workspace and session list.</p>
              <button
                className="button button--primary"
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
                  <section key={workspace.id} className="workspace-group">
                    <button
                      className={`workspace-row ${workspaceActive ? "workspace-row--active" : ""}`}
                      onClick={() => {
                        void updateSnapshot(api, setSnapshot, () => api.selectWorkspace(workspace.id));
                      }}
                      type="button"
                    >
                      <span className="workspace-row__icon" aria-hidden="true">
                        <FolderIcon />
                      </span>
                      <span className="workspace-row__name">{workspace.name}</span>
                      <span className="workspace-row__time">{formatRelativeTime(workspace.lastOpenedAt)}</span>
                    </button>
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
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="sidebar__footer">
          <div className="sidebar__settings">
            <span className="sidebar__settings-mark">
              <SettingsIcon />
            </span>
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
              className="button button--ghost"
              type="button"
              onClick={() => {
                void updateSnapshot(api, setSnapshot, () => api.pickWorkspace());
              }}
            >
              <FolderIcon />
              <span>Add folder</span>
            </button>
          </div>
        </header>

        {selectedWorkspace && selectedSession ? (
          <>
            <section className="canvas">
              <div className="session-header">
                <div className="session-header__copy">
                  <div className="session-header__eyebrow">Session</div>
                  <h1>{selectedSession.title}</h1>
                  <p>{selectedSession.preview}</p>
                </div>

                <div className="session-header__meta">
                  <span className="meta-chip">Local</span>
                  <span className="meta-chip">{statusLabel(selectedSession.status)}</span>
                  <span className="meta-chip meta-chip--path">{selectedWorkspace.path}</span>
                </div>
              </div>

              {snapshot.lastError ? <div className="error-banner">{snapshot.lastError}</div> : null}

              <div className="timeline-pane">
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
                        <MessageMarkdown text={message.text} />
                      </article>
                    ))
                  )}
                </div>
              </div>
            </section>

            <footer className="composer">
              <div className="composer__prompt">
                <textarea
                  aria-label="Composer"
                  data-testid="composer"
                  value={composerDraft}
                  onChange={(event) => {
                    setComposerDraft(event.target.value);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Ask pi to inspect the repo, run a fix, or continue the current thread..."
                />
              </div>

              <div className="composer__bar">
                <div className="composer__meta">
                  <span className="meta-chip">{api.platform}</span>
                  <span className="meta-chip">Revision {snapshot.revision}</span>
                  <span className="meta-chip">{formatRelativeTime(selectedSession.updatedAt)}</span>
                </div>

                <div className="composer__buttons">
                  <button className="button button--ghost" disabled type="button">
                    Attach
                  </button>
                  <button
                    className="button button--primary"
                    data-testid="send"
                    type="button"
                    onClick={submitComposerDraft}
                  >
                    Send
                  </button>
                </div>
              </div>
            </footer>
          </>
        ) : selectedWorkspace ? (
          <section className="canvas canvas--empty">
            <div className="empty-panel">
              <div className="session-header__eyebrow">Workspace</div>
              <h1>{selectedWorkspace.name}</h1>
              <p>Create a thread for this folder, then jump between sessions from the sidebar.</p>
              <div className="empty-panel__meta">
                <span className="meta-chip meta-chip--path">{selectedWorkspace.path}</span>
                <span className="meta-chip">{formatRelativeTime(selectedWorkspace.lastOpenedAt)}</span>
              </div>
              <div className="empty-panel__actions">
                <button
                  className="button button--primary"
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
            <div className="empty-panel">
              <div className="session-header__eyebrow">Workspace</div>
              <h1>Open a folder to start</h1>
              <p>Add project folders, group sessions under them, and jump between threads from the sidebar.</p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
