export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: Record<string, JsonValue> };

/** Adapter-owned replay data is internal; presentation adapters never forward it. */
export interface MessageSource {
  provider: string;
  model: string;
  adapter: string;
  replay?: JsonValue;
}

export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; content: AssistantPart[]; source?: MessageSource }
  | { role: "tool"; callId: string; name: string; output: JsonValue; isError: boolean };
