export type SessionTranscriptRole = "user" | "assistant";

export interface SessionTranscriptMessage {
  readonly id: string;
  readonly role: SessionTranscriptRole;
  readonly text: string;
  readonly createdAt: string;
}
