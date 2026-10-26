import type { AgentMessage } from "@harness/messages";
import type { StoredMessage, SessionSnapshot } from "@harness/sessions";
import type { SessionEvent } from "@harness/events";
import type { UIMessage, UIMessageChunk } from "ai";

export type MessageMetadata = { runId: string; schemaVersion: 1 };
export type ChatSnapshot = Omit<SessionSnapshot, "turns"> & {
  messages: UIMessage<MessageMetadata>[];
};

const metadata = (runId: string): MessageMetadata => ({ runId, schemaVersion: 1 });
const unknownResult = "运行已结束，工具执行结果未确认";
const toolError = (output: unknown) => (typeof output === "string" ? output : "工具执行失败");

// Tool inputs become visible at message commit, after streamed content has been displayed.
function presentationParts(message: Extract<AgentMessage, { role: "assistant" }>) {
  return [
    ...message.content.filter((part) => part.type !== "tool-call"),
    ...message.content.filter((part) => part.type === "tool-call"),
  ];
}

function assistantParts(row: StoredMessage, assistantIndex: number): UIMessage["parts"] {
  if (row.message.role !== "assistant") throw new Error("Expected assistant message");
  const parts: UIMessage["parts"] = row.step === null ? [] : [{ type: "step-start" }];
  let contentIndex = 0;
  for (const [index, part] of presentationParts(row.message).entries()) {
    if (part.type === "tool-call") {
      parts.push({
        type: "dynamic-tool",
        toolCallId: part.id,
        toolName: part.name,
        input: part.input,
        state: "input-available",
      });
      continue;
    }
    const id = `${row.runId}:${assistantIndex}:${++contentIndex}`;
    parts.push({
      type: part.type,
      text: part.text,
      state: row.openPart?.index === index ? "streaming" : "done",
      ...(part.type === "reasoning" ? { id } : {}),
    });
  }
  return parts;
}

function presentTurn(turn: SessionSnapshot["turns"][number]): UIMessage<MessageMetadata>[] {
  const messages: UIMessage<MessageMetadata>[] = [];
  const assistant: UIMessage<MessageMetadata> = {
    id: turn.run.id,
    role: "assistant",
    metadata: metadata(turn.run.id),
    parts: [],
  };
  let assistantIndex = 0;

  for (const row of turn.messages) {
    const message = row.message;
    if (message.role === "user") {
      messages.push({
        id: row.id,
        role: "user",
        metadata: metadata(turn.run.id),
        parts: [{ type: "text", text: message.text }],
      });
      continue;
    }
    if (message.role === "assistant") {
      assistant.parts.push(...assistantParts(row, assistantIndex++));
      continue;
    }
    const index = assistant.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === message.callId,
    );
    const part = assistant.parts[index];
    if (part?.type !== "dynamic-tool" || part.state !== "input-available")
      throw new Error("Stored tool result has no call");
    assistant.parts[index] = message.isError
      ? { ...part, state: "output-error", errorText: toolError(message.output) }
      : { ...part, state: "output-available", output: message.output };
  }

  if (turn.run.status !== "running") {
    assistant.parts = assistant.parts.map((part) =>
      part.type === "dynamic-tool" && part.state === "input-available"
        ? { ...part, state: "output-error", errorText: unknownResult }
        : part,
    );
  }
  return [...messages, assistant];
}

/** Only presentation fields cross HTTP; provider replay data remains private. */
export function toChatSnapshot(snapshot: SessionSnapshot): ChatSnapshot {
  return {
    session: snapshot.session,
    messages: snapshot.turns.flatMap(presentTurn),
    activeRun: snapshot.activeRun,
  };
}

/** Each HTTP subscription replays the entire run with its own projection state. */
export function createUIStreamMapper(runId: string) {
  const open = new Map<string, { id: string; kind: "text" | "reasoning" }>();
  const pendingTools = new Set<string>();
  let assistantIndex = 0;
  let streamedParts = 0;

  function messageChunks(message: Exclude<AgentMessage, { role: "user" }>): UIMessageChunk[] {
    if (message.role === "tool") {
      pendingTools.delete(message.callId);
      return [
        message.isError
          ? {
              type: "tool-output-error",
              toolCallId: message.callId,
              errorText: toolError(message.output),
            }
          : { type: "tool-output-available", toolCallId: message.callId, output: message.output },
      ];
    }

    const chunks: UIMessageChunk[] = [];
    let contentIndex = 0;
    for (const part of presentationParts(message)) {
      if (part.type === "tool-call") {
        pendingTools.add(part.id);
        chunks.push({
          type: "tool-input-available",
          toolCallId: part.id,
          toolName: part.name,
          input: part.input,
          dynamic: true,
        });
      } else {
        // Executors can commit a complete message without streaming its contents.
        if (contentIndex++ < streamedParts) continue;
        const id = `${runId}:${assistantIndex}:${contentIndex}`;
        if (part.type === "text")
          chunks.push(
            { type: "text-start", id },
            { type: "text-delta", id, delta: part.text },
            { type: "text-end", id },
          );
        else
          chunks.push(
            { type: "reasoning-start", id },
            { type: "reasoning-delta", id, delta: part.text },
            { type: "reasoning-end", id },
          );
      }
    }
    streamedParts = 0;
    assistantIndex++;
    return chunks;
  }

  return (event: SessionEvent): UIMessageChunk[] => {
    switch (event.type) {
      case "run-start":
        return [{ type: "start", messageId: runId, messageMetadata: metadata(runId) }];
      case "step-start":
        streamedParts = 0;
        return [{ type: "start-step" }];
      case "step-end":
        return [{ type: "finish-step" }];
      case "text-start":
      case "reasoning-start": {
        const id = `${runId}:${assistantIndex}:${++streamedParts}`;
        open.set(event.id, { id, kind: event.type === "text-start" ? "text" : "reasoning" });
        return [{ ...event, id }];
      }
      case "text-delta":
      case "reasoning-delta":
      case "text-end":
      case "reasoning-end": {
        const part = open.get(event.id);
        if (!part) throw new Error("Content event has no open part");
        if (event.type.endsWith("-end")) open.delete(event.id);
        return [{ ...event, id: part.id }];
      }
      case "message":
        return messageChunks(event.message);
      case "run-end": {
        const chunks: UIMessageChunk[] = [];
        for (const { id, kind } of open.values())
          chunks.push({ type: kind === "text" ? "text-end" : "reasoning-end", id });
        for (const toolCallId of pendingTools)
          chunks.push({ type: "tool-output-error", toolCallId, errorText: unknownResult });
        if (event.status === "failed" || event.status === "interrupted")
          chunks.push({
            type: "error",
            errorText:
              event.status === "interrupted"
                ? "服务重启，本次运行已中断"
                : "本次运行失败或已达到执行上限",
          });
        if (event.status === "cancelled") chunks.push({ type: "abort" });
        chunks.push({
          type: "finish",
          finishReason: event.status === "completed" ? "stop" : "other",
        });
        return chunks;
      }
    }
  };
}
