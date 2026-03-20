declare module "@pi-app/catalogs" {
  import type { SessionRef, WorkspaceId } from "@pi-app/session-driver";

  export type { SessionRef, WorkspaceId };

  export interface WorkspaceCatalogEntry {
    workspaceId: WorkspaceId;
    path: string;
    displayName: string;
    lastOpenedAt: string;
    sortOrder: number;
    pinned?: boolean;
  }

  export type SessionStatus = "idle" | "running" | "failed";

  export interface SessionCatalogEntry {
    sessionRef: SessionRef;
    workspaceId: WorkspaceId;
    title: string;
    updatedAt: string;
    previewSnippet?: string;
    sessionFilePath?: string;
    status: SessionStatus;
  }

  export interface WorkspaceCatalogSnapshot {
    workspaces: WorkspaceCatalogEntry[];
  }

  export interface SessionCatalogSnapshot {
    sessions: SessionCatalogEntry[];
  }

  export interface WorkspaceCatalogStorage {
    listWorkspaces(): Promise<WorkspaceCatalogSnapshot>;
    getWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceCatalogEntry | undefined>;
    upsertWorkspace(entry: WorkspaceCatalogEntry): Promise<void>;
    deleteWorkspace(workspaceId: WorkspaceId): Promise<void>;
  }

  export interface SessionCatalogStorage {
    listSessions(workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot>;
    getSession(sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined>;
    upsertSession(entry: SessionCatalogEntry): Promise<void>;
    deleteSession(sessionRef: SessionRef): Promise<void>;
  }

  export interface CatalogStorage {
    workspaces: WorkspaceCatalogStorage;
    sessions: SessionCatalogStorage;
  }
}
