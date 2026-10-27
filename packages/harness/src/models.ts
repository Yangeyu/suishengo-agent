import type { PromptInput } from "@harness/prompts";
import type { AgentMessage } from "@harness/messages";
import type { RunScope } from "@harness/scope";
import type { ToolDefinition } from "@harness/tools";

export interface ModelInput {
  system: PromptInput;
  summary?: string;
  messages: AgentMessage[];
  tools: Pick<ToolDefinition, "name" | "description" | "inputSchema">[];
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
  usage: {
    /** Total input, including any reported cache reads and writes. */
    input: number;
    output: number;
    total: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  completionStartTime?: number;
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
