import type { AgentMessage } from "@harness/messages";
import type { RunScope } from "@harness/scope";
import type { ToolSession } from "@harness/tools";

export interface ModelInput {
  system: string;
  summary?: string;
  messages: AgentMessage[];
  tools: ToolSession["definitions"];
}

export interface ModelInfo {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface ModelRequest {
  readonly model: ModelInfo;
  readonly purpose: "conversation" | "compaction";
  readonly context: ModelInput;
  readonly maxOutputTokens: number;
}

export interface ModelResult {
  message: Extract<AgentMessage, { role: "assistant" }>;
  usage: { input: number; output: number; total: number };
  finishReason: "stop" | "toolUse" | "length";
}

export type ModelHandler = (request: ModelRequest) => Promise<ModelResult>;
export type ModelCall = (request: ModelRequest, scope: RunScope) => Promise<ModelResult>;

export interface Models {
  resolve(id?: string): ModelInfo;
  generate: ModelCall;
}

/** Bound to the current run's identity, budget and middleware. */
export interface ScopedModels {
  resolve(id?: string): ModelInfo;
  generate: ModelHandler;
}
