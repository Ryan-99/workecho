import type {
  CatalogStorage,
  SessionCatalogEntry,
  SessionCatalogSnapshot,
  SessionRef,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
  WorkspaceId,
} from "@pi-app/catalogs";

export class MemoryCatalogStore implements CatalogStorage {
  private readonly workspacesById = new Map<WorkspaceId, WorkspaceCatalogEntry>();
  private readonly sessionsByKey = new Map<string, SessionCatalogEntry>();

  readonly workspaces = {
    listWorkspaces: async (): Promise<WorkspaceCatalogSnapshot> => ({
      workspaces: [...this.workspacesById.values()].sort(compareWorkspaceEntries),
    }),
    getWorkspace: async (workspaceId: WorkspaceId): Promise<WorkspaceCatalogEntry | undefined> =>
      this.workspacesById.get(workspaceId),
    upsertWorkspace: async (entry: WorkspaceCatalogEntry): Promise<void> => {
      this.workspacesById.set(entry.workspaceId, { ...entry });
    },
    deleteWorkspace: async (workspaceId: WorkspaceId): Promise<void> => {
      this.workspacesById.delete(workspaceId);
    },
  };

  readonly sessions = {
    listSessions: async (workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> => {
      const sessions = [...this.sessionsByKey.values()]
        .filter((entry) => (workspaceId ? entry.workspaceId === workspaceId : true))
        .sort(compareSessionEntries);
      return { sessions };
    },
    getSession: async (sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined> =>
      this.sessionsByKey.get(sessionRefKey(sessionRef)),
    upsertSession: async (entry: SessionCatalogEntry): Promise<void> => {
      this.sessionsByKey.set(sessionRefKey(entry.sessionRef), { ...entry });
    },
    deleteSession: async (sessionRef: SessionRef): Promise<void> => {
      this.sessionsByKey.delete(sessionRefKey(sessionRef));
    },
  };
}

function sessionRefKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

function compareWorkspaceEntries(left: WorkspaceCatalogEntry, right: WorkspaceCatalogEntry): number {
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
}

function compareSessionEntries(left: SessionCatalogEntry, right: SessionCatalogEntry): number {
  const statusRank = rankSessionStatus(left.status) - rankSessionStatus(right.status);
  if (statusRank !== 0) return statusRank;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function rankSessionStatus(status: SessionCatalogEntry["status"]): number {
  if (status === "running") return 0;
  if (status === "idle") return 1;
  return 2;
}
