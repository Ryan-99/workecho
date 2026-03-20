import { randomUUID } from "node:crypto";
import type { SessionCatalogEntry, WorkspaceCatalogEntry } from "@pi-app/catalogs";
import type { SessionRef } from "@pi-app/session-driver";
import type {
  SessionRecord,
  SessionRole,
  TranscriptMessage,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "../src/desktop-state";

export function buildWorkspaceRecords(
  workspaces: readonly WorkspaceCatalogEntry[],
  sessions: readonly SessionCatalogEntry[],
  transcriptCache: Map<string, TranscriptMessage[]>,
): WorkspaceRecord[] {
  return workspaces.map((workspace) => ({
    id: workspace.workspaceId,
    name: workspace.displayName,
    path: workspace.path,
    lastOpenedAt: workspace.lastOpenedAt,
    sessions: sessions
      .filter((session) => session.workspaceId === workspace.workspaceId)
      .map((session) => buildSessionRecord(session, transcriptCache)),
  }));
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

export function resolveSelectedWorkspaceId(
  preferredWorkspaceId: string,
  workspaces: readonly WorkspaceRecord[],
): string {
  if (preferredWorkspaceId && workspaces.some((workspace) => workspace.id === preferredWorkspaceId)) {
    return preferredWorkspaceId;
  }
  return workspaces[0]?.id ?? "";
}

export function resolveSelectedSessionId(
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

export function toSessionRef(target: WorkspaceSessionTarget): SessionRef {
  return {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
  };
}

export function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

export function makeTranscriptMessage(role: SessionRole, text: string): TranscriptMessage {
  return {
    id: randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
  };
}

export function cloneTranscriptMessage(message: TranscriptMessage): TranscriptMessage {
  return { ...message };
}
