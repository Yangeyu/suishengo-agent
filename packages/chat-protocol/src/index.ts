import type { UIMessage, UIMessageChunk } from "ai";

export type ChatMetadata = { runId: string; schemaVersion: 1 };
export type ChatData = {
  perks: { items: { perkId: string; reason: string }[] };
  ticket: { ticketId: string; status: "pending" | "verified" | "rejected" };
};
export type ChatMessage = UIMessage<ChatMetadata, ChatData>;
export type ChatChunk = UIMessageChunk<ChatMetadata, ChatData>;
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
}
export interface Run {
  id: string;
  sessionId: string;
  requestId: string;
  assistantId: string;
  status: RunStatus;
  sequence: number;
}
export interface SessionSnapshot {
  session: SessionSummary;
  messages: ChatMessage[];
  activeRun: Run | null;
}
