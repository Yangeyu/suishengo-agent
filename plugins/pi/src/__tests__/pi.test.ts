import type { RunScope } from "@harness/scope";
import type { AgentEvent, AgentExecutor, Telemetry } from "@harness";
import { piModels } from "@plugins/pi/src/model/index";
import { openMiddleware } from "@runtime/middleware";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { pi } from "@plugins/pi/src/loop/index";
import { toolsPlugin } from "@plugins/tools/src/index";

test(
  "Pi streams text, loops through authorized tools, enforces budgets and propagates failures",
  { timeout: 15000 },
  async () => {
    let mode: "text" | "tool" | "loop" | "reject" | "hold" = "text";
    const received: { model: string; messages: { role: string; content: unknown }[] }[] = [];
    const observed: string[] = [];
    let executions = 0;
    let streaming: (() => void) | undefined;

    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as (typeof received)[number];
      received.push(input);

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
        send({ role: "assistant", content: "hello " });
        if (mode === "hold") {
          streaming?.();
          return;
        }
        send({ content: "world" });
        send({}, "stop");
      }

      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const previous = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = "fixture-key";
    const ctx = new Context();
    const telemetry: Telemetry = {
      start: () => ({ within: (task) => task(), end() {} }),
      observe: async (name, _attributes, task) => {
        observed.push(name);
        return task();
      },
      close: async () => {},
    };

    try {
      await ctx.plugin(toolsPlugin, {
        telemetry,
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
        baseUrl: "http://127.0.0.1:" + address.port + "/v1",
        modelId: "fixture",
        contextWindow: 128000,
        maxOutputTokens: 2048,
        telemetry,
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
        );
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

      await run();
      assert.equal(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.delta)
          .join(""),
        "hello world",
      );
      assert.equal(received.at(-1)?.model, "fixture");
      assert.equal(received.at(-1)?.messages.at(-1)?.content, "question");

      mode = "tool";
      events.length = 0;
      await run();
      assert.equal(executions, 1);
      assert.deepEqual(JSON.parse(String(received.at(-1)?.messages.at(-1)?.content)), {
        query: "hello",
        owner: "alice",
      });
      assert.equal(events.filter((event) => event.type === "step-start").length, 2);
      assert.ok(observed.includes("model.generate") && observed.includes("tool.execute"));

      events.length = 0;
      await run({ actor: { userId: "bob" } });
      assert.equal(executions, 1);
      assert.ok(
        events.some(
          (event) =>
            event.type === "message" && event.message.role === "tool" && event.message.isError,
        ),
      );

      const beforeFailure = executions;
      await assert.rejects(
        run({
          onEvent: async (event) => {
            if (event.type === "message" && event.message.role === "assistant")
              throw new Error("persistence failed");
          },
        }),
        /persistence failed/,
      );
      assert.equal(executions, beforeFailure);

      mode = "loop";
      await assert.rejects(run({ limits: { ...input.limits, maxSteps: 1 } }), {
        code: "AGENT_LIMIT",
      });
      await assert.rejects(run({ limits: { ...input.limits, maxToolCalls: 1 } }), {
        code: "TOOL_LIMIT",
      });

      mode = "reject";
      await assert.rejects(run(), { code: "MODEL_FAILED" });

      mode = "hold";
      const controller = new AbortController();
      const started = new Promise<void>((resolve) => {
        streaming = resolve;
      });
      const rejected = assert.rejects(run({ signal: controller.signal }), { name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
    } finally {
      await ctx.fiber.dispose();
      if (previous === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = previous;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
