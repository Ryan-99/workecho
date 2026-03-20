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
  status: SessionStatus;
}

export interface WorkspaceCatalogSnapshot {
  workspaces: WorkspaceCatalogEntry[];
}

export interface SessionCatalogSnapshot {
  sessions: SessionCatalogEntry[];
}
