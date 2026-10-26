import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentExecutor, AgentMessage, ToolDefinition } from "@harness";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { toChatSnapshot } from "@backend/http/ai-sdk";
import { databaseUrl, prepareDatabase } from "@backend-tests/integration/database";

test(
  "tool titles persist with calls, ignore executor titles and survive rename/removal",
  { skip: !databaseUrl, timeout: 15000 },
  async () => {
    await prepareDatabase();
    const config = resolveConfig(
      {},
      {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: "tool-display-test-secret-at-least-thirty-two",
      },
    );
    const tool: ToolDefinition = {
      name: "lookup",
      displayName: "原始标题",
      description: "Test tool",
      effect: "read",
      timeoutMs: 1000,
      inputSchema: { type: "object" },
      authorize: () => true,
      execute: async () => "ok",
    };
    const agent: AgentExecutor = {
      async run({ onEvent }) {
        const message: Extract<AgentMessage, { role: "assistant" }> = {
          role: "assistant",
          content: ["lookup", "unknown"].map((name) => ({
            type: "tool-call",
            id: name,
            name,
            input: {},
            displayName: "伪造标题",
          })),
        };
        await onEvent({ type: "message", message });
        // Runtime enrichment must leave the executor's message untouched.
        assert.ok(
          message.content.every(
            (part) => part.type === "tool-call" && part.displayName === "伪造标题",
          ),
        );
        for (const name of ["lookup", "unknown"])
          await onEvent({
            type: "message",
            message: {
              role: "tool",
              callId: name,
              name,
              output: "fixture",
              isError: name === "unknown",
            },
          });
      },
    };
    let app = await createApplication(config, { agent, tools: [tool] });
    const actor = { userId: "tool-display-" + randomUUID() };
    try {
      const session = await app.sessions.create(actor, "titles");
      const runIds: string[] = [];
      for (const title of ["原始标题", "新标题", undefined]) {
        tool.displayName = title;
        const run = await app.runtime.submit(actor, {
          sessionId: session.id,
          requestId: randomUUID(),
          userMessageId: randomUUID(),
          text: "lookup",
        });
        runIds.push(run.id);
        while ((await app.sessions.getRun(actor, run.id)).status === "running") await delay(10);
        assert.equal((await app.sessions.getRun(actor, run.id)).status, "completed");
        const event = (await app.sessions.events(actor, run.id, 0)).find(
          ({ event }) => event.type === "message" && event.message.role === "assistant",
        )?.event;
        assert.ok(event?.type === "message" && event.message.role === "assistant");
        assert.deepEqual(event.message.content, [
          {
            type: "tool-call",
            id: "lookup",
            name: "lookup",
            input: {},
            ...(title ? { displayName: title } : {}),
          },
          { type: "tool-call", id: "unknown", name: "unknown", input: {} },
        ]);
        const saved = await app.sessions.snapshot(actor, session.id);
        assert.deepEqual(
          saved.turns.at(-1)!.messages.find((row) => row.message.role === "assistant")!.message,
          event.message,
        );
      }
      await app.close();
      app = await createApplication(config, { agent });
      const displayed = toChatSnapshot(await app.sessions.snapshot(actor, session.id));
      for (const [index, title] of ["原始标题", "新标题", undefined].entries()) {
        const parts = displayed.messages.find((message) => message.id === runIds[index])!.parts;
        const known = parts.find(
          (part) => part.type === "dynamic-tool" && part.toolName === "lookup",
        );
        const unknown = parts.find(
          (part) => part.type === "dynamic-tool" && part.toolName === "unknown",
        );
        assert.ok(known?.type === "dynamic-tool" && unknown?.type === "dynamic-tool");
        assert.deepEqual(known.toolMetadata, title ? { displayName: title } : undefined);
        assert.equal(unknown.toolMetadata, undefined);
      }
    } finally {
      await app.close();
    }
  },
);
