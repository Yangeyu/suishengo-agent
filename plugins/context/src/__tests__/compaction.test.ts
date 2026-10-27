import { noopTelemetry } from "@harness/telemetry";
import { createContext } from "@plugins/context/src/index";
import { createPrompts } from "@plugins/prompts/src/service";
import { inlinePrompt, createPromptTemplate } from "@harness/prompts";
import { compactionPrompt, summaryVersion } from "@plugins/context/src/prompts";
import {
  estimateContext,
  type ContextStore,
  type ContextSummary,
  type ConversationHistory,
} from "@harness/context";
import type { HistoryTurn } from "@harness/sessions";
import type { RunScope } from "@harness/scope";
import type { Models, ModelRequest } from "@harness/models";
import type { AgentMessage } from "@harness/messages";
import test from "node:test";
import assert from "node:assert/strict";
import { contextCompaction } from "@plugins/context/src/compaction";
import { openMiddleware } from "@runtime/middleware";

const promptSnapshot = {
  [compactionPrompt.key]: createPromptTemplate(compactionPrompt, compactionPrompt.defaultTemplate),
};
const info = { id: "fixture", contextWindow: 1600, maxOutputTokens: 100 };
const policy = { version: "v1", triggerFraction: 0.6, keepRecentTurns: 1, maxSummaryTokens: 100 };
const history: HistoryTurn[] = Array.from({ length: 5 }, (_, index) => ({
  runId: "old-" + index,
  position: index * 2,
  completed: true,
  messages: [
    { role: "user", text: "past " + index + "x".repeat(200) },
    { role: "assistant", content: [{ type: "text", text: "answer " + index }] },
  ],
}));
function setup() {
  const saved: ContextSummary[] = [];
  const requests: ModelRequest[] = [];
  const models: Models = {
    resolve: () => info,
    async generate(request) {
      requests.push(request);
      const text = JSON.stringify(request.context).includes("CURRENT_TOOL")
        ? "current-only"
        : "historical-summary";
      return {
        message: { role: "assistant", content: [{ type: "text", text }] },
        finishReason: "stop",
        usage: { input: 1, output: 1, total: 2 },
      };
    },
  };
  const store: ContextStore = {
    loadSummary: async () => undefined,
    async saveSummary(_actor, _session, value, revision, signal) {
      signal.throwIfAborted();
      const result = { ...value, revision: revision + 1 };
      saved.push(result);
      return result;
    },
  };
  const controller = new AbortController();
  const conversation: ConversationHistory = {
    turns: [
      ...structuredClone(history),
      {
        runId: "run",
        position: 10,
        completed: false,
        messages: [{ role: "user", text: "current request" }],
      },
    ],
    summaryRevision: 0,
  };
  const scope: RunScope = {
    actor: { userId: "alice" },
    runId: "run",
    sessionId: "session",
    signal: controller.signal,
    budget: { remaining: 100000, record() {} },
  };
  const request: ModelRequest = {
    model: info,
    purpose: "conversation",
    maxOutputTokens: 100,
    context: {
      system: inlinePrompt("system"),
      messages: conversation.turns.flatMap((turn) => turn.messages),
      tools: [],
    },
  };
  const create = (prompts = promptSnapshot) =>
    contextCompaction({ telemetry: noopTelemetry, store, policy }).create(scope, {
      prompts,
      history: conversation,
      models: { resolve: models.resolve, generate: (request) => models.generate(request, scope) },
    });
  return { saved, requests, models, store, controller, scope, conversation, request, create };
}

function toolHistory(): AgentMessage[] {
  return Array.from({ length: 4 }, (_, index) => [
    {
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, id: "call-" + index, name: "lookup", input: {} }],
    },
    {
      role: "tool" as const,
      callId: "call-" + index,
      name: "lookup",
      output: "CURRENT_TOOL" + "x".repeat(250),
      isError: false,
    },
  ]).flat();
}

test("compaction preserves canonical history and current input; only completed history becomes a durable summary", async () => {
  const f = setup();
  const original = structuredClone(f.request.context.messages);
  const instance = await f.create();
  const prepared = await instance.beforeModel!(f.request);
  assert.ok(prepared.messages.length < original.length);
  assert.equal(prepared.messages.at(-1)?.role, "user");
  assert.deepEqual(f.request.context.messages, original);
  assert.equal(f.saved.length, 0);

  const current = toolHistory();
  const next = await instance.beforeModel!({
    ...f.request,
    context: { ...f.request.context, messages: [...original, ...current] },
  });
  assert.ok(
    next.messages.some((message) => message.role === "user" && message.text === "current request"),
  );
  assert.equal(next.messages.at(-1)?.role, "tool");
  assert.ok(
    f.requests.every(
      (request) => request.purpose === "compaction" && request.context.tools.length === 0,
    ),
  );
  await instance.afterAgent!();
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0]!.text, "historical-summary");
  assert.ok(f.saved[0]!.throughPosition < 10);
});

