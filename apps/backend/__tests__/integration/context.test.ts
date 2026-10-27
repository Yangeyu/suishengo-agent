import { compactionPrompt } from "@plugins/context/src/prompts";
import type { AgentMiddleware } from "@harness/execution/middleware";
import type { Actor, Run } from "@harness";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { databaseUrl, prepareDatabase } from "@backend-tests/integration/database";

test(
  "PG compaction: prompt releases, checkpoint reuse, isolation, stale revision and cancellation",
  { skip: !databaseUrl, timeout: 30000 },
  async () => {
    await prepareDatabase();
    const requests: { messages: { role: string; content: string }[] }[] = [];
    let hold = false;
    let promptVersion = 1;
    let started: (() => void) | undefined;
    const server = createServer(async (request, response) => {
      if (request.url?.startsWith("/api/public/v2/prompts/")) {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            name: "context-summary",
            version: promptVersion,
            type: "text",
            config: {},
            labels: [],
            tags: [],
            prompt: compactionPrompt.defaultTemplate + "\n模板版本 " + promptVersion,
          }),
        );
        return;
      }
      if (request.url?.startsWith("/api/public/otel/")) {
        for await (const _part of request) {
          /* Drain the local telemetry protocol fixture. */
        }
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
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
          provider: "dashscope",
          modelId: "deepseek-v4.1-flash",
          maxOutputTokens: 256,
        },
        prompts: {
          bindings: { "context.compaction": { name: "context-summary", label: "production" } },
          cacheTtlSeconds: 0,
        },
        context: {
          compaction: {
            maxSummaryTokens: 128,
            // 使用真实 Provider 的窗口，通过低阈值触发小规模测试历史的压缩。
            triggerFraction: 0.01,
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
        LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
        LANGFUSE_PUBLIC_KEY: "fixture-public",
        LANGFUSE_SECRET_KEY: "fixture-secret",
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

      const previous = await app.sessions.loadSummary(actor, session.id);
      promptVersion = 2;
      const releaseStart = requests.length;
      const updated = await app.runtime.submit(actor, input(session.id, "重新检查出行要求"));
      assert.equal((await wait(actor, updated)).status, "completed");
      const replacement = await app.sessions.loadSummary(actor, session.id);
      assert.ok(replacement && previous);
      assert.notEqual(replacement.policyVersion, previous.policyVersion);
      assert.ok(replacement.revision > previous.revision);
      const summaries = requests
        .slice(releaseStart)
        .filter((request) => request.messages[0]!.content.startsWith("压缩以下对话资料"));
      assert.ok(summaries.length > 0);
      assert.ok(summaries.every((request) => request.messages[0]!.content.endsWith("模板版本 2")));
      assert.ok(
        summaries.some((request) =>
          request.messages.some((message) => message.content.includes("第 0 轮")),
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
