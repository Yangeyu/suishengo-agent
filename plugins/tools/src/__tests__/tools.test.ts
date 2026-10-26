import { createTelemetry } from "@plugins/telemetry/src/index";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import type { ToolSession } from "@harness";
import { delay } from "@flow";
import { toolsPlugin } from "@plugins/tools/src/index";

async function setup(t: TestContext) {
  const ctx = new Context();
  ctx.provide("telemetry", createTelemetry());
  const sessions: ToolSession[] = [];
  const effects = { executions: 0, wrappers: 0 };
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await ctx.fiber.dispose();
  });
  await ctx.plugin(toolsPlugin, {
    sources: [],
    definitions: [
      {
        name: "write_fixture",
        description: "Test-only effect",
        effect: "write",
        timeoutMs: 10,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        authorize: (context) => context.actor.userId === "alice",
        async execute(_input, context) {
          effects.executions++;
          await delay(100, context);
          return { done: true };
        },
      },
    ],
  });
  const context = {
    actor: { userId: "alice" },
    runId: "run",
    sessionId: "session",
    signal: new AbortController().signal,
  };
  const open = async (...args: Parameters<typeof ctx.tools.open>) => {
    const session = await ctx.tools.open(...args);
    sessions.push(session);
    return session;
  };
  return { open, context, effects };
}

test("validation and authorization run before tool effects or interceptors", async (t) => {
  const { open, context, effects } = await setup(t);
  const allowed = await open(context, 1);
  const denied = await open({ ...context, actor: { userId: "bob" } }, 1, async () => {
    effects.wrappers++;
    return "cached";
  });
  await assert.rejects(allowed.invoke("invalid", "write_fixture", { value: 1 }), {
    code: "TOOL_INPUT_INVALID",
  });
  await assert.rejects(denied.invoke("denied", "write_fixture", { value: "x" }), {
    code: "TOOL_FORBIDDEN",
  });
  assert.deepEqual(effects, { executions: 0, wrappers: 0 });
});

test("timed-out tool calls consume their budget without retrying", async (t) => {
  const { open, context, effects } = await setup(t);
  const session = await open(context, 1);
  await assert.rejects(session.invoke("timeout", "write_fixture", { value: "x" }), {
    code: "TOOL_FAILED",
  });
  assert.equal(effects.executions, 1);
  await assert.rejects(session.invoke("over-budget", "write_fixture", { value: "x" }), {
    code: "TOOL_LIMIT",
  });
  assert.equal(effects.executions, 1);
});

test("intercepted results must satisfy the tool output limit", async (t) => {
  const { open, context } = await setup(t);
  const session = await open(context, 1, async () => "x".repeat(65537));
  await assert.rejects(session.invoke("output", "write_fixture", { value: "x" }), {
    code: "TOOL_OUTPUT_INVALID",
  });
});
