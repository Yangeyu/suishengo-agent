import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { telemetry } from "@plugins/telemetry/src/index";
import { logger } from "@logging";

type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: { key: string; value: { stringValue?: string } }[];
};

test(
  "Langfuse exporter preserves concurrent run parentage and flushes operation spans",
  { timeout: 10000 },
  async () => {
    const spans: Span[] = [];
    const server = createServer(async (request, response) => {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const bytes = Buffer.concat(buffers);
      const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes;
      const payload = JSON.parse(body.toString()) as {
        resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
      };
      spans.push(
        ...payload.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      );
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const ctx = new Context();
    const level = logger.level;
    logger.level = "silent";

    try {
      await ctx.plugin(telemetry, {
        baseUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port,
        publicKey: "fixture-public",
        secretKey: "fixture-secret",
      });
      await Promise.all(
        ["alice", "bob"].map(async (runId) => {
          const run = ctx.telemetry.start(runId, runId + "-session");
          await run.within(async () => {
            await ctx.telemetry.observe("model.generate", { "model.id": "fixture" }, () =>
              delay(1),
            );
            await ctx.telemetry.observe("tool.execute", { "tool.name": "fixture" }, () => delay(1));
          });
          run.end("completed");
        }),
      );
      await ctx.fiber.dispose();

      const roots = spans.filter((span) => span.name === "agent.run");
      assert.equal(roots.length, 2);
      assert.notEqual(roots[0]!.traceId, roots[1]!.traceId);
      for (const root of roots) {
        const children = spans.filter((span) => span.parentSpanId === root.spanId);
        assert.deepEqual(children.map((span) => span.name).sort(), [
          "model.generate",
          "tool.execute",
        ]);
        assert.ok(children.every((span) => span.traceId === root.traceId));
      }
      assert.ok(
        spans.every(
          (span) =>
            !span.attributes.some((attribute) =>
              /observation\.(input|output)$/.test(attribute.key),
            ),
        ),
      );
    } finally {
      await ctx.fiber.dispose();
      logger.level = level;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
