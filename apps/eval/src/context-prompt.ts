import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LangfuseClient } from "@langfuse/client";
import { SignJWT } from "jose";
import { loadConfig, type Config } from "@backend/config";
import { createApplication } from "@backend/application";
import { migrateDatabase } from "@plugins/sessions-pg/src/migrate";
import { compactionPrompt } from "@plugins/context/src/prompts";
import { createPromptTemplate, promptHash } from "@harness/prompts";
import type { Actor } from "@harness";

type Application = Awaited<ReturnType<typeof createApplication>>;

async function seedHistory(app: Application, actor: Actor, sessionId: string) {
  for (let index = 0; index < 8; index++) {
    const { run } = await app.sessions.admit(actor, {
      sessionId,
      requestId: randomUUID(),
      userMessageId: randomUUID(),
      text:
        `合成案例第 ${index} 轮：票根 T123，只能周末出行，两人预算 500 元。` +
        "请保留出行约束；尚未核验票根，也没有领取权益。".repeat(10),
    });
    await app.sessions.append(run, {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已记录你的出行约束，尚未查询业务系统。" }],
      },
    });
    await app.sessions.finish(run, "completed");
  }
}

async function runExample(config: Config) {
  const app = await createApplication(config);
  try {
    const actor = { userId: "context-prompt-example-" + randomUUID() };
    const session = await app.sessions.create(actor, "context.compaction 固定版本案例");
    await seedHistory(app, actor, session.id);

    const base = await app.listen();
    const token = await new SignJWT({})
      .setSubject(actor.userId)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.auth.issuer)
      .setAudience(config.auth.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(config.auth.authSecret));
    const response = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        requestId: randomUUID(),
        message: {
          id: randomUUID(),
          role: "user",
          parts: [
            { type: "text", text: "请回忆我的票根编号、出行时间和预算，并说明哪些事情尚未确认。" },
          ],
        },
      }),
      signal: AbortSignal.timeout(config.runtime.timeoutMs + 10000),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.ok(stream.includes("[DONE]"));
    const runId = response.headers.get("x-run-id");
    assert.ok(runId);
    assert.equal((await app.sessions.getRun(actor, runId)).status, "completed");
    const summary = await app.sessions.loadSummary(actor, session.id);
    assert.ok(summary, "The real model must produce a persisted summary");
    const history = await app.sessions.snapshot(actor, session.id);
    const reply = history.turns
      .find((turn) => turn.run.id === runId)!
      .messages.flatMap(({ message }) => (message.role === "assistant" ? message.content : []))
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return { sessionId: session.id, runId, summary, reply };
  } finally {
    // Flush real observations before querying the platform.
    await app.close();
  }
}

async function readObservations(client: LangfuseClient, sessionId: string, since: string) {
  const deadline = AbortSignal.timeout(60000);
  while (true) {
    deadline.throwIfAborted();
    const result = await client.api.observations.getMany({
      sessionId,
      fromStartTime: since,
      toStartTime: new Date().toISOString(),
      fields: "core,basic,metadata,prompt,io,model,usage",
      expandMetadata: "promptUsage,prompts",
      limit: 100,
    });
    const names = new Set(result.data.map((item) => item.name));
    if (
      ["agent.run", "context.compact", "context.save"].every((name) => names.has(name)) &&
      result.data.filter((item) => item.type === "GENERATION").length >= 2
    )
      return result.data;
    await delay(1000, undefined, { signal: deadline });
  }
}

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))
    throw new Error("TEST_DATABASE_URL must select a dedicated _test database");
  const config = loadConfig({
    ...process.env,
    CONFIG_FILE:
      process.env.CONFIG_FILE ?? fileURLToPath(new URL("../context-prompt.yaml", import.meta.url)),
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "4400",
    AUTH_SECRET: randomUUID() + randomUUID(),
    AUTH_JWKS_URL: undefined,
    TELEMETRY_ENABLED: "true",
    LANGFUSE_CAPTURE_CONTENT: "true",
    LOG_LEVEL: "silent",
  });
  config.http.port = 0;
  assert.ok(config.langfuse && config.model && config.context.compaction);
  const binding = config.prompts.bindings[compactionPrompt.key];
  assert.ok(binding && "version" in binding, "The example requires a fixed prompt version");
  const client = new LangfuseClient({ ...config.langfuse, timeout: 10 });
  try {
    const project = (await client.api.projects.get()).data[0];
    assert.ok(project);
    const prompt = await client.prompt.get(binding.name, {
      type: "text",
      version: binding.version,
      cacheTtlSeconds: 0,
    });
    createPromptTemplate(compactionPrompt, prompt.prompt, {
      name: prompt.name,
      version: prompt.version,
    });
    await migrateDatabase(databaseUrl);

    const since = new Date().toISOString();
    const result = await runExample(config);
    const observations = await readObservations(client, result.sessionId, since);
    const summaries = observations.filter(
      (item) => item.type === "GENERATION" && item.metadata?.purpose === "compaction",
    );
    assert.ok(summaries.length > 0, "Missing summary generation in Langfuse");
    for (const generation of summaries) {
      assert.equal(generation.promptName, binding.name);
      assert.equal(generation.promptVersion, binding.version);
      assert.equal(generation.metadata?.systemHash, promptHash(prompt.prompt));
      const input =
        typeof generation.input === "string" ? JSON.parse(generation.input) : generation.input;
      assert.equal(input.messages[0].content, prompt.prompt);
      assert.ok(
        observations.some(
          (item) => item.id === generation.parentObservationId && item.name === "context.compact",
        ),
      );
    }
    const traceId = summaries[0]!.traceId;
    const base = config.langfuse.baseUrl.replace(/\/$/, "");
    const report = {
      verifiedAt: new Date().toISOString(),
      project: { id: project.id, name: project.name },
      prompt: { name: binding.name, version: binding.version, hash: promptHash(prompt.prompt) },
      promptUrl: `${base}/project/${project.id}/prompts/${encodeURIComponent(binding.name)}`,
      traceUrl: `${base}/project/${project.id}/traces/${traceId}`,
      ...result,
      summaryGenerations: summaries.map(
        ({ id, promptName, promptVersion, model, usageDetails }) => ({
          id,
          promptName,
          promptVersion,
          model,
          usageDetails,
        }),
      ),
      verified: [
        "fixed_prompt_readback",
        "authenticated_http_run",
        "persisted_summary",
        "generation_prompt_link",
        "sent_system_text",
        "compaction_parent",
      ],
    };
    const directory = new URL("../../../.data/context-prompt/", import.meta.url);
    await mkdir(directory, { recursive: true });
    const file = new URL(`${result.runId}.json`, directory);
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ report: fileURLToPath(file), ...report }, null, 2));
  } finally {
    await client.shutdown();
  }
}

await main();
