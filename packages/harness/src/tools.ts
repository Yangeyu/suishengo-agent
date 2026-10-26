import type { Actor } from "@harness/scope";
import type { JsonValue } from "@harness/messages";

export interface ToolInvocation {
  readonly callId: string;
  readonly name: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export type ToolHandler = (call: ToolInvocation) => Promise<JsonValue>;

export type ToolInterceptor = (call: ToolInvocation, execute: ToolHandler) => Promise<JsonValue>;

export interface ToolContext {
  actor: Actor;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  /** Human-readable title; never used for dispatch or model tool selection. */
  displayName?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: "read" | "write";
  timeoutMs: number;
  authorize(context: ToolContext): boolean | Promise<boolean>;
  execute(
    input: Record<string, JsonValue>,
    context: ToolContext & { callId: string },
  ): Promise<JsonValue>;
}

export interface ToolSource {
  open(context: ToolContext): Promise<{ tools: ToolDefinition[]; close(): Promise<void> }>;
}

export interface ToolSession {
  definitions: Pick<ToolDefinition, "name" | "displayName" | "description" | "inputSchema">[];
  invoke(callId: string, name: string, input: unknown): Promise<JsonValue>;
  close(): Promise<void>;
}

export interface Tools {
  configured: boolean;
  open(context: ToolContext, maxCalls: number, intercept?: ToolInterceptor): Promise<ToolSession>;
}
