import type { RunScope } from "@harness/scope";
import type { AgentEvent } from "@harness/events";
import type { AgentMessage, JsonValue } from "@harness/messages";
import type { ConversationHistory } from "@harness/context";
import type { Models, ModelRequest, ModelCall, ModelHandler } from "@harness/models";
import type { ToolSession, ToolInvocation, ToolHandler } from "@harness/tools";

export interface AgentLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number;
}

export interface AgentExecutor {
  run(input: {
    system: string;
    messages: AgentMessage[];
    tools: ToolSession;
    execution: AgentExecution;
    limits: AgentLimits;
    onEvent(event: AgentEvent): Promise<void>;
  }): Promise<void>;
}

/** Bound operations are passed to adapters; adapters never import the runtime implementation. */
export interface AgentExecution {
  readonly scope: RunScope;
  readonly history: ConversationHistory;
  readonly models: Pick<Models, "resolve">;
  abort(reason?: unknown): void;
  model(request: ModelRequest, call?: ModelCall): ReturnType<ModelHandler>;
  tool(call: ToolInvocation, execute: ToolHandler): Promise<JsonValue>;
}
