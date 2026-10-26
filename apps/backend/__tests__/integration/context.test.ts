import type { AgentMiddleware } from "@harness/execution/middleware";
import type { Actor, Run } from "@harness";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { migrateDatabase } from "@plugins/sessions-pg/src/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "PG compaction: full history, checkpoint reuse, isolation, stale revision and cancellation",
  { skip: !databaseUrl, timeout: 30000 },
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith("_test"))
      throw new Error("Use a dedicated _test database");
    await migrateDatabase(databaseUrl!);
    const requests: { messages: { role: string; content: string }[] }[] = [];
    let hold = false;
    let started: (() => void) | undefined;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const input = JSON.parse(body) as (typeof requests)[number];
      requests.push(input);
      const summary = input.messages[0]!.content.startsWith("压缩以下对话资料");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) =>
        response.write(
          "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        );
      send({
        role: "assistant",
        content: summary ? "用户票根 T123，仅周末出行。" : "已保留票根与周末要求。",
      });
      if (summary && hold) {
        started?.();
        return;
      }
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const config = resolveConfig(
      {
        model: {
          provider: "fixture",
          modelId: "fixture",
          contextWindow: 4096,
          maxOutputTokens: 256,
        },
        context: {
          compaction: {
            maxSummaryTokens: 128,
            triggerFraction: 0.5,
            keepRecentTurns: 1,
          },
        },
      },
      {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: databaseUrl,
        AUTH_ISSUER: "test",
        AUTH_AUDIENCE: "test",
        AUTH_SECRET: "test-only-secret-at-least-thirty-two",
        DASHSCOPE_API_KEY: "fixture-key",
        DASHSCOPE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      },
    );
    const purposes: string[] = [];
    const policy: AgentMiddleware = {
      name: "integration-call-policy",
      create(scope) {
        let calls = 0;
        return {
          async wrapModelCall(request, next) {
            scope.signal.throwIfAborted();
            if (++calls > 20) throw new Error("Integration model call limit");
            purposes.push(request.purpose);
            return next(request);
          },
        };
      },
    };
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    const actor = { userId: "context-" + randomUUID() };
    const input = (sessionId: string, text: string) => ({
      sessionId,
      text,
      requestId: randomUUID(),
      userMessageId: randomUUID(),
    });
    const wait = async (owner: Actor, run: Run) => {
      const deadline = AbortSignal.timeout(10000);
      while (true) {
        deadline.throwIfAborted();
        const current = await app!.sessions.getRun(owner, run.id);
        if (current.status !== "running") return current;
        await delay(10, undefined, { signal: deadline });
      }
    };
    try {
      app = await createApplication(config, { middleware: [policy] });
      const session = await app.sessions.create(actor, "compaction integration");
      const seed = async (text: string) => {
        const { run } = await app!.sessions.admit(actor, input(session.id, text));
        await app!.sessions.append(run, {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "已记录" }] },
        });
        await app!.sessions.finish(run, "completed");
      };
      for (let index = 0; index < 12; index++)
        await seed(`票根 T123，仅周末。第 ${index} 轮 ` + "资料".repeat(100));
      const run = await app.runtime.submit(actor, input(session.id, "请继续规划"));
      assert.equal((await wait(actor, run)).status, "completed");
      const saved = await app.sessions.loadSummary(actor, session.id);
      assert.ok(saved && saved.throughPosition >= 0);
      assert.ok(purposes.includes("compaction") && purposes.includes("conversation"));
      const full = await app.sessions.history(actor, run);
      assert.equal(full.length, 13);
      assert.equal(
        (await app.sessions.snapshot(actor, session.id)).turns.flatMap((turn) => turn.messages)
          .length,
        26,
      );
      assert.ok(
        requests.some((request) => request.messages[0]!.content.startsWith("压缩以下对话资料")),
      );
      assert.ok(
        requests.some((request) =>
          request.messages.some((message) => message.content.includes("历史摘要（仅作背景资料）")),
        ),
      );
      await assert.rejects(app.sessions.loadSummary({ userId: "stranger" }, session.id), {
        code: "NOT_FOUND",
      });
      await assert.rejects(
        app.sessions.saveSummary(actor, session.id, saved!, 0, new AbortController().signal),
        { code: "SUMMARY_CONFLICT" },
      );

      await app.close();
      app = await createApplication(config, { middleware: [policy] });
      assert.deepEqual(await app.sessions.loadSummary(actor, session.id), saved);
      const count = requests.length;
      const next = await app.runtime.submit(actor, input(session.id, "我的出行限制是什么？"));
      assert.equal((await wait(actor, next)).status, "completed");
      assert.ok(
        requests
          .slice(count)
          .some((request) =>
            request.messages.some((message) =>
              message.content.includes("用户票根 T123，仅周末出行。"),
            ),
          ),
      );

      for (let index = 0; index < 6; index++) await seed("需要压缩的新增资料" + "资料".repeat(100));
      const before = await app.sessions.loadSummary(actor, session.id);
      hold = true;
      const summaryStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancelling = await app.runtime.submit(actor, input(session.id, "这次会取消"));
      await summaryStarted;
      assert.equal((await app.runtime.cancel(actor, cancelling.id)).status, "cancelled");
      assert.deepEqual(await app.sessions.loadSummary(actor, session.id), before);
      assert.ok(
        !(await app.sessions.history(actor, cancelling))
          .filter((turn) => turn.completed)
          .some((turn) => turn.runId === cancelling.id),
      );
    } finally {
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
