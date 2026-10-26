import type { StoredMessage } from "@harness/sessions";
import type { SessionEvent } from "@harness/events";

function callsIn(rows: StoredMessage[]) {
  return rows
    .flatMap((row) => (row.message.role === "assistant" ? row.message.content : []))
    .filter((part) => part.type === "tool-call");
}

function validateAssistant(
  rows: StoredMessage[],
  row: StoredMessage,
  message: Extract<StoredMessage["message"], { role: "assistant" }>,
) {
  if (row.openPart) throw new Error("Cannot commit an open content part");
  if (row.message.role !== "assistant") throw new Error("Expected assistant message");

  const content = message.content.filter((part) => part.type !== "tool-call");

  if (
    row.message.content.some(
      (part, index) =>
        part.type === "tool-call" ||
        part.type !== content[index]?.type ||
        part.text !== content[index]?.text,
    )
  ) {
    throw new Error("Committed content differs from the streamed message");
  }

  const ids = new Set(callsIn(rows.filter((item) => item.id !== row.id)).map((call) => call.id));
  for (const call of message.content.filter((part) => part.type === "tool-call")) {
    if (ids.has(call.id)) throw new Error("Duplicate tool call");
    ids.add(call.id);
  }
}

/** A committed event and its message changes form one storage transaction. */
export function applySessionEvent(
  rows: StoredMessage[],
  runId: string,
  event: SessionEvent,
): StoredMessage[] {
  const result = [...rows];
  const pending = () => result.findLast((row) => row.status === "streaming");
  const createAssistant = (step: number | null) => {
    const row: StoredMessage = {
      id: `${runId}:${result.length}`,
      runId,
      ordinal: result.length,
      step,
      status: "streaming",
      message: { role: "assistant", content: [] },
      openPart: null,
    };

    result.push(row);

    return row;
  };
  const update = (row: StoredMessage) => {
    const copy = structuredClone(row);
    result[row.ordinal] = copy;

    return copy;
  };

  if (event.type === "step-start") {
    if (pending()) throw new Error("Previous assistant message is not committed");
    const results = new Set(
      result.flatMap((row) => (row.message.role === "tool" ? [row.message.callId] : [])),
    );
    if (callsIn(result).some((call) => !results.has(call.id)))
      throw new Error("Previous step has pending tool calls");
    createAssistant(event.step);
  }

  if (event.type === "text-start" || event.type === "reasoning-start") {
    const row = update(pending() ?? createAssistant(null));
    if (row.openPart || row.message.role !== "assistant")
      throw new Error("Content part is already open");
    const kind = event.type === "text-start" ? "text" : "reasoning";
    row.openPart = { id: event.id, index: row.message.content.length, kind };
    row.message.content.push({ type: kind, text: "" });
  }

  if (
    event.type === "text-delta" ||
    event.type === "text-end" ||
    event.type === "reasoning-delta" ||
    event.type === "reasoning-end"
  ) {
    const current = pending();
    if (!current || current.openPart?.id !== event.id)
      throw new Error("Content event has no matching start");
    const row = update(current);
    if (row.message.role !== "assistant") throw new Error("Expected assistant message");
    const part = row.message.content[row.openPart!.index];
    if (!part || part.type !== row.openPart!.kind || !event.type.startsWith(part.type))
      throw new Error("Content kind mismatch");
    if ("delta" in event) part.text += event.delta;
    else row.openPart = null;
  }

  if (event.type === "message") {
    const message = event.message;
    if (message.role === "assistant") {
      const row = update(pending() ?? createAssistant(null));
      validateAssistant(result, row, message);
      row.message = structuredClone(message);
      row.status = "complete";
    } else {
      const call = result
        .flatMap((row) => (row.message.role === "assistant" ? row.message.content : []))
        .find((part) => part.type === "tool-call" && part.id === message.callId);
      if (
        !call ||
        call.type !== "tool-call" ||
        call.name !== message.name ||
        result.some((row) => row.message.role === "tool" && row.message.callId === message.callId)
      ) {
        throw new Error("Tool result has no unique matching call");
      }
      result.push({
        id: `${runId}:${result.length}`,
        runId,
        ordinal: result.length,
        step: result.at(-1)?.step ?? null,
        status: "complete",
        message: structuredClone(message),
        openPart: null,
      });
    }
  }

  if (event.type === "run-end") {
    const completedCalls = new Set(
      result.flatMap((row) => (row.message.role === "tool" ? [row.message.callId] : [])),
    );
    const pendingCalls = callsIn(result).filter((call) => !completedCalls.has(call.id));
    const streaming = result.filter((row) => row.status === "streaming");
    if (event.status === "completed" && (streaming.length || pendingCalls.length)) {
      throw new Error("Cannot complete uncommitted messages or pending tool calls");
    }
    for (const row of streaming)
      Object.assign(update(row), { status: "interrupted", openPart: null });
  }

  return result;
}
