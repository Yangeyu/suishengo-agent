import { createTelemetry } from "@plugins/telemetry/src/index";
import type { RunScope } from "@harness/scope";
import type { AgentEvent, AgentExecutor } from "@harness";
import { piModels } from "@plugins/pi/src/model/index";
import { createBailianProvider } from "@plugins/pi/src/model/providers/bailian";
import { openMiddleware } from "@runtime/middleware";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { createModels } from "@earendil-works/pi-ai";
import { pi } from "@plugins/pi/src/loop/index";
import { toolsPlugin } from "@plugins/tools/src/index";

test("Pi agent protocol", { timeout: 15000 }, async (t) => {
  let mode: "text" | "tool" | "loop" | "reject" | "hold" = "text";
  const received: {
    model: string;
    max_tokens: number;
    messages: { role: string; content: unknown }[];
  }[] = [];
  const credentials: (string | undefined)[] = [];
  let executions = 0;
  let streaming: (() => void) | undefined;

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as (typeof received)[number];
    received.push(input);
    credentials.push(request.headers.authorization);

    if (mode === "reject") {
      response
        .writeHead(401)
        .end(JSON.stringify({ error: { message: "invalid test credential" } }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        "data: " +
          JSON.stringify({
            id: "test",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );

    if (mode === "loop" || (mode === "tool" && input.messages.at(-1)?.role !== "tool")) {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_" + received.length,
            type: "function",
            function: { name: "lookup", arguments: '{"query":"hello"}' },
          },
        ],
      });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", reasoning_content: "需要分析问题。" });
      send({ role: "assistant", content: "hello " });
      if (mode === "hold") {
        streaming?.();
        return;
      }
      send({ content: "world" });
      send({}, "stop");
    }

    response.write(
      "data: " +
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }) +
        "\n\n",
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const ctx = new Context();
  const telemetry = createTelemetry();
  ctx.provide("telemetry", telemetry);
  const steps: { index: number; status?: string }[] = [];

  try {
    await ctx.plugin(toolsPlugin, {
      sources: [],
      definitions: [
        {
          name: "lookup",
          description: "Fixture lookup",
          effect: "read",
          timeoutMs: 1000,
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
          authorize: (context) => context.actor.userId === "alice",
          async execute(args, context) {
            executions++;
            return { query: args.query!, owner: context.actor.userId };
          },
        },
      ],
    });
    await ctx.plugin(piModels, {
      provider: createBailianProvider({
        apiKey: "fixture-key",
        baseUrl: "http://127.0.0.1:" + address.port + "/v1",
      }),
      modelId: "deepseek-v4.1-flash",
      maxOutputTokens: 2048,
    });

    await ctx.plugin(pi);
    const events: AgentEvent[] = [];
    const input: Omit<Parameters<AgentExecutor["run"]>[0], "tools" | "execution"> &
      Pick<RunScope, "actor" | "runId" | "sessionId" | "signal"> = {
      actor: { userId: "alice" },
      runId: "run",
      sessionId: "session",
      system: "system instruction",
      messages: [{ role: "user", text: "question" }],
      limits: { maxSteps: 3, maxToolCalls: 2, maxTokens: 10000 },
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
    };
    const run = async (overrides: Partial<typeof input> = {}) => {
      const current = { ...input, ...overrides };
      const { actor, runId, sessionId, signal, ...agentInput } = current;
      let used = 0;
      const middleware = await openMiddleware(
        {
          actor,
          runId,
          sessionId,
          signal,
          budget: {
            get remaining() {
              return current.limits.maxTokens - used;
            },
            record(tokens) {
              used += tokens;
            },
          },
        },
        { turns: [], summaryRevision: 0 },
        [],
        ctx.models,
        telemetry,
      );
      const startStep = middleware.execution.startStep;
      middleware.execution.startStep = (index) => {
        const step = startStep(index);
        const state = { index, status: undefined as string | undefined };
        steps.push(state);
        return {
          ...step,
          end(outcome) {
            state.status = outcome.status;
            step.end(outcome);
          },
        };
      };
      const tools = await ctx.tools.open(
        middleware.execution.scope,
        current.limits.maxToolCalls,
        middleware.execution.tool,
      );
      try {
        await ctx.agent.run({
          ...agentInput,
          tools,
          execution: middleware.execution,
        });
      } finally {
        await tools.close();
        await middleware.close();
      }
    };

    t.beforeEach(() => {
      mode = "text";
      received.length = 0;
      credentials.length = 0;
      events.length = 0;
      steps.length = 0;
      executions = 0;
      streaming = undefined;
    });

    await t.test(
      "streams text and reasoning with the selected model and output limit",
      async () => {
        await run();
        assert.equal(
          events
            .filter((event) => event.type === "text-delta")
            .map((event) => event.delta)
            .join(""),
          "hello world",
        );
        assert.equal(received.at(-1)?.model, "deepseek-v4.1-flash");
        assert.equal(received.at(-1)?.max_tokens, 2048);
        assert.equal(credentials.at(-1), "Bearer fixture-key");
        assert.equal(received.at(-1)?.messages.at(-1)?.content, "question");
        assert.ok(events.some((event) => event.type === "reasoning-delta"));
      },
    );

    await t.test("summary calls use the provider and report usage", async () => {
      const summary = await ctx.models.generate(
        {
          model: ctx.models.resolve(),
          purpose: "compaction",
          maxOutputTokens: 128,
          context: { system: "Summarize", messages: [], tools: [] },
        },
        {
          actor: { userId: "alice" },
          runId: "summary",
          sessionId: "session",
          signal: new AbortController().signal,
          budget: { remaining: 1000, record() {} },
        },
      );
      assert.deepEqual(summary.usage, { input: 10, output: 5, total: 15 });
      assert.equal(received.at(-1)?.max_tokens, 128);
      assert.equal(credentials.at(-1), "Bearer fixture-key");
      assert.equal(summary.message.source?.provider, "dashscope");
    });

    await t.test("authorized tools feed their result into the next model step", async () => {
      mode = "tool";
      await run();
      assert.equal(executions, 1);
      assert.deepEqual(JSON.parse(String(received.at(-1)?.messages.at(-1)?.content)), {
        query: "hello",
        owner: "alice",
      });
      assert.deepEqual(steps, [
        { index: 1, status: "completed" },
        { index: 2, status: "completed" },
      ]);
      assert.deepEqual(
        events.filter((event) => event.type === "step-start").map((event) => event.step),
        [1, 2],
      );
    });

    await t.test("unauthorized tool calls return an error without executing the tool", async () => {
      mode = "tool";
      await run({ actor: { userId: "bob" } });
      assert.equal(executions, 0);
      assert.ok(
        events.some(
          (event) =>
            event.type === "message" && event.message.role === "tool" && event.message.isError,
        ),
      );
    });

    await t.test("failed message persistence prevents subsequent tool effects", async () => {
      mode = "tool";
      await assert.rejects(
        run({
          onEvent: async (event) => {
            if (event.type === "message" && event.message.role === "assistant")
              throw new Error("persistence failed");
          },
        }),
        /persistence failed/,
      );
      assert.equal(executions, 0);
    });

    await t.test("model and tool loops stop at their execution limits", async () => {
      mode = "loop";
      await assert.rejects(run({ limits: { ...input.limits, maxSteps: 1 } }), {
        code: "AGENT_LIMIT",
      });
      await assert.rejects(run({ limits: { ...input.limits, maxToolCalls: 1 } }), {
        code: "TOOL_LIMIT",
      });
    });

    await t.test("provider failures terminate the run", async () => {
      mode = "reject";
      await assert.rejects(run(), { code: "MODEL_FAILED" });
    });

    await t.test("cancellation closes the streaming model call and active step", async () => {
      mode = "hold";
      const controller = new AbortController();
      const started = new Promise<void>((resolve) => {
        streaming = resolve;
      });
      const rejected = assert.rejects(run({ signal: controller.signal }), { name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      assert.deepEqual(steps, [{ index: 1, status: "cancelled" }]);
    });
  } finally {
    await ctx.fiber.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Bailian provider instances isolate injected credentials, endpoints and model definitions", async () => {
  const first = createModels();
  const second = createModels();
  first.setProvider(createBailianProvider({ apiKey: "first-fixture" }));
  second.setProvider(
    createBailianProvider({ apiKey: "second-fixture", baseUrl: "http://localhost:9000/v1" }),
  );
  const model = first.getModel("dashscope", "deepseek-v4.1-flash")!;
  const other = second.getModel("dashscope", model.id)!;
  assert.equal(model.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(other.baseUrl, "http://localhost:9000/v1");
  const auth = await Promise.all([first.getAuth(model), second.getAuth(other)]);
  assert.equal(auth[0]?.auth.apiKey, "first-fixture");
  assert.equal(auth[1]?.auth.apiKey, "second-fixture");
  assert.equal(first.getModel("dashscope", "unknown"), undefined);
});
