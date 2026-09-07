export interface SessionTranscriptImageAttachment {
  readonly kind: "image";
  readonly mimeType: string;
  readonly data: string;
  readonly name?: string;
}

export interface SessionTranscriptFileAttachment {
  readonly kind: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly fsPath: string;
  readonly sizeBytes?: number;
}

export type SessionTranscriptAttachment = SessionTranscriptImageAttachment | SessionTranscriptFileAttachment;

export type SessionTranscriptRole = "user" | "assistant" | "branchSummary" | "compactionSummary";

export interface SessionTranscriptMessage {
  readonly kind: "message";
  readonly role: SessionTranscriptRole;
  readonly text: string;
  readonly attachments?: readonly SessionTranscriptAttachment[];
  readonly createdAt: string;
  readonly id: string;
}

export interface SessionTranscriptToolCall {
  readonly kind: "tool";
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  /** "error" also covers calls whose result never arrived (interrupted runs). */
  readonly status: "success" | "error";
  readonly input?: unknown;
  readonly output?: unknown;
  readonly createdAt: string;
}

/**
 * 一次运行失败（模型 API 报错等）：assistant 消息 stopReason=error 且没有正文。
 * 之前这类消息被静默丢弃，重开历史会话时完全看不到失败痕迹；现在如实带出
 * 原始错误文本，由渲染层做简短摘要 + 折叠展示。
 */
export interface SessionTranscriptError {
  readonly kind: "error";
  readonly id: string;
  readonly message: string;
  readonly createdAt: string;
}

export type SessionTranscriptItem = SessionTranscriptMessage | SessionTranscriptToolCall | SessionTranscriptError;
