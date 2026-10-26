import type { AgentMessage } from "@harness/messages";

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type AgentEvent =
  | { type: "step-start"; step: number }
  | { type: "step-end"; step: number }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "message"; message: Exclude<AgentMessage, { role: "user" }> };

export type SessionEvent =
  | AgentEvent
  | { type: "run-start"; runId: string }
  | { type: "run-end"; status: Exclude<RunStatus, "running"> };

export interface RunEvent {
  sequence: number;
  event: SessionEvent;
}
