import { createTelemetry } from "@plugins/telemetry/src/index";
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { delay } from "@flow";
import { toolsPlugin } from "@plugins/tools/src/index";

test("tool validation, authorization and timeout precede effects without retries", async () => {
  const ctx = new Context();
  let executions = 0;
  const telemetry = createTelemetry();

  try {
    ctx.provide("telemetry", telemetry);
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
            executions++;
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
    const allowed = await ctx.tools.open(context, 2);
    let wrappers = 0;
    const denied = await ctx.tools.open({ ...context, actor: { userId: "bob" } }, 2, async () => {
      wrappers++;
      return "cached";
    });

    await assert.rejects(allowed.invoke("invalid", "write_fixture", { value: 1 }), {
      code: "TOOL_INPUT_INVALID",
    });
    await assert.rejects(denied.invoke("denied", "write_fixture", { value: "x" }), {
      code: "TOOL_FORBIDDEN",
    });
    assert.equal(executions, 0);
    assert.equal(wrappers, 0);

    await assert.rejects(allowed.invoke("timeout", "write_fixture", { value: "x" }), {
      code: "TOOL_FAILED",
    });
    assert.equal(executions, 1);
    await assert.rejects(allowed.invoke("over-budget", "write_fixture", { value: "x" }), {
      code: "TOOL_LIMIT",
    });
    assert.equal(executions, 1);
    const oversized = await ctx.tools.open(context, 1, async () => "x".repeat(65537));
    await assert.rejects(oversized.invoke("output", "write_fixture", { value: "x" }), {
      code: "TOOL_OUTPUT_INVALID",
    });
    await oversized.close();
    await allowed.close();
    await denied.close();
  } finally {
    await ctx.fiber.dispose();
  }
});
