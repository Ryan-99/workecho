import { basename } from "node:path";
import type { SessionErrorInfo, SessionRef, SessionSnapshot, SessionStatus, WorkspaceRef } from "@pi-app/session-driver";

export interface SnapshotSource {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: string;
  readonly preview: string | undefined;
  readonly runningRunId: string | undefined;
}

export function buildSnapshot(source: SnapshotSource): SessionSnapshot {
  return {
    ref: { ...source.ref },
    workspace: { ...source.workspace },
    title: source.title.trim() || deriveWorkspaceTitle(source.workspace),
    status: source.status,
    updatedAt: source.updatedAt,
    ...(source.preview !== undefined ? { preview: source.preview } : {}),
    ...(source.runningRunId !== undefined ? { runningRunId: source.runningRunId } : {}),
  };
}

export function sessionKey(sessionRef: SessionRef): string {
  return `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
}

export function workspaceToRef(workspace: { workspaceId: string; path: string; displayName: string }): WorkspaceRef {
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    displayName: workspace.displayName,
  };
}

export function deriveWorkspaceTitle(workspace: WorkspaceRef): string {
  return workspace.displayName?.trim() || basename(workspace.path) || workspace.path;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function extractPreview(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") {
    return truncate(content);
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join(" ")
      .trim();
    return text ? truncate(text) : undefined;
  }

  if (typeof message.stopReason === "string" && typeof message.errorMessage === "string") {
    return truncate(message.errorMessage);
  }

  return undefined;
}

export function determineRunOutcome(messages: readonly unknown[]): {
  success: boolean;
  error?: SessionErrorInfo;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }

    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      const messageText =
        typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
          ? message.errorMessage
          : stopReason === "aborted"
            ? "Run aborted"
            : "Run failed";
      return {
        success: false,
        error: {
          message: messageText,
          code: stopReason.toUpperCase(),
        },
      };
    }
    break;
  }

  return { success: true };
}

export function toSessionErrorInfo(error: unknown, code: string): SessionErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      code,
      details: {
        name: error.name,
        stack: error.stack,
      },
    };
  }

  return {
    message: typeof error === "string" ? error : "Unknown error",
    code,
    details: error,
  };
}

export function truncate(value: string, limit = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
