import type { Telemetry } from "@harness";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@deepseek-ai/cordis";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { logger, withLogContext } from "@logging";

export interface LangfuseConnection {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    telemetry: Telemetry;
  }
}

export const telemetry = {
  name: "telemetry",

  apply(ctx: Context, connection?: LangfuseConnection) {
    const provider = connection
      ? new NodeTracerProvider({
          spanProcessors: [
            new LangfuseSpanProcessor({
              ...connection,
              mediaUploadEnabled: false,
              flushAt: 16,
              flushInterval: 5,
              shouldExportSpan: ({ otelSpan }) =>
                otelSpan.instrumentationScope.name === "suishengo-agent",
            }),
          ],
        })
      : undefined;
    const tracer = provider?.getTracer("suishengo-agent");

    // 父 span 随本次异步执行传递，避免并发用户的追踪互相串联。
    const current = new AsyncLocalStorage<Span | undefined>();

    function begin(name: string, attributes: Record<string, string | number>) {
      const parent = current.getStore();

      // 观测是旁路能力，创建 span 失败不能阻止业务执行。
      try {
        return tracer?.startSpan(
          name,
          { attributes },
          parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
        );
      } catch {
        logger.warn({ event: "telemetry.start_failed" });
        return undefined;
      }
    }

    function finish(span: Span | undefined, status: string) {
      try {
        span?.setAttribute("execution.status", status);
        span?.setStatus({
          code: status === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });
        span?.end();
      } catch {
        logger.warn({ event: "telemetry.record_failed" });
      }
    }

    const service: Telemetry = {
      start(runId, sessionId) {
        const started = performance.now();
        const span = begin("agent.run", {
          "run.id": runId,
          "session.id": sessionId,
          "langfuse.observation.type": "agent",
        });

        return {
          within: (task) =>
            current.run(span, () =>
              withLogContext({ runId, sessionId, traceId: span?.spanContext().traceId }, task),
            ),

          end(status) {
            finish(span, status);
            logger.info({
              event: "run.finished",
              runId,
              sessionId,
              status,
              durationMs: Math.round(performance.now() - started),
              traceId: span?.spanContext().traceId,
            });
          },
        };
      },

      async observe(name, attributes, task) {
        const started = performance.now();
        const span = begin(name, {
          ...attributes,
          "langfuse.observation.type": name === "model.generate" ? "generation" : "tool",
        });
        let status = "completed";

        try {
          return await current.run(span, task);
        } catch (error) {
          status = "failed";
          throw error;
        } finally {
          finish(span, status);
          logger.info({
            event: name,
            ...attributes,
            status,
            durationMs: Math.round(performance.now() - started),
          });
        }
      },

      async close() {
        try {
          await provider?.shutdown();
        } catch {
          logger.warn({ event: "telemetry.shutdown_failed" });
        }
      },
    };

    ctx.provide("telemetry", service);
    ctx.effect(() => () => service.close());
  },
};
