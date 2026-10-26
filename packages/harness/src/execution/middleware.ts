import type { Actor, RunScope } from "@harness/scope";
import type { JsonValue } from "@harness/messages";
import type { RunStatus } from "@harness/events";
import type { ConversationHistory } from "@harness/context";
import type {
  ModelInput,
  ModelHandler,
  ModelRequest,
  ModelResult,
  ScopedModels,
} from "@harness/models";
import type { ToolInvocation, ToolHandler } from "@harness/tools";

/** Each definition creates one instance per run; shared clients belong in its factory closure. */
export interface AgentMiddleware {
  readonly name: string;
  onRunEvent?(event: Readonly<RunLifecycleEvent>): void | Promise<void>;
  create(
    scope: RunScope,
    services: { models: ScopedModels; history: ConversationHistory },
  ): MiddlewareInstance | Promise<MiddlewareInstance>;
}

export interface MiddlewareInstance {
  beforeAgent?(): void | Promise<void>;
  beforeModel?(request: ModelRequest): ModelInput | Promise<ModelInput>;
  wrapModelCall?(request: ModelRequest, next: ModelHandler): ReturnType<ModelHandler>;
  afterModel?(result: Readonly<ModelResult>): void | Promise<void>;
  wrapToolCall?(call: ToolInvocation, next: ToolHandler): Promise<JsonValue>;
  afterAgent?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface RunLifecycleEvent {
  type: "started" | "finished";
  runId: string;
  sessionId: string;
  actor: Readonly<Actor>;
  status: RunStatus;
}
