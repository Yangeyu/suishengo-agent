import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { databaseUrl, prepareDatabase } from "@backend-tests/integration/database";
import { createFixtures, actorSecret, serviceToken } from "@backend-tests/integration/fixtures";
import type { ChatSnapshot, MessageMetadata } from "@backend/http/ai-sdk";

test(
  "HTTP → Pi → MCP → PG → AI SDK: actor isolation, tool history and replay",
  { skip: !databaseUrl, timeout: 30000 },
  async () => {
    await prepareDatabase();

    const fixtures = await createFixtures();
    const config = resolveConfig(
      {
        model: {
          provider: "dashscope",
          modelId: "deepseek-v4.1-flash",
          maxOutputTokens: 4096,
        },
        tools: { mcp: { allowedTools: ["lookup"] } },
      },
      {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: databaseUrl,
        AUTH_ISSUER: "integration",
        AUTH_AUDIENCE: "suishengo-agent",
        AUTH_SECRET: "integration-jwt-secret-thirty-two-characters",
        DASHSCOPE_API_KEY: "fixture-key",
        DASHSCOPE_BASE_URL: fixtures.modelUrl + "/v1",
        MCP_URL: fixtures.mcpUrl + "/mcp",
        MCP_SERVICE_TOKEN: serviceToken,
        MCP_ACTOR_SECRET: actorSecret,
        MCP_AUDIENCE: "fixture-mcp",
      },
    );
    config.http.port = 0;
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;

    try {
      app = await createApplication(config);
      const base = await app.listen();
      const credentials = await Promise.all(
        ["alice", "bob"].map((userId) =>
          new SignJWT({})
            .setSubject(userId)
            .setProtectedHeader({ alg: "HS256" })
            .setIssuer(config.auth.issuer)
            .setAudience(config.auth.audience)
            .setIssuedAt()
            .sign(new TextEncoder().encode(config.auth.authSecret)),
        ),
      );
      const call = (credential: string, path: string, body?: unknown) =>
        fetch(base + "/api" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const sessions = await Promise.all(
        credentials.map(async (credential) => {
          const response = await call(credential, "/sessions", { title: "tool integration" });
          assert.equal(response.status, 201);
          return ((await response.json()) as { id: string }).id;
        }),
      );
      const input = (sessionId: string, text: string) => ({
        sessionId,
        requestId: randomUUID(),
        message: {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text }],
        },
      });

      // 两个用户并发触发同一工具，远端必须从服务端签名身份分别授权。
      const answers = await Promise.all(
        credentials.map(async (credential, index) => {
          const owner = index === 0 ? "alice" : "bob";
          const response = await call(
            credential,
            "/chat",
            input(sessions[index]!, owner + "-query"),
          );
          assert.equal(response.status, 200);
          const runId = response.headers.get("x-run-id")!;
          const stream = await response.text();
          const chunks = stream
            .split("\n")
            .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
            .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk);
          let reconstructed: UIMessage<MessageMetadata> | undefined;

          for await (const message of readUIMessageStream<UIMessage<MessageMetadata>>({
            stream: new ReadableStream({
              start(controller) {
                chunks.forEach((chunk) => controller.enqueue(chunk));
                controller.close();
              },
            }),
            terminateOnError: true,
          }))
            reconstructed = message;

          assert.equal(
            reconstructed?.parts.find((part) => part.type === "text")?.text,
            "查询完成：" + owner,
          );
          const tool = reconstructed?.parts.find((part) => part.type === "dynamic-tool");
          assert.equal(tool?.state, "output-available");
          assert.deepEqual(tool?.state === "output-available" ? tool.output : undefined, {
            owner,
            query: owner + "-query",
          });
          const snapshot = (await (
            await call(credential, "/sessions/" + sessions[index])
          ).json()) as ChatSnapshot;
          const core = await app!.sessions.snapshot({ userId: owner }, sessions[index]!);
          const stored = core.turns[0]!.messages.map((row) => row.message);
          assert.deepEqual(
            stored.map((message) => message.role),
            ["user", "assistant", "tool", "assistant"],
          );
          assert.ok(
            stored.some(
              (message) => message.role === "assistant" && message.source?.adapter === "pi",
            ),
          );
          assert.ok(!JSON.stringify(snapshot).includes('"replay"'));

          assert.deepEqual(
            snapshot.messages[1]?.parts,
            JSON.parse(JSON.stringify(reconstructed?.parts)),
          );
          assert.equal(await (await call(credential, "/runs/" + runId + "/stream")).text(), stream);

          return { runId, owner };
        }),
      );

      for (const answer of answers) {
        assert.ok(
          fixtures.calls.some(
            (call) => call.userId === answer.owner && call.runId === answer.runId,
          ),
        );
      }
      assert.ok(
        fixtures.requests.every(
          (request) =>
            request.tools
              .map((tool) => tool.function.name)
              .sort()
              .join() === "mcp_lookup,search_current_session",
        ),
      );
      const toolFollowup = fixtures.requests.find(
        (request) => request.messages.at(-1)?.role === "tool",
      );
      assert.equal(toolFollowup?.messages.at(-2)?.reasoning_content, "需要查询票根。");

      assert.equal(
        (await call(credentials[1]!, "/runs/" + answers[0]!.runId + "/stream")).status,
        404,
      );

      const followup = await call(credentials[0]!, "/chat", input(sessions[0]!, "followup"));
      await followup.text();
      const secondRound = fixtures.requests.find(
        (request) => request.messages.at(-1)?.content === "followup",
      );
      assert.deepEqual(
        secondRound?.messages
          .filter((message) => message.role !== "system")
          .map((message) => message.role),
        ["user", "assistant", "tool", "assistant", "user"],
      );
    } finally {
      await app?.close();
      await fixtures.close();
    }
  },
);
