import type { RunStatus } from "@harness/events";

export interface Trace {
  within<T>(task: () => Promise<T>): Promise<T>;
  end(status: RunStatus): void;
}

export interface Telemetry {
  start(runId: string, sessionId: string): Trace;
  observe<T>(
    name: string,
    attributes: Record<string, string | number>,
    task: () => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
