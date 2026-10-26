import type { Actor } from "@harness/scope";
import type { AgentMessage } from "@harness/messages";
import type { AgentEvent, RunEvent, RunStatus } from "@harness/events";

export interface StoredMessage {
  id: string;
  runId: string;
  ordinal: number;
  step: number | null;
  status: "streaming" | "complete" | "interrupted";
  message: AgentMessage;
  openPart: { id: string; index: number; kind: "text" | "reasoning" } | null;
}

export interface HistoryTurn {
  runId: string;
  position: number;
  completed: boolean;
  messages: AgentMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
}

export interface Run {
  id: string;
  sessionId: string;
  requestId: string;
  userMessageId: string;
  position: number;
  status: RunStatus;
  sequence: number;
}

export interface SessionSnapshot {
  session: SessionSummary;
  turns: { run: Run; messages: StoredMessage[] }[];
  activeRun: Run | null;
}

export type SessionSearchResult = {
  matches: {
    messageId: string;
    runId: string;
    position: number;
    role: "user" | "assistant";
    excerpt: string;
    truncated: boolean;
  }[];
  hasMore: boolean;
};

export interface Sessions {
  create(actor: Actor, title: string): Promise<SessionSummary>;
  list(actor: Actor): Promise<SessionSummary[]>;
  snapshot(actor: Actor, sessionId: string): Promise<SessionSnapshot>;
  admit(
    actor: Actor,
    input: { sessionId: string; requestId: string; text: string; userMessageId: string },
  ): Promise<{ run: Run; created: boolean }>;
  getRun(actor: Actor, runId: string): Promise<Run>;
  search(
    actor: Actor,
    runId: string,
    input: { query: string; limit?: number },
    signal: AbortSignal,
  ): Promise<SessionSearchResult>;
  history(
    actor: Actor,
    run: Run,
    range?: { after?: number; before?: number; limit?: number },
  ): Promise<HistoryTurn[]>;
  append(run: Run, event: AgentEvent): Promise<void>;
  finish(run: Run, status: Exclude<RunStatus, "running">): Promise<void>;
  events(actor: Actor, runId: string, after: number): Promise<RunEvent[]>;
  recover(): Promise<void>;
}
