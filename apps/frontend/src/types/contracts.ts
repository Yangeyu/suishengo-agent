import type { Run, SessionSummary } from "@harness/sessions";
import type { UIMessage } from "ai";

export type { SessionSummary };
export type MessageMetadata = { runId: string; schemaVersion: 1 };
export type ChatMessage = UIMessage<MessageMetadata>;
export interface ChatSnapshot {
  session: SessionSummary;
  messages: ChatMessage[];
  activeRun: Run | null;
}
