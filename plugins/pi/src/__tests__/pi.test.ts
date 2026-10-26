import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { pi } from "@plugins/pi/src/index";

test("Pi adapter consumes an OpenAI-compatible stream and propagates provider failures", { timeout: 15000 }, async () => {
  let reject = false;
  let received: { model: string; messages: { role: string; content: unknown }[] } | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    if (reject) { response.writeHead(401); response.end(JSON.stringify({ error: { message: "invalid test credential" } })); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "hello " }, null], [{ content: "world" }, null], [{}, "stop"]]) {
      response.write("data: " + JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const previous = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "fixture-key";
  const ctx = new Context();
  try {
    await ctx.plugin(pi, { baseUrl: "http://127.0.0.1:" + address.port + "/v1", modelId: "fixture" });
    let text = "";
    const input = { system: "system instruction", messages: [{ role: "user" as const, text: "question" }],
      signal: new AbortController().signal, onText: async (delta: string) => { text += delta; } };
    await ctx.model.generate(input);
    assert.equal(text, "hello world");
    assert.equal(received?.model, "fixture");
    assert.equal(received?.messages.at(-1)?.content, "question");
    reject = true;
    await assert.rejects(ctx.model.generate(input));
  } finally {
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
