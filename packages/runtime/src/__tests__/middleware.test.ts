import type { AgentMiddleware } from "@harness/execution/middleware";
import type { RunScope } from "@harness/scope";
import type { ModelRequest, Models } from "@harness/models";
import test from "node:test";
import assert from "node:assert/strict";
import { openMiddleware, notifyRun } from "@runtime/middleware";

const history = { turns: [], summaryRevision: 0 };

const model = { id: "fixture", contextWindow: 10000, maxOutputTokens: 100 };
const request: ModelRequest = {
  model,
  purpose: "conversation",
  maxOutputTokens: 100,
  context: {
    system: "system",
    messages: [{ role: "user", text: "question" }],
    tools: [{ name: "lookup", description: "read", inputSchema: { type: "object" } }],
  },
};
function scope(userId: string, signal = new AbortController().signal): RunScope {
  return {
    actor: { userId },
    runId: userId,
    sessionId: userId,
    signal,
    budget: { remaining: 10000, record() {} },
  };
}

// Registration-only extension: no runtime or Pi modifications for request, model and tool policies.
test("middleware composes in order, isolates concurrent state, and closes provider before final hooks", async () => {
  const events: string[] = [];
  const models: Models = {
    resolve: () => model,
    async generate(input, scope) {
      assert.match(input.context.system, /A:B$/);
      events.push(scope.runId + ":provider");
      try {
        return {
          message: { role: "assistant", content: [] },
          finishReason: "stop",
          usage: { input: 0, output: 0, total: 0 },
        };
      } finally {
        events.push(scope.runId + ":closed");
      }
    },
  };
  const extension = (name: string): AgentMiddleware => ({
    name,
    create(scope) {
      let count = 0;
      const mark = (event: string) => events.push(scope.runId + ":" + name + ":" + event);
      return {
        beforeAgent() {
          mark("start");
        },
        beforeModel(input) {
          mark("before:" + ++count);
          return { ...input.context, system: input.context.system + ":" + name };
        },
        async wrapModelCall(input, next) {
          mark("enter");
          const result = await next(input);
          mark("exit");
          return result;
        },
        afterModel() {
          mark("after");
        },
        async wrapToolCall(call, next) {
          mark("tool");
          return next(call);
        },
        afterAgent() {
          mark("finish");
        },
        dispose() {
          mark("dispose");
        },
      };
    },
  });
  await Promise.all(
    ["alice", "bob"].map(async (user) => {
      const run = await openMiddleware(
        scope(user),
        history,
        [extension("A"), extension("B")],
        models,
      );
      try {
        await run.start();
        await run.execution.model(request);
        await run.execution.tool({ name: "lookup", callId: "1", input: {} }, async () => "ok");
        await run.finish();
      } finally {
        await run.close();
      }
    }),
  );
  for (const user of ["alice", "bob"])
    assert.deepEqual(
      events
        .filter((item) => item.startsWith(user + ":"))
        .map((item) => item.slice(user.length + 1)),
      [
        "A:start",
        "B:start",
        "A:before:1",
        "B:before:1",
        "A:enter",
        "B:enter",
        "provider",
        "closed",
        "B:exit",
        "A:exit",
        "B:after",
        "A:after",
        "A:tool",
        "B:tool",
        "B:finish",
        "A:finish",
        "B:dispose",
        "A:dispose",
      ],
    );
});

test("late wrapper failures suppress final commit; cancellation closes streams and failed setup disposes instances", async () => {
  let closed = 0;
  const models: Models = {
    resolve: () => model,
    async generate() {
      try {
        return {
          message: { role: "assistant", content: [] },
          finishReason: "stop",
          usage: { input: 0, output: 0, total: 0 },
        };
      } finally {
        closed++;
      }
    },
  };
  const run = await openMiddleware(
    scope("alice"),
    history,
    [
      {
        name: "failure",
        create: () => ({
          async wrapModelCall(input, next) {
            await next(input);
            throw new Error("late failure");
          },
        }),
      },
    ],
    models,
  );
  let finals = 0;
  await assert.rejects(async () => {
    await run.execution.model(request);
    finals++;
  }, /late failure/);
  assert.equal(finals, 0);
  assert.equal(closed, 1);
  await run.close();

  let disposed = 0;
  await assert.rejects(
    openMiddleware(
      scope("alice"),
      history,
      [
        {
          name: "first",
          create: () => ({
            dispose() {
              disposed++;
            },
          }),
        },
        {
          name: "second",
          create() {
            throw new Error("setup");
          },
        },
      ],
      models,
    ),
    /setup/,
  );
  assert.equal(disposed, 1);

  const cancelled = await openMiddleware(scope("alice"), history, [], models);
  cancelled.execution.abort();
  await assert.rejects(cancelled.execution.model(request), { name: "AbortError" });
  await cancelled.close();
});

test("tool execution cannot repeat or widen a prepared grant; notifications do not delay the run", async () => {
  const models: Models = {
    resolve: () => model,
    async generate() {
      return {
        message: { role: "assistant", content: [] },
        finishReason: "stop",
        usage: { input: 0, output: 0, total: 0 },
      };
    },
  };
  const run = await openMiddleware(
    scope("alice"),
    history,
    [
      {
        name: "repeat",
        create: () => ({
          async wrapToolCall(call, next) {
            await next(call);
            return next(call);
          },
        }),
      },
    ],
    models,
  );
  await run.execution.model(request);
  let writes = 0;
  await assert.rejects(
    run.execution.tool({ name: "lookup", callId: "1", input: {} }, async () => {
      writes++;
      return "ok";
    }),
    { code: "MIDDLEWARE_REENTRY" },
  );
  assert.equal(writes, 1);
  await assert.rejects(
    run.execution.tool({ name: "unlisted", callId: "2", input: {} }, async () => "bad"),
    { code: "TOOL_FORBIDDEN" },
  );
  await run.close();
  const recovery = await openMiddleware(
    scope("alice"),
    history,
    [
      {
        name: "recover",
        create: () => ({
          async wrapToolCall(call, next) {
            try {
              return await next(call);
            } catch {
              return { handled: true };
            }
          },
        }),
      },
    ],
    models,
  );
  await recovery.execution.model(request);
  assert.deepEqual(
    await recovery.execution.tool({ name: "lookup", callId: "3", input: {} }, async () => {
      throw new Error("tool failed");
    }),
    { handled: true },
  );
  await recovery.close();
  let observed = false;
  notifyRun(
    [
      {
        name: "observer",
        create: () => ({}),
        onRunEvent() {
          observed = true;
          return new Promise(() => {});
        },
      },
    ],
    {
      type: "finished",
      actor: { userId: "alice" },
      runId: "run",
      sessionId: "session",
      status: "completed",
    },
  );
  await Promise.resolve();
  assert.equal(observed, true);
});
