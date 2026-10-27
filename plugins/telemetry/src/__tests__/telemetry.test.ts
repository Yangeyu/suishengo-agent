import { inlinePrompt, definePrompt, createPromptTemplate, renderPrompt } from "@harness/prompts";
import { createPrompts } from "@plugins/prompts/src/service";
import { compactionPrompt } from "@plugins/context/src/prompts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { startTelemetry } from "@plugins/telemetry/src/index";
import { toolsPlugin } from "@plugins/tools/src/index";
import { contextCompaction } from "@plugins/context/src/compaction";
import { openMiddleware } from "@runtime/middleware";
import { createRuntime } from "@runtime";
import { ServiceError, type Sessions, type Run, type ToolDefinition } from "@harness";
import type { Telemetry, ObservationSpec } from "@harness/telemetry";
import type { StepExecution } from "@harness/execution";
import type { ModelResult } from "@harness/models";
import { logger } from "@logging";

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
};
const attr = (span: Span, key: string) => {
  const value = span.attributes.find((item) => item.key === key)?.value;
  return value?.stringValue ?? (value?.intValue === undefined ? undefined : String(value.intValue));
};

const metadata = (span: Span, key: string) => {
  const value = attr(span, `langfuse.observation.metadata.${key}`);
  return value === undefined ? undefined : JSON.parse(value);
};

