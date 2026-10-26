import Fastify, { LogController } from "fastify";
import { pipeUIMessageStreamToResponse } from "ai";
import { z, ZodError } from "zod";
import { ServiceError, type Actor, type Sessions } from "@harness";
import type { Runtime } from "@runtime";
import { eventStream } from "@backend/http/stream";

declare module "fastify" { interface FastifyRequest { actor: Actor } }
const id = z.string().uuid();
const chatInput = z.object({
  sessionId: id, requestId: id,
  message: z.object({
    id, role: z.literal("user"),
    parts: z.array(z.object({ type: z.literal("text"), text: z.string().min(1).max(4000) }).strict()).min(1).max(1),
  }).strict(),
}).strict();

export function createHttp(deps: { sessions: Sessions; runtime: Runtime; authenticate(header?: string): Promise<Actor> }) {
  const app = Fastify({ bodyLimit: 32768, logger: true, logController: new LogController({ disableRequestLogging: true }) });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "请求格式不正确" } });
    const status = typeof (error as { statusCode?: number }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    request.log.error({ event: "http.failed", requestId: request.id, status });
    return reply.code(status).send({ error: { code: "REQUEST_FAILED", message: "请求失败" } });
  });
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_, reply) => {
    const ready = deps.runtime.available();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "draining" });
  });

  app.register(async api => {
    api.decorateRequest("actor");
    api.addHook("onRequest", async request => { request.actor = await deps.authenticate(request.headers.authorization); });
    api.get("/capabilities", async () => ({ modelConfigured: deps.runtime.modelConfigured, businessTools: false, protocolVersion: 1 }));
    api.get("/sessions", async request => deps.sessions.list(request.actor));
    api.post("/sessions", async (request, reply) => {
      const body = z.object({ title: z.string().trim().min(1).max(100).default("新对话") }).strict().parse(request.body ?? {});
      return reply.code(201).send(await deps.sessions.create(request.actor, body.title));
    });
    api.get("/sessions/:id", async request => deps.sessions.snapshot(request.actor, id.parse((request.params as { id: string }).id)));
    api.get("/runs/:id", async request => deps.sessions.getRun(request.actor, id.parse((request.params as { id: string }).id)));
    api.post("/runs/:id/cancel", async request => deps.runtime.cancel(request.actor, id.parse((request.params as { id: string }).id)));
    api.post("/chat", async (request, reply) => {
      const input = chatInput.parse(request.body);
      const text = input.message.parts[0]!.text.trim();
      if (!text) throw new ServiceError("INVALID_INPUT", 400, "消息不能为空");
      const run = await deps.runtime.submit(request.actor, {
        sessionId: input.sessionId, requestId: input.requestId, text, userMessageId: input.message.id,
      });
      reply.hijack();
      await pipeUIMessageStreamToResponse({
        response: reply.raw, stream: eventStream(deps.sessions, request.actor, run.id),
        headers: { "x-run-id": run.id, "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
        keepAliveMs: 15000,
      });
    });
    // Full-run replay is supported. Partial-cursor replay requires a client that restores the matching message/part state.
    api.get("/runs/:id/stream", async (request, reply) => {
      const runId = id.parse((request.params as { id: string }).id);
      await deps.sessions.getRun(request.actor, runId);
      reply.hijack();
      await pipeUIMessageStreamToResponse({
        response: reply.raw, stream: eventStream(deps.sessions, request.actor, runId),
        headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" }, keepAliveMs: 15000,
      });
    });
  }, { prefix: "/api" });
  return app;
}
