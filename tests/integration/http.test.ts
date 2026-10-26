import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT } from "jose";
import pg from "pg";
import { readUIMessageStream } from "ai";
import { createApplication } from "@backend/application";
import { loadConfig } from "@backend/config";
import { migrateDatabase } from "@plugins/sessions-pg/src/migrate";
import type { Model } from "@harness";
import type { ChatChunk, ChatMessage, SessionSnapshot } from "@protocol";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("real PG: two users, idempotency, concurrency, cancellation, replay and restart", { skip: !databaseUrl, timeout: 40000 }, async () => {
  if (!new URL(databaseUrl!).pathname.endsWith("_test")) throw new Error("Use a dedicated database ending in _test");
  await migrateDatabase(databaseUrl!);
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query("truncate chat_sessions cascade");
  await admin.end();
  const config = { ...loadConfig({
    NODE_ENV: "test", DATABASE_URL: databaseUrl, AUTH_ISSUER: "integration-test", AUTH_AUDIENCE: "suishengo-agent",
    AUTH_SECRET: "integration-only-secret-at-least-thirty-two", MAX_USER_RUNS: "1", MAX_CONCURRENT_RUNS: "2",
  }), port: 0 };
  let executions = 0;
  const model: Model = { async generate(input) {
    executions++;
    const text = input.messages.at(-1)!.text;
    await input.onText("reply:");
    if (text.startsWith("hold")) await delay(30000, undefined, { signal: input.signal });
    else await delay(30, undefined, { signal: input.signal });
    await input.onText(text);
  } };
  let app = await createApplication(config, { model });
  try {
    let base = await app.listen();
    const token = async (user: string) => new SignJWT({}).setSubject(user).setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.issuer).setAudience(config.audience).setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.authSecret));
    const alice = await token("alice");
    const bob = await token("bob");
    const call = (credential: string, path: string, body?: unknown) => fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + credential, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const create = async (credential: string) => {
      const response = await call(credential, "/sessions", { title: "integration" });
      assert.equal(response.status, 201);
      return (await response.json() as { id: string }).id;
    };
    const input = (sessionId: string, text: string) => ({
      sessionId, requestId: randomUUID(), message: { id: randomUUID(), role: "user", parts: [{ type: "text", text }] },
    });
    const snapshot = async (credential: string, id: string) => (await (await call(credential, "/sessions/" + id)).json()) as SessionSnapshot;
    const a = await create(alice);
    const b = await create(bob);
    assert.equal((await fetch(base + "/api/sessions")).status, 401);
    assert.equal((await call(bob, "/sessions/" + a)).status, 404);
    assert.deepEqual((await (await call(bob, "/sessions")).json() as { id: string }[]).map(item => item.id), [b]);
    assert.equal((await call(bob, "/chat", input(a, "steal"))).status, 404);

    const request = input(a, "alice-only");
    const response = await call(alice, "/chat", request);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const runId = response.headers.get("x-run-id")!;
    const original = await response.text();
    assert.match(original, /\[DONE\]/);
    const chunks = original.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map(line => JSON.parse(line.slice(6)) as ChatChunk);
    let reconstructed: ChatMessage | undefined;
    for await (const message of readUIMessageStream<ChatMessage>({ stream: new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    }), terminateOnError: true })) reconstructed = message;
    assert.equal(reconstructed?.parts.find(part => part.type === "text")?.text, "reply:alice-only");
    assert.equal(reconstructed?.metadata?.runId, runId);
    const retry = await call(alice, "/chat", request);
    assert.equal(retry.headers.get("x-run-id"), runId);
    assert.equal(await retry.text(), original);
    assert.equal(executions, 1);
    assert.equal((await call(alice, "/chat", { ...request, message: { ...request.message, parts: [{ type: "text", text: "changed" }] } })).status, 409);
    for (const suffix of ["", "/stream", "/cancel"]) {
      assert.equal((await call(bob, "/runs/" + runId + suffix, suffix === "/cancel" ? {} : undefined)).status, 404);
    }
    assert.equal((await snapshot(alice, a)).messages.length, 2);
    assert.equal((await snapshot(bob, b)).messages.length, 0);
    assert.equal((await call(alice, "/chat", { ...input(a, "bad"), userId: "bob" })).status, 400);

    const holdingA = await call(alice, "/chat", input(a, "hold-a"));
    const aRun = holdingA.headers.get("x-run-id")!;
    await holdingA.body!.cancel(); // Browser disconnect does not cancel the execution.
    assert.equal((await app.sessions.getRun({ userId: "alice" }, aRun)).status, "running");
    assert.equal((await call(alice, "/chat", input(a, "overlap"))).status, 409);
    const secondA = await create(alice);
    assert.equal((await call(alice, "/chat", input(secondA, "quota"))).status, 429);
    const holdingB = await call(bob, "/chat", input(b, "hold-b"));
    const bRun = holdingB.headers.get("x-run-id")!;
    await holdingB.body!.cancel();
    const cancelled = await call(alice, "/runs/" + aRun + "/cancel", {});
    assert.equal((await cancelled.json() as { status: string }).status, "cancelled");
    assert.equal((await app.sessions.getRun({ userId: "bob" }, bRun)).status, "running");
    await call(bob, "/runs/" + bRun + "/cancel", {});

    // Persist an admission without executing it, simulating a crash after commit.
    const pending = await app.sessions.admit({ userId: "alice" }, {
      sessionId: secondA, requestId: randomUUID(), userMessageId: randomUUID(), text: "unstarted",
    });
    await app.close();
    app = await createApplication(config, { model });
    base = await app.listen();
    assert.equal((await app.sessions.getRun({ userId: "alice" }, pending.run.id)).status, "interrupted");
    assert.equal(executions, 3);
    const replay = await call(alice, "/runs/" + runId + "/stream");
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), original);
    assert.equal((await snapshot(alice, a)).messages[1]?.parts.find(part => part.type === "text")?.text, "reply:alice-only");
  } finally { await app.close(); }
});
