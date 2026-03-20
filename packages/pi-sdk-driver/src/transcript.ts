export type SessionTranscriptRole = "user" | "assistant";

export interface SessionTranscriptMessage {
  readonly kind: "message";
  readonly role: SessionTranscriptRole;
  readonly text: string;
  readonly createdAt: string;
  readonly id: string;
}
