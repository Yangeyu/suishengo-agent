import type { Run, SessionSummary } from "@harness/sessions";
import type { UIMessage } from "ai";

export type MessageMetadata = { runId: string; schemaVersion: 1 };
export interface ChatSnapshot {
  session: SessionSummary;
  messages: UIMessage<MessageMetadata>[];
  activeRun: Run | null;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "请求失败");
  return value as T;
}
