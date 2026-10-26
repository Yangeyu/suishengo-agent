import type { AgentMessage, JsonValue } from "@harness/messages";
import type { Message, Model, AssistantMessage, Api } from "@earendil-works/pi-ai";
import { z } from "zod";

export const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const replaySchema = z
  .object({
    api: z.string(),
    timestamp: z.number(),
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]),
    responseId: z.string().optional(),
    responseModel: z.string().optional(),
    blocks: z.array(
      z
        .object({
          textSignature: z.string().optional(),
          thinkingSignature: z.string().optional(),
          thoughtSignature: z.string().optional(),
          redacted: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export function toPi(message: AgentMessage, model: Model<Api>): Message {
  if (message.role === "user")
    return { role: "user", content: message.text, timestamp: Date.now() };
  if (message.role === "tool")
    return {
      role: "toolResult",
      toolCallId: message.callId,
      toolName: message.name,
      content: [{ type: "text", text: JSON.stringify(message.output) }],
      details: { output: message.output },
      isError: message.isError,
      timestamp: Date.now(),
    };

  const source = message.source;
  const replay = source?.adapter === "pi" ? replaySchema.parse(source.replay) : undefined;
  if (replay && replay.blocks.length !== message.content.length)
    throw new Error("Replay metadata does not match message content");
  return {
    role: "assistant",
    content: message.content.map((part, index) => {
      const meta = replay?.blocks[index];
      if (part.type === "text")
        return {
          type: "text",
          text: part.text,
          ...(meta?.textSignature ? { textSignature: meta.textSignature } : {}),
        };
      if (part.type === "reasoning")
        return {
          type: "thinking",
          thinking: part.text,
          ...(meta?.thinkingSignature ? { thinkingSignature: meta.thinkingSignature } : {}),
          ...(meta?.redacted ? { redacted: true } : {}),
        };
      return {
        type: "toolCall",
        id: part.id,
        name: part.name,
        arguments: part.input,
        ...(meta?.thoughtSignature ? { thoughtSignature: meta.thoughtSignature } : {}),
      };
    }),
    api: (replay?.api ?? model.api) as Api,
    provider: source?.provider ?? model.provider,
    model: source?.model ?? model.id,
    usage: structuredClone(emptyUsage),
    stopReason:
      replay?.stopReason ??
      (message.content.some((part) => part.type === "tool-call") ? "toolUse" : "stop"),
    timestamp: replay?.timestamp ?? Date.now(),
    ...(replay?.responseId ? { responseId: replay.responseId } : {}),
    ...(replay?.responseModel ? { responseModel: replay.responseModel } : {}),
  };
}

export function assistantMessage(
  message: AssistantMessage,
): Extract<AgentMessage, { role: "assistant" }> {
  const replay = {
    api: message.api,
    timestamp: message.timestamp,
    stopReason: message.stopReason,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    blocks: message.content.map<Record<string, JsonValue>>((part): Record<string, JsonValue> => {
      if (part.type === "text")
        return part.textSignature ? { textSignature: part.textSignature } : {};
      if (part.type === "thinking")
        return {
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted ? { redacted: true } : {}),
        };
      return part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {};
    }),
  };
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "thinking") return { type: "reasoning", text: part.thinking };
      return {
        type: "tool-call",
        id: part.id,
        name: part.name,
        input: part.arguments as Record<string, JsonValue>,
      };
    }),
    source: { adapter: "pi", provider: message.provider, model: message.model, replay },
  };
}

export function fromPi(message: Message): AgentMessage {
  if (message.role === "user") {
    if (typeof message.content !== "string")
      throw new Error("Only text user messages are supported");
    return { role: "user", text: message.content };
  }
  if (message.role === "assistant") return assistantMessage(message);
  if (message.role === "toolResult") {
    const details = message.details as { output?: JsonValue } | undefined;
    return {
      role: "tool",
      callId: message.toolCallId,
      name: message.toolName,
      isError: message.isError,
      output:
        details?.output ??
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
    };
  }
  throw new Error("System messages are not conversation history");
}
