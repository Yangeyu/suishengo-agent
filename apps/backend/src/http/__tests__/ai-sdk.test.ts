import { applySessionEvent } from "@harness/sessions/state";
import type { StoredMessage, Run } from "@harness/sessions";
import type { SessionEvent } from "@harness/events";
import test from "node:test";
import assert from "node:assert/strict";
import { readUIMessageStream, type UIMessage } from "ai";

import { createUIStreamMapper, toChatSnapshot } from "@backend/http/ai-sdk";

const run: Run = {
  id: "run",
  sessionId: "session",
  requestId: "request",
  userMessageId: "user",
  position: 0,
  sequence: 0,
  status: "running",
};
const user: StoredMessage = {
  id: "user",
  runId: run.id,
  ordinal: 0,
  step: null,
  status: "complete",
  message: { role: "user", text: "question" },
  openPart: null,
};

async function project(events: SessionEvent[]) {
  let rows = [structuredClone(user)];
  const convert = createUIStreamMapper(run.id);
  const chunks = events.flatMap((event) => {
    rows = applySessionEvent(rows, run.id, event);
    return convert(event);
  });
  let displayed: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
  }))
    displayed = message;

  const ending = events.at(-1);
  const status = ending?.type === "run-end" ? ending.status : "running";
  const snapshot = toChatSnapshot({
    session: { id: "session", title: "test", createdAt: "now" },
    activeRun: null,
    turns: [{ run: { ...run, status }, messages: rows }],
  });
  assert.deepEqual(snapshot.messages[1], JSON.parse(JSON.stringify(displayed)));
  assert.ok(!JSON.stringify(snapshot).includes("private-signature"));
  assert.ok(!JSON.stringify(chunks).includes("private-signature"));
  return rows;
}

test("committed core history and replay produce the same SDK message without exposing adapter state", async () => {
  await project([
    { type: "run-start", runId: run.id },
    { type: "step-start", step: 1 },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "consider" },
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "answer" },
    { type: "text-end", id: "t" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "consider" },
          { type: "tool-call", id: "call", name: "lookup", input: {} },
          { type: "text", text: "answer" },
        ],
        source: {
          provider: "provider",
          model: "model",
          adapter: "fixture",
          replay: "private-signature",
        },
      },
    },
    {
      type: "message",
      message: {
        role: "tool",
        callId: "call",
        name: "lookup",
        output: { found: true },
        isError: false,
      },
    },
    { type: "step-end", step: 1 },
    { type: "step-start", step: 2 },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "finished" }] },
    },
    { type: "step-end", step: 2 },
    { type: "run-end", status: "completed" },
  ]);
});

test("cancellation preserves partial content and unconfirmed tool effects without inventing a tool result", async () => {
  const rows = await project([
    { type: "run-start", runId: run.id },
    { type: "step-start", step: 1 },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "partial" },
    { type: "run-end", status: "cancelled" },
  ]);
  assert.equal(rows.at(-1)?.status, "interrupted");

  const waiting = await project([
    { type: "run-start", runId: run.id },
    { type: "step-start", step: 1 },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool-call", id: "write", name: "reserve", input: {} }],
      },
    },
    { type: "run-end", status: "cancelled" },
  ]);
  assert.ok(waiting.every((row) => row.message.role !== "tool"));
});
