import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { createTelemetry } from "@plugins/telemetry/src/index";
import { contextCompaction } from "@plugins/context/src/compaction";
import { openMiddleware } from "@runtime/middleware";
import { ServiceError, type Sessions, type Run, type JsonValue } from "@harness";
import { createRuntime } from "@runtime";
import { logger } from "@logging";

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
};
const attr = (span: Span, key: string) => {
  const value = span.attributes.find((item) => item.key === key)?.value;
  return value?.stringValue ?? (value?.intValue === undefined ? undefined : String(value.intValue));
};

async function collect() {
  const spans: Span[] = [];
  const receiver = { status: 200 };
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
    response.writeHead(receiver.status, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    spans,
    receiver,
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

test(
  "concurrent runs preserve observation parentage and export metadata without content",
  { timeout: 10000 },
  async () => {
    const receiver = await collect();
    const { spans } = receiver;
    const telemetry = createTelemetry({
      connection: receiver.connection,
      environment: "test",
      release: "fixture-release",
    });
    const level = logger.level;
    logger.level = "silent";
    try {
      await Promise.all(
        ["alice", "bob"].map(async (runId) => {
          const root = telemetry.start({
            name: "agent.run",
            type: "agent",
            correlation: { runId, sessionId: runId + "-session" },
          });
          await root.within(async () => {
            const scope = {
              actor: { userId: runId },
              runId,
              sessionId: runId + "-session",
              signal: new AbortController().signal,
              budget: { remaining: 10000, record() {} },
            };
            const history = {
              summaryRevision: 0,
              turns: [
                {
                  runId: "old",
                  position: 1,
                  completed: true,
                  messages: [
                    { role: "user" as const, text: "private".repeat(80) },
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
                  runId,
                  position: 3,
                  completed: false,
                  messages: [{ role: "user" as const, text: "question" }],
                },
              ],
            };
            const model = { id: "fixture", contextWindow: 2000, maxOutputTokens: 100 };
            const run = await openMiddleware(
              scope,
              history,
              [
                contextCompaction({
                  policy: {
                    version: "v1",
                    triggerFraction: 0.3,
                    keepRecentTurns: 1,
                    maxSummaryTokens: 100,
                  },
                  store: {
                    loadSummary: async () => undefined,
                    saveSummary: async (_a, _s, summary) => ({ ...summary, revision: 1 }),
                  },
                }),
              ],
              {
                resolve: () => model,
                generate: async () => {
                  await delay(1);
                  return {
                    message: { role: "assistant", content: [{ type: "text", text: "summary" }] },
                    usage: { input: 10, output: 2, total: 12 },
                    finishReason: "stop",
                    completionStartTime: Date.now(),
                  };
                },
              },
              telemetry,
            );
            try {
              const step = run.execution.startStep(1);
              // Enter after creation, as the Pi event callback and actual execution are separate.
              await delay(1);
              await step.within(async () => {
                await run.execution.model({
                  model,
                  purpose: "conversation",
                  prompt: { name: "fixture-prompt", version: 7 },
                  maxOutputTokens: 100,
                  context: {
                    system: "private instruction",
                    tools: [],
                    messages: history.turns.flatMap((turn) => turn.messages),
                  },
                });
                await assert.rejects(
                  telemetry.observe(
                    { name: "tool.execute", type: "tool", correlation: { toolCallId: "call-1" } },
                    async () => {
                      throw new ServiceError("TOOL_FORBIDDEN", "private error");
                    },
                  ),
                );
                await telemetry.observe(
                  {
                    name: "retrieval",
                    type: "retriever",
                    metadata: { count: 3, secret: "never-export" },
                  },
                  async (observation) => {
                    observation.update({ metadata: { source: "fixture" } });
                    observation.event("retrieval.filtered", { count: 1 });
                  },
                );
              });
              step.end({ status: "completed" });
              step.end({ status: "failed" });
              const next = run.execution.startStep(2);
              const abort = new AbortController();
              await next.within(async () => {
                await assert.rejects(
                  telemetry.observe(
                    { name: "model.cancelled", type: "generation", signal: abort.signal },
                    async () => {
                      abort.abort();
                      abort.signal.throwIfAborted();
                    },
                  ),
                );
              });
              next.end(telemetry.outcome(abort.signal.reason, abort.signal));
            } finally {
              await run.close();
            }
          });
          root.end({ status: "completed" });
        }),
      );
      await telemetry.close();
      const roots = spans.filter((span) => span.name === "agent.run");
      assert.equal(roots.length, 2);
      assert.notEqual(roots[0]!.traceId, roots[1]!.traceId);
      for (const root of roots) {
        const tree = spans.filter((span) => span.traceId === root.traceId);
        const steps = tree.filter((span) => span.name === "agent.step");
        assert.equal(steps.length, 2);
        assert.ok(steps.every((span) => span.parentSpanId === root.spanId));
        const first = steps.find(
          (span) => attr(span, "langfuse.trace.metadata.stepIndex") === "1",
        )!;
        const compact = tree.find((span) => span.name === "context.compact")!;
        assert.equal(compact.parentSpanId, first.spanId);
        const generations = tree.filter((span) => span.name === "model.generate");
        assert.equal(generations.length, 2);
        for (const generation of generations) {
          const purpose = JSON.parse(attr(generation, "langfuse.observation.metadata")!).purpose;
          assert.equal(
            generation.parentSpanId,
            purpose === "compaction" ? compact.spanId : first.spanId,
          );
          assert.deepEqual(JSON.parse(attr(generation, "langfuse.observation.usage_details")!), {
            input: 10,
            output: 2,
            total: 12,
          });
          assert.ok(attr(generation, "langfuse.observation.completion_start_time"));
          assert.equal(
            attr(generation, "langfuse.observation.prompt.name"),
            purpose === "conversation" ? "fixture-prompt" : undefined,
          );
        }
        const tool = tree.find((span) => span.name === "tool.execute")!;
        assert.equal(tool.parentSpanId, first.spanId);
        assert.equal(attr(tool, "execution.status"), "denied");
        const retrieval = tree.find((span) => span.name === "retrieval")!;
        assert.equal(attr(retrieval, "langfuse.observation.type"), "retriever");
        assert.equal(
          JSON.parse(attr(retrieval, "langfuse.observation.metadata")!).source,
          "fixture",
        );
        assert.equal(
          tree.find((span) => span.name === "retrieval.filtered")!.parentSpanId,
          retrieval.spanId,
        );
        assert.equal(
          attr(
            tree.find((span) => span.name === "model.cancelled")!,
            "execution.status",
          ),
          "cancelled",
        );
        assert.ok(tree.every((span) => attr(span, "session.id") === attr(root, "session.id")));
        assert.ok(tree.every((span) => attr(span, "langfuse.environment") === "test"));
        assert.ok(tree.every((span) => attr(span, "langfuse.release") === "fixture-release"));
      }
      assert.ok(!JSON.stringify(spans).includes("never-export"));
      assert.ok(
        spans.every(
          (span) =>
            !span.attributes.some((attribute) =>
              /observation\.(input|output)$/.test(attribute.key),
            ),
        ),
      );
    } finally {
      await telemetry.close();
      logger.level = level;
      await receiver.close();
    }
  },
);

async function capture(t: TestContext, content?: (value: JsonValue) => JsonValue | undefined) {
  const receiver = await collect();
  const telemetry = createTelemetry({ connection: receiver.connection, content });
  t.after(async () => {
    try {
      await telemetry.close();
    } finally {
      await receiver.close();
    }
  });
  return { ...receiver, telemetry };
}

test("recording failures preserve business results", async (t) => {
  let contentCalls = 0;
  const { telemetry } = await capture(t, () => {
    contentCalls++;
    throw new Error("redaction unavailable");
  });
  assert.equal(
    await telemetry.observe(
      { name: "recording-failure", type: "span", input: "private" },
      async () => "business-result",
    ),
    "business-result",
  );
  assert.equal(contentCalls, 1);
});

test("business exceptions retain their identity and export only safe errors", async (t) => {
  const { telemetry, spans } = await capture(t);
  const original = new Error("private-business-error");
  await assert.rejects(
    telemetry.observe({ name: "business-failure", type: "span" }, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  await telemetry.close();
  assert.ok(spans.some((span) => span.name === "business-failure"));
  assert.ok(!JSON.stringify(spans).includes("private-business-error"));
});

test("failed finalization marks the run failed and stops admission", async (t) => {
  const receiver = await capture(t);
  const { telemetry } = receiver;
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
    system: "fixture",
    timeoutMs: 1000,
    telemetry,
  });
  t.after(() => service.close());
  await service.submit(
    { userId: "test-user" },
    { sessionId: "session", requestId: "request", userMessageId: "message", text: "fixture" },
  );
  await finished;
  await service.close();
  assert.equal(service.available(), false);
  await telemetry.close();
  const root = receiver.spans.find((span) => span.name === "agent.run")!;
  assert.equal(attr(root, "execution.status"), "failed");
  const metadata = JSON.parse(attr(root, "langfuse.observation.metadata")!);
  assert.equal(metadata.executionStatus, "completed");
  assert.equal(metadata.errorCode, "RUN_PERSISTENCE_FAILED");
  assert.ok(!JSON.stringify(receiver.spans).includes("private"));
});

test("export rejection preserves successful business results", async (t) => {
  const { receiver, telemetry, spans } = await capture(t);
  receiver.status = 400;
  assert.equal(
    await telemetry.observe({ name: "export-failure", type: "span" }, async () => 42),
    42,
  );
  await telemetry.close();
  assert.ok(spans.some((span) => span.name === "export-failure"));
});

test("runtime content capture records the current user and committed reply", async () => {
  const receiver = await collect();
  const telemetry = createTelemetry({ connection: receiver.connection, content: (value) => value });
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
    system: "fixture",
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
    await telemetry.close();
    const root = receiver.spans.find((span) => span.name === "agent.run")!;
    assert.deepEqual(JSON.parse(attr(root, "langfuse.observation.input")!), [
      { role: "user", content: "current question" },
    ]);
    assert.deepEqual(JSON.parse(attr(root, "langfuse.observation.output")!), [
      { role: "assistant", content: "answer" },
    ]);
  } finally {
    await service.close();
    await telemetry.close();
    await receiver.close();
  }
});

test("model content preserves nested values and redacts credentials", async (t) => {
  const receiver = await capture(t, (value) => value);
  const { telemetry } = receiver;
  await telemetry.observe(
    {
      name: "model.generate",
      type: "generation",
      input: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "nested text" }] }],
        apiKey: "do-not-export",
      },
    },
    async (observation) => {
      observation.update({
        output: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      });
    },
  );
  await telemetry.close();
  const generation = receiver.spans.find((span) => span.name === "model.generate")!;
  const input = JSON.parse(attr(generation, "langfuse.observation.input")!);
  assert.equal(input.messages[0].content[0].text, "nested text");
  assert.equal(input.apiKey, "[redacted]");
  assert.ok(!JSON.stringify(receiver.spans).includes("do-not-export"));
});