async function collect() {
  const spans: Span[] = [];
  const receiver = { status: 200, stall: false };
  const requests: { url?: string; version?: string | string[] }[] = [];
  const server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const bytes = Buffer.concat(buffers);
    const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes;
    const payload = JSON.parse(body.toString()) as {
      resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
    };
    spans.push(
      ...payload.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    requests.push({ url: request.url, version: request.headers["x-langfuse-ingestion-version"] });
    if (receiver.stall) return;
    response.writeHead(receiver.status, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    spans,
    receiver,
    requests,
    connection: {
      baseUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port,
      publicKey: "fixture-public",
      secretKey: "fixture-secret",
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function capture(t: TestContext, captureContent = false) {
  const receiver = await collect();
  const { telemetry, shutdown } = startTelemetry({
    connection: receiver.connection,
    environment: "test",
    captureContent,
    shutdownTimeoutMs: 1000,
  });
  t.after(async () => {
    await shutdown();
    await receiver.close();
  });
  return { ...receiver, telemetry, shutdown };
}

const systemDefinition = definePrompt({
  key: "fixture.system",
  description: "Fixture",
  variables: [],
  defaultTemplate: "fixture",
});
const promptSnapshot = {
  [systemDefinition.key]: createPromptTemplate(systemDefinition, "fixture", {
    name: "fixture-prompt",
    version: 7,
  }),
  [compactionPrompt.key]: createPromptTemplate(compactionPrompt, compactionPrompt.defaultTemplate, {
    name: "summary-prompt",
    version: 3,
  }),
};
const promptService = createPrompts([systemDefinition], {});

const scope = (runId = "run") => ({
  actor: { userId: "fixture" },
  runId,
  sessionId: `${runId}-session`,
  signal: new AbortController().signal,
  budget: { remaining: 10000, record() {} },
});
const model = { id: "fixture", contextWindow: 2000, maxOutputTokens: 100 };
const request = {
  model,
  purpose: "conversation" as const,
  maxOutputTokens: 100,
  context: {
    system: renderPrompt(promptSnapshot[systemDefinition.key]!),
    tools: [],
    messages: [{ role: "user" as const, text: "question" }],
  },
};
const result = {
  message: { role: "assistant" as const, content: [{ type: "text" as const, text: "answer" }] },
  usage: { input: 10, output: 2, total: 12, cacheRead: 4, cacheWrite: 1 },
  finishReason: "stop" as const,
  completionStartTime: Date.now(),
};

const runSpec = (runId = "run"): ObservationSpec => ({
  name: "agent.run",
  type: "agent",
  trace: { sessionId: `${runId}-session`, metadata: { runId } },
});

async function callModel(
  telemetry: Telemetry,
  current = scope(),
  generate: () => Promise<ModelResult> = async () => result,
) {
  const run = await openMiddleware(
    current,
    { turns: [], summaryRevision: 0 },
    promptSnapshot,
    [],
    {
      resolve: () => model,
      generate,
    },
    telemetry,
  );
  try {
    return await run.execution.model(request);
  } finally {
    await run.close();
  }
}

test("detached concurrent steps retain the complete creation context and final model fields", async (t) => {
  const receiver = await capture(t);
  const { telemetry } = receiver;
  const waiting: {
    step: StepExecution;
    execute(): Promise<void>;
    release(): void;
  }[] = [];
  const roots = ["alice", "bob"].map((runId) =>
    telemetry.observe(runSpec(runId), async () => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = await openMiddleware(
        scope(runId),
        { turns: [], summaryRevision: 0 },
        promptSnapshot,
        [
          {
            name: "limit-output",
            create: () => ({
              wrapModelCall: (input, next) => next({ ...input, maxOutputTokens: 20 }),
            }),
          },
        ],
        {
          resolve: () => model,
          generate: async (input) => {
            assert.equal(input.maxOutputTokens, 20);
            await delay(1);
            return result;
          },
        },
        telemetry,
      );
      const step = run.execution.startStep(1);
      waiting.push({
        step,
        release,
        async execute() {
          try {
            await step.within(() => run.execution.model(request));
          } finally {
            step.end({ status: "completed" });
            await run.close();
          }
        },
      });
      await done;
    }),
  );
  while (waiting.length < 2) await delay(1);
  // This continuation is outside both root contexts, not just a delayed callback inside them.
  await Promise.all(
    waiting.map(async (task) => {
      try {
        await task.execute();
      } finally {
        task.release();
      }
    }),
  );
  await Promise.all(roots);
  await receiver.shutdown();
  const rootsSpans = receiver.spans.filter((s) => s.name === "agent.run");
  assert.equal(rootsSpans.length, 2);
  assert.notEqual(rootsSpans[0]!.traceId, rootsSpans[1]!.traceId);
  for (const root of rootsSpans) {
    const tree = receiver.spans.filter((s) => s.traceId === root.traceId);
    const step = tree.find((s) => s.name === "agent.step")!;
    const generation = tree.find((s) => s.name === "model.generate")!;
    assert.equal(step.parentSpanId, root.spanId);
    assert.equal(generation.parentSpanId, step.spanId);
    assert.equal(attr(generation, "session.id"), attr(root, "session.id"));
    assert.equal(
      attr(generation, "langfuse.trace.metadata.runId"),
      attr(root, "langfuse.trace.metadata.runId"),
    );
    assert.equal(metadata(step, "stepIndex"), 1);
    assert.equal(attr(generation, "langfuse.observation.prompt.name"), "fixture-prompt");
    assert.equal(
      JSON.parse(attr(generation, "langfuse.observation.model.parameters")!).max_tokens,
      20,
    );
    assert.deepEqual(JSON.parse(attr(generation, "langfuse.observation.usage_details")!), {
      input: 5,
      output: 2,
      total: 12,
      input_cached_tokens: 4,
      input_cache_write_tokens: 1,
    });
    assert.ok(attr(generation, "langfuse.observation.completion_start_time"));
  }
  assert.ok(receiver.requests.length > 0);
  assert.ok(
    receiver.requests.every((r) => r.url === "/api/public/otel/v1/traces" && r.version === "4"),
  );
  assert.ok(
    receiver.spans.every(
      (s) => !s.attributes.some((a) => /observation\.(input|output)$/.test(a.key)),
    ),
  );
});

test("full tool observation includes validation, denial, failure and timeout without repeating effects", async (t) => {
  const receiver = await capture(t, true);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let effects = 0;
  const definitions = ["success", "denied", "failed", "slow"].map((name): ToolDefinition => ({
    name,
    displayName: " 展示名称 ",
    description: "fixture",
    effect: "read" as const,
    timeoutMs: 10,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    authorize: () => name !== "denied",
    async execute(_input, current) {
      effects++;
      if (name === "failed") throw new Error("private-tool-error");
      if (name === "slow") await delay(100, undefined, { signal: current.signal });
      return { answer: "visible", access_token: "private-token" };
    },
  }));
  await ctx.plugin(toolsPlugin, {
    sources: [],
    telemetry: receiver.telemetry,
    definitions,
  });
  const session = await ctx.tools.open(scope(), 5);
  t.after(() => session.close());
  definitions[0]!.description = "Updated for subsequent sessions";
  definitions[0]!.displayName = "新名称";
  await receiver.telemetry.observe(runSpec(), async () => {
    const step = receiver.telemetry.start({ name: "agent.step" });
    await step.within(async () => {
      assert.deepEqual(await session.invoke("ok", "success", { query: "q" }), {
        answer: "visible",
        access_token: "private-token",
      });
      await assert.rejects(session.invoke("invalid", "success", {}), {
        code: "TOOL_INPUT_INVALID",
      });
      await assert.rejects(session.invoke("denied", "denied", { query: "q" }), {
        code: "TOOL_FORBIDDEN",
      });
      await assert.rejects(session.invoke("failed", "failed", { query: "q" }), {
        code: "TOOL_FAILED",
      });
      await assert.rejects(session.invoke("slow", "slow", { query: "q" }), { code: "TOOL_FAILED" });
    });
    step.end({ status: "completed" });
  });
  await receiver.shutdown();
  assert.equal(effects, 3);
  const tools = receiver.spans.filter((s) => attr(s, "langfuse.observation.type") === "tool");
  assert.equal(tools.length, 5);
  for (const tool of tools) {
    assert.equal(metadata(tool, "description"), "fixture");
    assert.equal(metadata(tool, "displayName"), "展示名称");
  }
  const find = (id: string) => tools.find((s) => metadata(s, "toolCallId") === id)!;
  assert.equal(metadata(find("failed"), "errorCode"), "TOOL_FAILED");
  assert.equal(metadata(find("denied"), "status"), "denied");
  assert.equal(metadata(find("invalid"), "errorCode"), "TOOL_INPUT_INVALID");
  assert.equal(metadata(find("slow"), "status"), "timeout");
  assert.equal(find("ok").name, "success");
  assert.equal(
    JSON.parse(attr(find("ok"), "langfuse.observation.output")!).access_token,
    "[redacted]",
  );
  assert.ok(!JSON.stringify(receiver.spans).includes("private-"));
});

test("recording failures preserve success and the exact original business exception", async (t) => {
  const receiver = await capture(t, true);
  const level = logger.level;
  logger.level = "silent";
  t.after(() => {
    logger.level = level;
  });
  let attempts = 0;
  const broken = {
    get value(): string {
      throw new Error("private-recording-error");
    },
  };
  const returned = await receiver.telemetry.observe(
    { name: "input-failure", type: "tool", input: broken },
    async (observation) => {
      observation.update(() => {
        throw new Error("private-projection-error");
      });
      attempts++;
      return 42;
    },
  );
  assert.equal(returned, 42);
  const output = await receiver.telemetry.observe(
    { name: "output-failure", type: "tool" },
    async (observation) => {
      attempts++;
      observation.update(() => ({ output: broken }));
      return broken;
    },
  );
  assert.equal(output, broken);
  const original = new ServiceError("TOOL_FORBIDDEN", "private-domain-error", {
    cause: new Error("private-cause"),
  });
  await assert.rejects(
    receiver.telemetry.observe({ name: "denied-cause", type: "tool" }, async () => {
      attempts++;
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(attempts, 3);
  await receiver.shutdown();
  const denied = receiver.spans.find((s) => s.name === "denied-cause")!;
  assert.equal(metadata(denied, "status"), "denied");
  assert.equal(metadata(denied, "errorCode"), "TOOL_FORBIDDEN");
  assert.ok(!JSON.stringify(receiver.spans).includes("private-"));
});

test("compaction owns its nested generation, persistence and fallback event", async (t) => {
  const receiver = await capture(t);
  const current = scope();
  let fail = false;
  const history = {
    summaryRevision: 0,
    turns: [
      {
        runId: "old",
        position: 1,
        completed: true,
        messages: [
          { role: "user" as const, text: "old".repeat(200) },
          { role: "assistant" as const, content: [] },
        ],
      },
      {
        runId: "recent",
        position: 2,
        completed: true,
        messages: [
          { role: "user" as const, text: "recent".repeat(30) },
          { role: "assistant" as const, content: [] },
        ],
      },
      {
        runId: "run",
        position: 3,
        completed: false,
        messages: [{ role: "user" as const, text: "question" }],
      },
    ],
  };
  const definition = contextCompaction({
    telemetry: receiver.telemetry,
    policy: { version: "v1", triggerFraction: 0.3, keepRecentTurns: 1, maxSummaryTokens: 100 },
    store: {
      loadSummary: async () => undefined,
      saveSummary: async (_actor, _session, summary) => ({ ...summary, revision: 1 }),
    },
  });
  await receiver.telemetry.observe(runSpec(), async () => {
    for (const index of [1, 2]) {
      fail = index === 2;
      const run = await openMiddleware(
        current,
        history,
        promptSnapshot,
        [definition],
        {
          resolve: () => model,
          generate: async (request) => {
            if (fail && request.purpose === "compaction")
              throw new ServiceError("MODEL_FAILED", "private-error");
            return result;
          },
        },
        receiver.telemetry,
      );
      const step = run.execution.startStep(index);
      try {
        await step.within(() =>
          run.execution.model({
            ...request,
            context: { ...request.context, messages: history.turns.flatMap((t) => t.messages) },
          }),
        );
        step.end({ status: "completed" });
        await run.finish();
      } finally {
        await run.close();
      }
    }
  });
  await receiver.shutdown();
  const compact = receiver.spans.filter((s) => s.name === "context.compact");
  assert.equal(compact.length, 2);
  for (const span of compact) {
    assert.ok(
      receiver.spans.some((s) => s.name === "model.generate" && s.parentSpanId === span.spanId),
    );
    assert.ok(
      receiver.spans.some((s) => s.name === "agent.step" && s.spanId === span.parentSpanId),
    );
  }
  for (const generation of receiver.spans.filter((s) => s.name === "model.generate")) {
    const summary = metadata(generation, "purpose") === "compaction";
    assert.equal(
      attr(generation, "langfuse.observation.prompt.name"),
      summary ? "summary-prompt" : "fixture-prompt",
    );
    assert.equal(attr(generation, "langfuse.observation.prompt.version"), summary ? "3" : "7");
  }
  assert.ok(receiver.spans.some((s) => s.name === "context.save"));
  const fallback = receiver.spans.find((s) => s.name === "context.compaction_fallback")!;
  assert.equal(fallback.startTimeUnixNano, fallback.endTimeUnixNano);
  assert.ok(compact.some((s) => s.spanId === fallback.parentSpanId));
});

test("export rejection does not replace a business result", async (t) => {
  const receiver = await capture(t);
  receiver.receiver.status = 400;
  const output = await callModel(receiver.telemetry);
  assert.equal(output, result);
  await receiver.shutdown();
  assert.equal(receiver.spans.length, 1);
});

test("missing provider usage is not exported as measured zero tokens", async (t) => {
  const receiver = await capture(t);
  const output = { ...result, usage: { input: 0, output: 0, total: 0 } };
  assert.equal(await callModel(receiver.telemetry, scope(), async () => output), output);
  await receiver.shutdown();
  assert.equal(attr(receiver.spans[0]!, "langfuse.observation.usage_details"), undefined);
  assert.equal(metadata(receiver.spans[0]!, "usageAvailable"), false);
});

test("cancelled generations retain their reason without inventing usage", async (t) => {
  const receiver = await capture(t);
  const controller = new AbortController();
  const current = { ...scope(), signal: controller.signal };
  await assert.rejects(
    callModel(receiver.telemetry, current, async () => {
      controller.abort();
      controller.signal.throwIfAborted();
      return result;
    }),
    { name: "AbortError" },
  );
  await receiver.shutdown();
  assert.equal(metadata(receiver.spans[0]!, "status"), "cancelled");
  assert.equal(attr(receiver.spans[0]!, "langfuse.observation.usage_details"), undefined);
});

test("shutdown is idempotent and bounded, and the next SDK can start", async (t) => {
  const receiver = await collect();
  receiver.receiver.stall = true;
  const options = {
    connection: receiver.connection,
    environment: "test",
    captureContent: false,
    shutdownTimeoutMs: 100,
  };
  const service = startTelemetry(options);
  t.after(async () => {
    await receiver.close();
    await service.shutdown();
  });
  assert.throws(() => startTelemetry(options), /already initialized/);
  await service.telemetry.observe({ name: "fixture", type: "generation" }, async () => result);
  const started = performance.now();
  const closing = service.shutdown();
  assert.equal(service.shutdown(), closing);
  await closing;
  assert.ok(performance.now() - started < 1000);
  receiver.receiver.stall = false;
  const restarted = startTelemetry(options);
  try {
    assert.equal(
      await restarted.telemetry.observe({ name: "fixture" }, async () => result),
      result,
    );
  } finally {
    await restarted.shutdown();
  }
});
test("failed finalization marks the run failed and stops admission", async (t) => {
  const receiver = await capture(t);
  let finishReached!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishReached = resolve;
  });
  const run: Run = {
    id: "persistence-run",
    sessionId: "session",
    requestId: "request",
    userMessageId: "message",
    position: 0,
    status: "running",
    sequence: 0,
  };
  const service = createRuntime({
    sessions: {
      admit: async () => ({ created: true, run }),
      finish: async () => {
        finishReached();
        throw new Error("database unavailable");
      },
    } as unknown as Sessions,
    contexts: { load: async () => ({ turns: [], summaryRevision: 0 }) },
    agent: { run: async () => {} },
    tools: {
      configured: false,
      open: async () => ({ definitions: [], invoke: async () => null, close: async () => {} }),
    },
    limits: { maxSteps: 2, maxTokens: 100, maxToolCalls: 1 },
    system: systemDefinition,
    prompts: promptService,
    timeoutMs: 1000,
    telemetry: receiver.telemetry,
  });
  t.after(() => service.close());
  await service.submit(
    { userId: "test-user" },
    { sessionId: "session", requestId: "request", userMessageId: "message", text: "fixture" },
  );
  await finished;
  await service.close();
  assert.equal(service.available(), false);
  await receiver.shutdown();
  const root = receiver.spans.find((span) => span.name === "agent.run")!;
  assert.equal(metadata(root, "status"), "failed");
  assert.equal(metadata(root, "executionStatus"), "completed");
  assert.equal(metadata(root, "errorCode"), "RUN_PERSISTENCE_FAILED");
});

test("run content contains the current question and committed reply", async () => {
  const receiver = await collect();
  const { telemetry, shutdown } = startTelemetry({
    environment: "test",
    captureContent: true,
    shutdownTimeoutMs: 1000,
    connection: receiver.connection,
  });
  const run: Run = {
    id: "content-run",
    sessionId: "content-session",
    requestId: "request",
    userMessageId: "message",
    position: 2,
    status: "running",
    sequence: 0,
  };
  let finishReached!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishReached = resolve;
  });
  const service = createRuntime({
    sessions: {
      admit: async () => ({ created: true, run }),
      append: async () => {},
      finish: async () => {
        finishReached();
      },
    } as unknown as Sessions,
    contexts: {
      load: async () => ({
        summaryRevision: 0,
        turns: [
          {
            runId: "old",
            position: 1,
            completed: true,
            messages: [{ role: "user", text: "old question" }],
          },
          {
            runId: run.id,
            position: 2,
            completed: false,
            messages: [{ role: "user", text: "current question" }],
          },
        ],
      }),
    },
    agent: {
      run: async ({ onEvent }) => {
        await onEvent({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
        });
      },
    },
    tools: {
      configured: false,
      open: async () => ({ definitions: [], invoke: async () => null, close: async () => {} }),
    },
    limits: { maxSteps: 2, maxTokens: 100, maxToolCalls: 1 },
    system: systemDefinition,
    prompts: promptService,
    timeoutMs: 1000,
    telemetry,
  });
  try {
    await service.submit(
      { userId: "test-user" },
      {
        sessionId: run.sessionId,
        requestId: run.requestId,
        userMessageId: run.userMessageId,
        text: "current question",
      },
    );
    await finished;
    await service.close();
    await shutdown();
    const root = receiver.spans.find((span) => span.name === "agent.run")!;
    assert.deepEqual(JSON.parse(attr(root, "langfuse.observation.input")!), [
      { role: "user", content: "current question" },
    ]);
    assert.deepEqual(JSON.parse(attr(root, "langfuse.observation.output")!), [
      { role: "assistant", content: "answer" },
    ]);
  } finally {
    await service.close();
    await shutdown();
    await receiver.close();
  }
});

test("generation content redacts structured tool history and output without changing the model request", async () => {
  const receiver = await collect();
  const { telemetry, shutdown } = startTelemetry({
    environment: "test",
    captureContent: true,
    shutdownTimeoutMs: 1000,
    connection: receiver.connection,
  });
  const model = { id: "fixture", contextWindow: 10000, maxOutputTokens: 100 };
  const session = await openMiddleware(
    {
      actor: { userId: "fixture-user" },
      runId: "redaction-run",
      sessionId: "redaction-session",
      signal: new AbortController().signal,
      budget: { remaining: 10000, record() {} },
    },
    { summaryRevision: 0, turns: [] },
    promptSnapshot,
    [],
    {
      resolve: () => model,
      generate: async (request) => {
        const tool = request.context.messages[2]!;
        assert.equal(tool.role, "tool");
        if (tool.role === "tool")
          assert.deepEqual(tool.output, { access_token: "private-result", result: "visible" });
        return {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "next",
                name: "lookup",
                input: { password: "private-output", query: "visible" },
              },
            ],
          },
          usage: { input: 10, output: 2, total: 12 },
          finishReason: "toolUse",
        };
      },
    },
    telemetry,
  );
  try {
    await session.execution.model({
      model,
      purpose: "conversation",
      maxOutputTokens: 100,
      context: {
        system: inlinePrompt("fixture"),
        tools: [],
        messages: [
          { role: "user", text: "question" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "first",
                name: "lookup",
                input: { apiKey: "private-argument", query: "visible" },
              },
            ],
          },
          {
            role: "tool",
            callId: "first",
            name: "lookup",
            output: { access_token: "private-result", result: "visible" },
            isError: false,
          },
        ],
      },
    });
    await shutdown();
    const generation = receiver.spans.find((span) => span.name === "model.generate")!;
    const input = JSON.parse(attr(generation, "langfuse.observation.input")!);
    const output = JSON.parse(attr(generation, "langfuse.observation.output")!);
    assert.deepEqual(input.messages[2].tool_calls[0].function.arguments, {
      apiKey: "[redacted]",
      query: "visible",
    });
    assert.deepEqual(input.messages[3].content, { access_token: "[redacted]", result: "visible" });
    assert.deepEqual(output.tool_calls[0].function.arguments, {
      password: "[redacted]",
      query: "visible",
    });
    assert.ok(!JSON.stringify(receiver.spans).includes("private-"));
  } finally {
    await session.close();
    await shutdown();
    await receiver.close();
  }
});
