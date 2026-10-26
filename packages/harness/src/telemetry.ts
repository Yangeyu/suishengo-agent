import type { JsonValue } from "@harness/messages";

export type ObservationStatus = "completed" | "cancelled" | "timeout" | "denied" | "failed";

export interface ObservationOutcome {
  status: ObservationStatus;
  errorCode?: string;
}

export interface PromptReference {
  name: string;
  version: number;
}

export interface ObservationData {
  metadata?: Record<string, JsonValue>;
  input?: JsonValue;
  output?: JsonValue;
  model?: string;
  prompt?: PromptReference;
  usage?: { input: number; output: number; total: number };
  /** Unix milliseconds of the first generated content, not stream connection time. */
  completionStartTime?: number;
}

export interface ObservationSpec extends ObservationData {
  name: string;
  type: "agent" | "span" | "generation" | "tool" | "retriever" | "event";
  correlation?: {
    runId?: string;
    sessionId?: string;
    stepId?: string;
    stepIndex?: number;
    toolCallId?: string;
  };
  signal?: AbortSignal;
}

export interface Observation {
  within<T>(task: () => T): T;
  update(data: ObservationData): void;
  event(name: string, metadata?: Record<string, JsonValue>): void;
  end(outcome: ObservationOutcome): void;
}

/** Implementations isolate recording failures; business exceptions still propagate. */
export interface Telemetry {
  start(spec: ObservationSpec): Observation;
  observe<T>(spec: ObservationSpec, task: (observation: Observation) => Promise<T>): Promise<T>;
  outcome(error: unknown, signal?: AbortSignal): ObservationOutcome;
  close(): Promise<void>;
}