test("cancelled compaction cannot save a summary", async () => {
  const f = setup();
  const instance = await f.create();
  await instance.beforeModel!(f.request);
  f.controller.abort();
  await assert.rejects(
    async () => {
      await instance.afterAgent!();
    },
    { name: "AbortError" },
  );
  assert.equal(f.saved.length, 0);
});

test("oversized mandatory context fails before provider execution", async () => {
  const other = setup();
  other.conversation.turns = [
    {
      runId: "run",
      position: 0,
      completed: false,
      messages: [{ role: "user", text: "x".repeat(3000) }],
    },
  ];
  const run = await openMiddleware(
    other.scope,
    other.conversation,
    promptSnapshot,
    [contextCompaction({ telemetry: noopTelemetry, store: other.store, policy })],
    other.models,
    noopTelemetry,
  );
  try {
    await assert.rejects(
      async () => {
        await run.execution.model({
          ...other.request,
          context: { ...other.request.context, messages: other.conversation.turns[0]!.messages },
        });
      },
      { code: "CONTEXT_LIMIT" },
    );
    assert.equal(other.requests.length, 0);
  } finally {
    await run.close();
  }
});

test("summary failure preserves context that still fits the window", async () => {
  const soft = setup();
  soft.models.generate = async () => {
    throw new Error("summary unavailable");
  };
  const softInstance = await soft.create();
  const fittingRequest = {
    ...soft.request,
    model: {
      ...info,
      contextWindow: estimateContext(soft.request.context) + soft.request.maxOutputTokens,
    },
  };
  const unchanged = await softInstance.beforeModel!(fittingRequest);
  assert.deepEqual(unchanged.messages, soft.request.context.messages);
  await softInstance.afterAgent!();
  assert.equal(soft.saved.length, 0);
});

test("lossy fallback invalidates pending and subsequent durable summaries", async () => {
  const hard = setup();
  const hardInstance = await hard.create();
  await hardInstance.beforeModel!(hard.request);
  const generate = hard.models.generate;
  let attempts = 0;
  hard.models.generate = async (request, scope) => {
    if (++attempts === 1) throw new Error("summary unavailable");
    return generate(request, scope);
  };
  const current = toolHistory();
  const messages = [...hard.request.context.messages, ...current];
  const prepared = await hardInstance.beforeModel!({
    ...hard.request,
    context: { ...hard.request.context, messages },
  });
  assert.ok(attempts > 1);
  assert.ok(prepared.messages.length < messages.length);
  assert.ok(
    prepared.messages.some(
      (message) => message.role === "user" && message.text === "current request",
    ),
  );
  assert.deepEqual(prepared.messages.slice(-2), current.slice(-2));
  await hardInstance.afterAgent!();
  assert.equal(hard.saved.length, 0);
});

test("context pins its prompt per run and rebuilds persisted summaries after a prompt release", async () => {
  const f = setup();
  let version = 1;
  const service = createPrompts(
    [compactionPrompt],
    { [compactionPrompt.key]: { name: "context-summary", label: "production" } },
    async () => ({
      text: "Summary policy " + version,
      reference: { name: "context-summary", version },
    }),
  );
  const first = await service.resolve(f.scope.signal);
  const running = await f.create(first);
  version = 2;
  const second = await service.resolve(f.scope.signal);
  await running.beforeModel!(f.request);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every((request) => request.context.system.text === "Summary policy 1"));
  assert.ok(
    f.requests.every((request) => request.context.system.parts[0]!.reference!.version === 1),
  );
  await running.afterAgent!();
  const saved = f.saved[0]!;
  assert.equal(saved.policyVersion, summaryVersion(policy.version, first));
  const context = createContext({
    telemetry: noopTelemetry,
    config: { compaction: policy },
    store: { ...f.store, loadSummary: async () => saved },
    sessions: {
      getRun: async () => ({
        id: "next",
        sessionId: "session",
        requestId: "request",
        userMessageId: "user",
        position: 12,
        status: "running",
        sequence: 1,
      }),
      history: async (_actor, _run, range) =>
        f.conversation.turns.filter(
          (turn) => range?.after === undefined || turn.position > range.after,
        ),
    },
  });
  const reused = await context.contexts.load(f.scope.actor, "next", first);
  assert.equal(reused.summary, saved);
  assert.ok(reused.turns.length < f.conversation.turns.length);
  const rebuilt = await context.contexts.load(f.scope.actor, "next", second);
  assert.equal(rebuilt.summary, undefined);
  assert.equal(rebuilt.summaryRevision, saved.revision);
  assert.deepEqual(rebuilt.turns, f.conversation.turns);
  f.requests.length = 0;
  const next = await f.create(second);
  await next.beforeModel!(f.request);
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every((request) => request.context.system.text === "Summary policy 2"));
});
