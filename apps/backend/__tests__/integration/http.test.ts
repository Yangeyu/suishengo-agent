import type { AgentExecutor } from "@harness";
import type { ChatSnapshot, MessageMetadata } from "@backend/http/ai-sdk";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT } from "jose";
import { readUIMessageStream, type UIMessageChunk, type UIMessage } from "ai";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { databaseUrl, prepareDatabase } from "@backend-tests/integration/database";

async function setup(t: TestContext) {
  await prepareDatabase();
  const config = resolveConfig(
    {
      runtime: { concurrency: { global: 2, perUser: 1 } },
    },
    {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      AUTH_ISSUER: "integration-test",
      AUTH_AUDIENCE: "suishengo-agent",
      AUTH_SECRET: "integration-only-secret-at-least-thirty-two",
    },
  );
  config.http.port = 0;
  let executions = 0;
  const agent: AgentExecutor = {
    async run(input) {
      executions++;
      const message = input.messages.at(-1)!;
      assert.equal(message.role, "user");
      if (message.role !== "user") throw new Error("Expected user input");
      const text = message.text;
      await input.onEvent({ type: "step-start", step: 1 });
      await input.onEvent({ type: "text-start", id: "1:0" });
      await input.onEvent({ type: "text-delta", id: "1:0", delta: "reply:" });
      if (text.startsWith("hold"))
        await delay(30000, undefined, { signal: input.execution.scope.signal });
      else await delay(30, undefined, { signal: input.execution.scope.signal });
      await input.onEvent({ type: "text-delta", id: "1:0", delta: text });
      await input.onEvent({ type: "text-end", id: "1:0" });
      await input.onEvent({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "reply:" + text }] },
      });
      await input.onEvent({ type: "step-end", step: 1 });
    },
  };
  let app = await createApplication(config, { agent });
  t.after(() => app.close());
  let base = await app.listen();
  const token = async (user: string) =>
    new SignJWT({})
      .setSubject(user)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setIssuedAt()
      .sign(new TextEncoder().encode(config.auth.authSecret));
  const aliceActor = { userId: "alice-" + randomUUID() };
  const bobActor = { userId: "bob-" + randomUUID() };
  const alice = await token(aliceActor.userId);
  const bob = await token(bobActor.userId);
  const call = (credential: string, path: string, body?: unknown) =>
    fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (credential: string) => {
    const response = await call(credential, "/sessions", { title: "integration" });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: string }).id;
  };
  const input = (sessionId: string, text: string) => ({
    sessionId,
    requestId: randomUUID(),
    message: { id: randomUUID(), role: "user", parts: [{ type: "text", text }] },
  });
  const snapshot = async (credential: string, id: string) =>
    (await (await call(credential, "/sessions/" + id)).json()) as ChatSnapshot;

  return {
    get app() {
      return app;
    },
    get base() {
      return base;
    },
    get executions() {
      return executions;
    },
    aliceActor,
    bobActor,
    alice,
    bob,
    call,
    create,
    input,
    snapshot,
    async restart() {
      await app.close();
      app = await createApplication(config, { agent });
      base = await app.listen();
    },
  };
}

const options = { skip: !databaseUrl, timeout: 40000 };

test("HTTP enforces identity and ownership for sessions and runs", options, async (t) => {
  const fixture = await setup(t);
  const { alice, bob, bobActor, call, create, input, snapshot } = fixture;
  const a = await create(alice);
  const b = await create(bob);
  assert.equal((await fetch(fixture.base + "/api/sessions")).status, 401);
  assert.equal((await call(bob, "/sessions/" + a)).status, 404);
  assert.deepEqual(
    ((await (await call(bob, "/sessions")).json()) as { id: string }[]).map((item) => item.id),
    [b],
  );
  assert.equal((await call(bob, "/chat", input(a, "steal"))).status, 404);

  assert.equal(
    (await call(alice, "/chat", { ...input(a, "bad"), userId: bobActor.userId })).status,
    400,
  );
  const response = await call(alice, "/chat", input(a, "private"));
  const runId = response.headers.get("x-run-id")!;
  await response.text();
  for (const suffix of ["", "/stream", "/cancel"]) {
    assert.equal(
      (await call(bob, "/runs/" + runId + suffix, suffix === "/cancel" ? {} : undefined)).status,
      404,
    );
  }
  assert.equal((await snapshot(alice, a)).messages.length, 2);
  assert.equal((await snapshot(bob, b)).messages.length, 0);
});

