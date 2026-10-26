import type { Actor } from "@harness/scope";
import type { HistoryTurn } from "@harness/sessions";
import type { ModelInput } from "@harness/models";

export interface ContextSummary {
  throughPosition: number;
  text: string;
  policyVersion: string;
  modelId: string;
  revision: number;
}

export interface ConversationHistory {
  summaryRevision: number;
  turns: HistoryTurn[];
  summary?: ContextSummary;
}

export interface ContextStore {
  loadSummary(actor: Actor, sessionId: string): Promise<ContextSummary | undefined>;
  saveSummary(
    actor: Actor,
    sessionId: string,
    summary: Omit<ContextSummary, "revision">,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<ContextSummary>;
}

export interface Contexts {
  load(actor: Actor, runId: string): Promise<ConversationHistory>;
}

/** Conservative UTF-8 estimate including schemas; not a provider tokenizer. */
export function estimateContext(context: ModelInput): number {
  return (
    new TextEncoder().encode(JSON.stringify(context)).byteLength + 32 * context.messages.length
  );
}
