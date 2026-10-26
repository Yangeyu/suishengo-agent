import type { ChatChunk, ChatMessage, Run, RunStatus, SessionSnapshot, SessionSummary } from "@protocol";

export class ServiceError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
  }
}
export interface Actor { userId: string }
export interface ModelMessage { role: "user" | "assistant"; text: string }
export interface Model {
  generate(input: {
    system: string;
    messages: ModelMessage[];
    signal: AbortSignal;
    onText(delta: string): Promise<void>;
  }): Promise<void>;
}
export interface OutputEvent { sequence: number; chunk: ChatChunk }
export interface Sessions {
  create(actor: Actor, title: string): Promise<SessionSummary>;
  list(actor: Actor): Promise<SessionSummary[]>;
  snapshot(actor: Actor, sessionId: string): Promise<SessionSnapshot>;
  admit(actor: Actor, input: { sessionId: string; requestId: string; text: string; userMessageId: string }): Promise<{ run: Run; created: boolean }>;
  getRun(actor: Actor, runId: string): Promise<Run>;
  history(actor: Actor, run: Run): Promise<ModelMessage[]>;
  appendText(run: Run, text: string): Promise<void>;
  finish(run: Run, status: Exclude<RunStatus, "running">): Promise<void>;
  events(actor: Actor, runId: string, after: number): Promise<OutputEvent[]>;
  recover(): Promise<void>;
}
export interface Trace { end(status: RunStatus): void }
export interface Telemetry {
  start(runId: string, sessionId: string): Trace;
  close(): Promise<void>;
}
export type { ChatMessage, Run, RunStatus };