test("HTTP idempotency and replay survive restart", options, async (t) => {
  const fixture = await setup(t);
  const { alice, call, create, input, snapshot } = fixture;
  const a = await create(alice);
  const request = input(a, "alice-only");
  const response = await call(alice, "/chat", request);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const runId = response.headers.get("x-run-id")!;
  const original = await response.text();
  assert.match(original, /\[DONE\]/);
  const chunks = original
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as UIMessageChunk);
  let reconstructed: UIMessage<MessageMetadata> | undefined;
  for await (const message of readUIMessageStream<UIMessage<MessageMetadata>>({
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    terminateOnError: true,
  }))
    reconstructed = message;
  assert.equal(reconstructed?.parts.find((part) => part.type === "text")?.text, "reply:alice-only");
  assert.equal(reconstructed?.metadata?.runId, runId);
  const retry = await call(alice, "/chat", request);
  assert.equal(retry.headers.get("x-run-id"), runId);
  assert.equal(await retry.text(), original);
  assert.equal(fixture.executions, 1);
  assert.equal(
    (
      await call(alice, "/chat", {
        ...request,
        message: { ...request.message, parts: [{ type: "text", text: "changed" }] },
      })
    ).status,
    409,
  );

  await fixture.restart();
  const replay = await call(alice, "/runs/" + runId + "/stream");
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), original);
  assert.equal(
    (await snapshot(alice, a)).messages[1]?.parts.find((part) => part.type === "text")?.text,
    "reply:alice-only",
  );
});

test(
  "HTTP disconnect preserves execution and explicit cancellation isolates users",
  options,
  async (t) => {
    const fixture = await setup(t);
    const { alice, bob, aliceActor, bobActor, call, create, input } = fixture;
    const a = await create(alice);
    const b = await create(bob);
    const holdingA = await call(alice, "/chat", input(a, "hold-a"));
    const aRun = holdingA.headers.get("x-run-id")!;
    await holdingA.body!.cancel(); // Browser disconnect does not cancel the execution.
    assert.equal((await fixture.app.sessions.getRun(aliceActor, aRun)).status, "running");
    assert.equal((await call(alice, "/chat", input(a, "overlap"))).status, 409);
    const secondA = await create(alice);
    assert.equal((await call(alice, "/chat", input(secondA, "quota"))).status, 429);
    const holdingB = await call(bob, "/chat", input(b, "hold-b"));
    const bRun = holdingB.headers.get("x-run-id")!;
    await holdingB.body!.cancel();
    const cancelled = await call(alice, "/runs/" + aRun + "/cancel", {});
    assert.equal(((await cancelled.json()) as { status: string }).status, "cancelled");
    assert.equal((await fixture.app.sessions.getRun(bobActor, bRun)).status, "running");
    await call(bob, "/runs/" + bRun + "/cancel", {});
  },
);

test(
  "PG rejects invalid events atomically and interrupts unstarted runs after restart",
  options,
  async (t) => {
    const fixture = await setup(t);
    const { alice, aliceActor, create } = fixture;
    const a = await create(alice);
    // Persist an admission without executing it, simulating a crash after commit.
    const pending = await fixture.app.sessions.admit(aliceActor, {
      sessionId: a,
      requestId: randomUUID(),
      userMessageId: randomUUID(),
      text: "unstarted",
    });
    const beforeInvalid = await fixture.app.sessions.events(aliceActor, pending.run.id, 0);
    await assert.rejects(
      fixture.app.sessions.append(pending.run, {
        type: "text-delta",
        id: "missing",
        delta: "invalid",
      }),
    );
    assert.deepEqual(
      await fixture.app.sessions.events(aliceActor, pending.run.id, 0),
      beforeInvalid,
    );
    assert.equal(
      (await fixture.app.sessions.getRun(aliceActor, pending.run.id)).sequence,
      pending.run.sequence,
    );

    await fixture.restart();
    assert.equal(
      (await fixture.app.sessions.getRun(aliceActor, pending.run.id)).status,
      "interrupted",
    );
    assert.equal(fixture.executions, 0);
  },
);
