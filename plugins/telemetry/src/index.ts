import type { Context } from "@deepseek-ai/cordis";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Telemetry } from "@harness";

export interface LangfuseConnection { baseUrl: string; publicKey: string; secretKey: string }
declare module "@deepseek-ai/cordis" { interface Context { telemetry: Telemetry } }
export const telemetry = {
  name: "telemetry",
  apply(ctx: Context, connection?: LangfuseConnection) {
    const provider = connection ? new NodeTracerProvider({
      spanProcessors: [new LangfuseSpanProcessor({
        ...connection, mediaUploadEnabled: false, flushAt: 16, flushInterval: 5,
        shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === "suishengo-agent",
      })],
    }) : undefined;
    const tracer = provider?.getTracer("suishengo-agent");
    const service: Telemetry = {
      start(runId, sessionId) {
        const started = performance.now();
        const span = tracer?.startSpan("agent.run", { attributes: {
          "run.id": runId, "session.id": sessionId, "langfuse.observation.type": "agent",
        } }, ROOT_CONTEXT);
        return {
          end(status) {
            span?.setAttribute("run.status", status);
            span?.setStatus({ code: status === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
            span?.end();
            console.info(JSON.stringify({ event: "run.finished", runId, sessionId, status,
              durationMs: Math.round(performance.now() - started), traceId: span?.spanContext().traceId }));
          },
        };
      },
      async close() {
        try { await provider?.shutdown(); }
        catch { console.error(JSON.stringify({ event: "telemetry.shutdown_failed" })); }
      },
    };
    ctx.provide("telemetry", service);
    ctx.effect(() => () => service.close());
  },
};
