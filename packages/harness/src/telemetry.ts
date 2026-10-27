import type { PromptReference } from "@harness/prompts";
import type { JsonValue } from "@harness/messages";
import type { ModelResult } from "@harness/models";
import type { ExecutionFailure } from "@harness/errors";

export interface ObservationData {
  input?: JsonValue;
  output?: JsonValue;
  metadata?: Record<string, JsonValue>;
  model?: string;
  modelParameters?: Record<string, string | number>;
  prompt?: PromptReference;
  usage?: ModelResult["usage"];
  /** Unix milliseconds of the first generated content. */
  completionStartTime?: number;
}

export interface ObservationSpec extends ObservationData {
  name: string;
  type?: "span" | "agent" | "generation" | "tool" | "retriever";
  /** Attributes propagated to descendants, including across detached callbacks. */
  trace?: { sessionId?: string; metadata?: Record<string, string> };
}

export interface ObservationResult {
  status: "completed" | ExecutionFailure["status"];
  /** An explicit diagnostic code, never a raw error message. */
  errorCode?: string;
}

export interface Observation {
  within<T>(execute: () => T): T;
  /** Lazy projection keeps diagnostic data processing failures outside business execution. */
  update(data: ObservationData | (() => ObservationData)): void;
  event(name: string, data?: ObservationData, result?: ObservationResult): void;
  end(result?: ObservationResult): void;
}

/** Recording failures must not change business results or repeat a continuation. */
export interface Telemetry {
  start(spec: ObservationSpec): Observation;
  observe<T>(
    spec: ObservationSpec & { signal?: AbortSignal },
    execute: (observation: Observation) => Promise<T>,
  ): Promise<T>;
}

const noopObservation: Observation = {
  within: (execute) => execute(),
  update() {},
  event() {},
  end() {},
};

/** Explicit dependency for executions that do not record observations. */
export const noopTelemetry: Telemetry = {
  start: () => noopObservation,
  observe: async (_spec, execute) => execute(noopObservation),
};
