import { noopTelemetry } from "@harness/telemetry";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { SignJWT } from "jose";
import type { Actor, RunStatus } from "@harness";
import type { SessionSearchResult } from "@harness/sessions";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { databaseUrl, prepareDatabase } from "@backend-tests/integration/database";
import { toolsPlugin } from "@plugins/tools/src/index";
import type { ChatSnapshot } from "@backend/http/ai-sdk";

test(
  "current-session search: PG isolation, original text, bounds and HTTP tool replay",
  {
    skip: !databaseUrl,
    timeout: 30000,
  },
  async () => {
    await prepareDatabase();
    const requests: {
      tools: { function: { name: string } }[];
      messages: { role: string; content: string }[];
    }[] = [];
    const model = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as (typeof requests)[number];
      requests.push(input);
      const finished = input.messages.at(-1)?.role === "tool";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            id: "search-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                delta: finished
                  ? { role: "assistant", content: "历史检索完成。" }
                  : {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "search-call",
                          type: "function",
                          function: {
                            name: "search_current_session",
                            arguments: JSON.stringify({ query: "外滩", limit: 2 }),
                          },
                        },
                      ],
                    },
                finish_reason: finished ? "stop" : "tool_calls",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const modelUrl = "http://127.0.0.1:" + (model.address() as { port: number }).port;
    const config = resolveConfig(
      { model: { provider: "dashscope", modelId: "deepseek-v4.1-flash", maxOutputTokens: 4096 } },
      {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: "session-search-test-only-secret-thirty-two",
        DASHSCOPE_API_KEY: "fixture-key",
        DASHSCOPE_BASE_URL: modelUrl + "/v1",
      },
    );
    config.http.port = 0;
    const ctx = new Context();
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      app = await createApplication(config);
      const store = app.sessions;
      const alice = { userId: "search-alice-" + randomUUID() };
      const bob = { userId: "search-bob-" + randomUUID() };
      const session = await store.create(alice, "search");
      const otherSession = await store.create(alice, "other session");
      const bobSession = await store.create(bob, "other user");
      const seed = async (
        actor: Actor,
        sessionId: string,
        text: string,
        status: Exclude<RunStatus, "running"> = "completed",
        answer = "好的。",
      ) => {
        const { run } = await store.admit(actor, {
          sessionId,
          text,
          requestId: randomUUID(),
          userMessageId: randomUUID(),
        });
        await store.append(run, {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "hidden-only-reasoning" },
              {
                type: "tool-call",
                id: "seed-call",
                name: "fixture",
                input: { secret: "hidden-only-argument" },
              },
              { type: "text", text: answer },
            ],
            source: {
              provider: "fixture",
              model: "fixture",
              adapter: "fixture",
              replay: "hidden-only-replay",
            },
          },
        });
        await store.append(run, {
          type: "message",
          message: {
            role: "tool",
            callId: "seed-call",
            name: "fixture",
            output: "hidden-only-output",
            isError: false,
          },
        });
        await store.finish(run, status);
        return run;
      };
      const old = await seed(
        alice,
        session.id,
        "计划周六去外滩，预算 100%_O'Reilly。",
        "completed",
        "可以先到外滩。",
      );
      await store.saveSummary(
        alice,
        session.id,
        {
          throughPosition: old.position,
          text: "用户讨论过出行。",
          policyVersion: "test",
          modelId: "fixture",
        },
        0,
        new AbortController().signal,
      );
      await seed(alice, otherSession.id, "外滩 sibling-secret");
      await seed(bob, bobSession.id, "外滩 bob-secret");
      for (const status of ["failed", "cancelled", "interrupted"] as const)
        await seed(alice, session.id, "外滩 excluded-" + status, status);
      const long = await seed(
        alice,
        session.id,
        "长文",
        "completed",
        "甲".repeat(1800) + "外滩" + "乙".repeat(1400),
      );
      const { run: current } = await store.admit(alice, {
        sessionId: session.id,
        text: "外滩 current-only",
        requestId: randomUUID(),
        userMessageId: randomUUID(),
      });
      const signal = new AbortController().signal;
      const search = (query: string, limit?: number) =>
        store.search(alice, current.id, { query, limit }, signal);
      const results = await search("外滩");
      assert.equal(results.matches.length, 3);
      assert.deepEqual(
        results.matches.map((m) => m.runId),
        [long.id, old.id, old.id],
      );
      assert.deepEqual(
        results.matches.map((m) => m.role),
        ["assistant", "assistant", "user"],
      );
      assert.ok(results.matches.every((m) => m.messageId && m.excerpt.includes("外滩")));
      assert.equal(Array.from(results.matches[0]!.excerpt).length, 1000);
      assert.equal(results.matches[0]!.truncated, true);
      assert.equal(results.matches[1]!.truncated, false);
      assert.equal((await search("外滩", 1)).hasMore, true);
      assert.equal((await search("外滩", 3)).hasMore, false);
      assert.equal((await search("  o'reilly  ")).matches.length, 1);
      assert.equal((await search("%_")).matches.length, 1);
      for (const query of [
        "hidden-only",
        "sibling-secret",
        "bob-secret",
        "excluded-",
        "current-only",
        "' OR true --",
        "不存在",
      ])
        assert.deepEqual(await search(query), { matches: [], hasMore: false });
      await assert.rejects(store.search(bob, current.id, { query: "外滩" }, signal), {
        code: "NOT_FOUND",
      });
      await assert.rejects(search(" "), { code: "INVALID_INPUT" });
      await assert.rejects(search("x".repeat(201)), { code: "INVALID_INPUT" });
      await assert.rejects(search("外滩", 11), { code: "INVALID_INPUT" });
      await assert.rejects(
        store.search(alice, current.id, { query: "外滩" }, AbortSignal.abort()),
        { name: "AbortError" },
      );

      await ctx.plugin(toolsPlugin, { telemetry: noopTelemetry, sessions: store, sources: [] });
      const context = { actor: alice, runId: current.id, sessionId: session.id, signal };
      const tool = await ctx.tools.open(context, 12);
      assert.deepEqual(
        tool.definitions.map(({ name, displayName }) => ({ name, displayName })),
        [{ name: "search_current_session", displayName: "检索当前会话" }],
      );
      assert.deepEqual(
        await tool.invoke("valid", "search_current_session", { query: "外滩" }),
        results,
      );
      for (const input of [
        { query: " " },
        { query: "外滩", sessionId: otherSession.id },
        { query: "外滩", userId: bob.userId },
        { query: "外滩", runId: old.id },
        { query: "外滩", limit: 100 },
      ])
        await assert.rejects(tool.invoke("invalid", "search_current_session", input), {
          code: "TOOL_INPUT_INVALID",
        });
      const mismatched = await ctx.tools.open({ ...context, sessionId: otherSession.id }, 1);
      await assert.rejects(
        mismatched.invoke("invalid-scope", "search_current_session", { query: "外滩" }),
        { code: "TOOL_FORBIDDEN" },
      );
      const foreign = await ctx.tools.open({ ...context, actor: bob }, 1);
      await assert.rejects(foreign.invoke("foreign", "search_current_session", { query: "外滩" }), {
        code: "NOT_FOUND",
      });
      await Promise.all([tool.close(), mismatched.close(), foreign.close()]);
      await store.finish(current, "completed");
      await seed(alice, session.id, "future-only");
      assert.deepEqual(await search("future-only"), { matches: [], hasMore: false });

      const base = await app.listen();
      const token = await new SignJWT({})
        .setSubject(alice.userId)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(config.auth.issuer)
        .setAudience(config.auth.audience)
        .setIssuedAt()
        .sign(new TextEncoder().encode(config.auth.authSecret));
      const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
      const capabilities = await (await fetch(base + "/api/capabilities", { headers })).json();
      assert.equal(capabilities.businessTools, false);
      const response = await fetch(base + "/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: session.id,
          requestId: randomUUID(),
          message: {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "检索之前提到的地点" }],
          },
        }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      const runId = response.headers.get("x-run-id")!;
      assert.equal((await store.getRun(alice, runId)).status, "completed");
      assert.equal(requests.length, 2);
      assert.deepEqual(
        requests[0]!.tools.map((t) => t.function.name),
        ["search_current_session"],
      );
      const output = JSON.parse(requests[1]!.messages.at(-1)!.content) as SessionSearchResult;
      assert.equal(output.matches.length, 2);
      assert.ok(output.matches.every((m) => m.excerpt.includes("外滩")));
      assert.match(stream, /search_current_session/);
      assert.match(stream, /"toolMetadata":\{"displayName":"检索当前会话"\}/);
      assert.ok(!JSON.stringify(requests).includes("displayName"));
      const snapshot = (await (
        await fetch(base + "/api/sessions/" + session.id, { headers })
      ).json()) as ChatSnapshot;
      const displayedTool = snapshot.messages
        .find((message) => message.id === runId)
        ?.parts.find((part) => part.type === "dynamic-tool");
      assert.ok(displayedTool?.type === "dynamic-tool");
      assert.equal(displayedTool.toolName, "search_current_session");
      assert.deepEqual(displayedTool.toolMetadata, { displayName: "检索当前会话" });
      assert.equal(
        await (await fetch(base + "/api/runs/" + runId + "/stream", { headers })).text(),
        stream,
      );
    } finally {
      await ctx.fiber.dispose();
      await app?.close();
      model.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        model.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
