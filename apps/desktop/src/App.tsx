import { useState } from "react";

type SessionStatus = "idle" | "running" | "failed";

type Session = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  status: SessionStatus;
};

type Workspace = {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
  sessions: Session[];
};

const workspaces: Workspace[] = [
  {
    id: "polymarket-agent",
    name: "polymarket-agent",
    path: "~/dev/polymarket-agent",
    lastOpened: "4h",
    sessions: [
      {
        id: "session-1",
        title: "Research Polymarket agent architecture",
        updatedAt: "4h",
        preview: "Map the service boundaries and confirm the event model.",
        status: "idle",
      },
    ],
  },
  {
    id: "pi-app",
    name: "pi-app",
    path: "~/dev/pi-app",
    lastOpened: "57m",
    sessions: [
      {
        id: "session-2",
        title: "Explore pi mono repo",
        updatedAt: "4h",
        preview: "Investigate the SDK surface and where the driver should live.",
        status: "running",
      },
      {
        id: "session-3",
        title: "Interpret pi-mono tweet",
        updatedAt: "57m",
        preview: "Summarize the product direction and next architecture steps.",
        status: "idle",
      },
    ],
  },
  {
    id: "purposeproject",
    name: "purposeproject",
    path: "~/dev/purposeproject",
    lastOpened: "23h",
    sessions: [
      {
        id: "session-4",
        title: "Align app state with stitch q...",
        updatedAt: "23h",
        preview: "Tighten state ownership before the next UI pass.",
        status: "failed",
      },
    ],
  },
  {
    id: "openci",
    name: "openci",
    path: "~/dev/openci",
    lastOpened: "1d",
    sessions: [
      {
        id: "session-5",
        title: "Identify repo top priorities",
        updatedAt: "1d",
        preview: "Rank the top issues and split them into P0/P1.",
        status: "idle",
      },
      {
        id: "session-6",
        title: "Can you spawn many subagents...",
        updatedAt: "1d",
        preview: "Test parallel reviews and reassembly of findings.",
        status: "idle",
      },
      {
        id: "session-7",
        title: "reusme",
        updatedAt: "6d",
        preview: "Recover the latest thread state and continue the run.",
        status: "idle",
      },
    ],
  },
];

const transcript = [
  {
    role: "user",
    text: "Explore the pi mono repo and identify the smallest durable boundary for a desktop app.",
  },
  {
    role: "assistant",
    text: "Use the SDK surface for the first pass, keep the UI boundary thin, and defer the official websocket server swap behind a catalog-driven session layer.",
  },
  {
    role: "assistant",
    text: "The current focus is shell parity, folder/session navigation, and a single end-to-end run in the desktop app.",
  },
];

function statusLabel(status: SessionStatus): string {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

export default function App() {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaces[1]?.id ?? workspaces[0]?.id ?? "");
  const [selectedSessionId, setSelectedSessionId] = useState(
    workspaces[1]?.sessions[0]?.id ?? workspaces[0]?.sessions[0]?.id ?? "",
  );
  const [draft, setDraft] = useState("Read package.json and report only the name field");

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0];

  if (!selectedWorkspace) {
    return null;
  }

  const selectedSession =
    selectedWorkspace.sessions.find((session) => session.id === selectedSessionId) ??
    selectedWorkspace.sessions[0];

  if (!selectedSession) {
    return null;
  }

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

          <button className="sidebar__new">New thread</button>

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
            <span className="section__meta">folders</span>
          </div>

          <div className="workspace-list">
            {workspaces.map((workspace) => {
              const workspaceActive = workspace.id === selectedWorkspaceId;
              return (
                <div key={workspace.id} className="workspace-card">
                  <button
                    className={`workspace-card__header ${workspaceActive ? "workspace-card__header--active" : ""}`}
                    onClick={() => {
                      setSelectedWorkspaceId(workspace.id);
                      setSelectedSessionId(workspace.sessions[0]?.id ?? "");
                    }}
                    type="button"
                  >
                    <span className="workspace-card__folder" aria-hidden="true">
                      ⌂
                    </span>
                    <span className="workspace-card__name">{workspace.name}</span>
                    <span className="workspace-card__time">{workspace.lastOpened}</span>
                  </button>

                  <div className="session-list">
                    {workspace.sessions.map((session) => {
                      const active = workspace.id === selectedWorkspaceId && session.id === selectedSessionId;
                      return (
                        <button
                          key={session.id}
                          className={`session-row ${active ? "session-row--active" : ""}`}
                          onClick={() => {
                            setSelectedWorkspaceId(workspace.id);
                            setSelectedSessionId(session.id);
                          }}
                          type="button"
                        >
                          <span className={`session-row__status session-row__status--${session.status}`} />
                          <span className="session-row__title">{session.title}</span>
                          <span className="session-row__time">{session.updatedAt}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
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
            <span className="topbar__workspace">{selectedWorkspace.name}</span>
            <span className="topbar__separator">/</span>
            <span className="topbar__session">{selectedSession.title}</span>
          </div>

          <div className="topbar__actions">
            <button className="chip chip--ghost" type="button">
              Sync
            </button>
            <button className="chip" type="button">
              Update
            </button>
          </div>
        </header>

        <section className="canvas">
          <div className="canvas__hero">
            <div className="hero__eyebrow">Session</div>
            <h1>{selectedSession.title}</h1>
            <p>{selectedSession.preview}</p>
            <div className="hero__badges">
              <span className="badge badge--soft">Local</span>
              <span className={`badge badge--${selectedSession.status}`}>{statusLabel(selectedSession.status)}</span>
              <span className="badge badge--soft">SDK driver</span>
            </div>
          </div>

          <div className="timeline">
            {transcript.map((message, index) => (
              <article className={`message message--${message.role}`} key={`${message.role}-${index}`}>
                <div className="message__role">{message.role}</div>
                <p>{message.text}</p>
              </article>
            ))}

            <article className="message message--assistant message--streaming">
              <div className="message__role">assistant</div>
              <p>
                I&apos;m wiring the workspace catalog, session catalog, and sidebar polish so the desktop shell feels
                close to the Codex app while staying compatible with the future server swap.
              </p>
            </article>
          </div>
        </section>

        <footer className="composer">
          <div className="composer__prompt">
            <div className="composer__label">Composer</div>
            <textarea
              aria-label="Composer"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask pi to inspect the repo, run a fix, or continue the current thread..."
            />
          </div>

          <div className="composer__bar">
            <div className="composer__meta">
              <span className="badge badge--soft">{window.piApp?.platform ?? "desktop"}</span>
              <span className="badge badge--soft">Session {selectedSession.updatedAt}</span>
            </div>

            <div className="composer__buttons">
              <button className="chip chip--ghost" type="button">
                Attach
              </button>
              <button className="chip" type="button">
                Send
              </button>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
