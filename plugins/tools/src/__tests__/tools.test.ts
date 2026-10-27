import { noopTelemetry } from "@harness/telemetry";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import type { ToolSession } from "@harness";
import { delay } from "@flow";
import { toolsPlugin } from "@plugins/tools/src/index";

async function setup(t: TestContext) {
  const ctx = new Context();
  const sessions: ToolSession[] = [];
  const effects = { executions: 0, wrappers: 0 };
  t.after(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await ctx.fiber.dispose();
  });
  await ctx.plugin(toolsPlugin, {
    telemetry: noopTelemetry,
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

test("tool sessions snapshot bounded plain-text titles without changing tool identifiers", async () => {
  const ctx = new Context();
  const titles = ["  查询资料  ", " ", "a\nb", "a\u2028b", "a\u202eb", "字".repeat(81), undefined];
  const definitions = titles.map((displayName, index) => ({
    name: "tool_" + index,
    displayName,
    description: "Tool description",
    inputSchema: { type: "object" },
    effect: "read" as const,
    timeoutMs: 1000,
    authorize: () => true,
    execute: async () => "ok",
  }));
  try {
    await ctx.plugin(toolsPlugin, { telemetry: noopTelemetry, definitions, sources: [] });
    const context = {
      actor: { userId: "test" },
      runId: "run",
      sessionId: "session",
      signal: new AbortController().signal,
    };
    const first = await ctx.tools.open(context, 1);
    definitions[0]!.displayName = "新标题";
    const second = await ctx.tools.open(context, 1);
    assert.equal(first.definitions[0]!.displayName, "查询资料");
    assert.equal(second.definitions[0]!.displayName, "新标题");
    assert.ok(first.definitions.slice(1).every((tool) => !("displayName" in tool)));
    assert.equal(await first.invoke("call", "tool_0", {}), "ok");
    await Promise.all([first.close(), second.close()]);
  } finally {
    await ctx.fiber.dispose();
  }
});
