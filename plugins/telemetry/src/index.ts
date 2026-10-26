import { ServiceError, type Telemetry } from "@harness";
import type { JsonValue } from "@harness/messages";
import type { Observation, ObservationData, ObservationSpec } from "@harness/telemetry";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { logger, withLogContext } from "@logging";

export const langfuseConnectionSchema = z.strictObject({
  baseUrl: z.url(),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});
export type LangfuseConnection = z.infer<typeof langfuseConnectionSchema>;

export const telemetryOptionsSchema = z.strictObject({
  connection: langfuseConnectionSchema.optional(),
  environment: z.string().min(1),
  release: z.string().min(1).optional(),
  captureContent: z.boolean(),
});

export interface TelemetryOptions {
  connection?: LangfuseConnection;
  environment?: string;
  release?: string;
  /** Omitted means no input/output export. The application owns redaction and sampling. */
  content?: (value: JsonValue, field: "input" | "output") => JsonValue | undefined;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    telemetry: Telemetry;
  }
}

// Metadata is diagnostic data, not a channel for conversation or credential payloads.
function bounded(value: JsonValue, content: boolean, depth = 0): JsonValue {
  if (depth >= (content ? 16 : 4)) return "[depth limit]";
  const maxString = content ? 16384 : 1024;
  const maxItems = content ? 128 : 32;
  if (typeof value === "string")
    return value.length > maxString ? value.slice(0, maxString) + "[truncated]" : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((item) => bounded(item, content, depth + 1));
    if (value.length > maxItems) items.push("[truncated]");
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, maxItems)
        .map(([key, item]) => [
          key.slice(0, 128),
          /authorization|password|secret|api[_-]?key|access[_-]?token/i.test(key)
            ? "[redacted]"
            : bounded(item, content, depth + 1),
        ]),
    );
  return value;
}

function serialized(value: JsonValue, content = false): string {
  const text = JSON.stringify(bounded(value, content));
  const limit = content ? 65536 : 8192;
  return Buffer.byteLength(text) <= limit
    ? text
    : JSON.stringify({
        truncated: true,
        reason: "size-limit",
        preview: text.slice(0, Math.floor(limit / 4)),
      });
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const provider = options.connection
    ? new NodeTracerProvider({
        spanProcessors: [
          new LangfuseSpanProcessor({
            ...options.connection,
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
  const current = new AsyncLocalStorage<{
    span?: Span;
    correlation: NonNullable<ObservationSpec["correlation"]>;
  }>();

  function record(task: () => void) {
    try {
      task();
    } catch {
      logger.warn({ event: "telemetry.record_failed" });
    }
  }

  const service: Telemetry = {
    start(spec) {
      const parent = current.getStore();
      const correlation = { ...parent?.correlation, ...spec.correlation };
      const started = performance.now();
      let span: Span | undefined;
      let ended = false;
      let metadata: Record<string, JsonValue> = {};
      record(() => {
        span = tracer?.startSpan(
          spec.name,
          {
            attributes: {
              "langfuse.observation.type": spec.type,
              ...(options.environment ? { "langfuse.environment": options.environment } : {}),
              ...(options.release ? { "langfuse.release": options.release } : {}),
              ...(correlation.sessionId ? { "session.id": correlation.sessionId } : {}),
              ...Object.fromEntries(
                Object.entries(correlation).map(([key, value]) => [
                  `langfuse.trace.metadata.${key}`,
                  value,
                ]),
              ),
            },
          },
          parent?.span ? trace.setSpan(ROOT_CONTEXT, parent.span) : ROOT_CONTEXT,
        );
      });

      function update(data: ObservationData) {
        if (ended) return;
        record(() => {
          if (data.metadata) {
            metadata = { ...metadata, ...data.metadata };
            span?.setAttribute("langfuse.observation.metadata", serialized(metadata));
          }
          if (data.model) span?.setAttribute("langfuse.observation.model.name", data.model);
          if (data.prompt) {
            span?.setAttribute("langfuse.observation.prompt.name", data.prompt.name);
            span?.setAttribute("langfuse.observation.prompt.version", data.prompt.version);
          }
          if (data.usage)
            span?.setAttribute("langfuse.observation.usage_details", JSON.stringify(data.usage));
          if (data.completionStartTime !== undefined)
            span?.setAttribute(
              "langfuse.observation.completion_start_time",
              new Date(data.completionStartTime).toISOString(),
            );
          for (const field of ["input", "output"] as const) {
            const value = data[field];
            if (value === undefined || !options.content || !span) continue;
            const content = options.content(value, field);
            if (content !== undefined)
              span.setAttribute(`langfuse.observation.${field}`, serialized(content, true));
          }
        });
      }

      const observation: Observation = {
        within: (task) =>
          current.run({ span, correlation }, () =>
            withLogContext(
              {
                ...correlation,
                traceId: span?.spanContext().traceId,
                spanId: span?.spanContext().spanId,
              },
              task,
            ),
          ),
        update,
        event(name, details) {
          if (ended) return;
          observation.within(() =>
            service.start({ name, type: "event", metadata: details }).end({ status: "completed" }),
          );
        },
        end(outcome) {
          if (ended) return;
          ended = true;
          record(() => {
            span?.setAttribute("execution.status", outcome.status);
            span?.setAttribute(
              "langfuse.observation.metadata",
              serialized({
                ...metadata,
                status: outcome.status,
                ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              }),
            );
            const failed = outcome.status === "failed" || outcome.status === "timeout";
            span?.setAttribute(
              "langfuse.observation.level",
              failed ? "ERROR" : outcome.status === "completed" ? "DEFAULT" : "WARNING",
            );
            if (outcome.errorCode)
              span?.setAttribute("langfuse.observation.status_message", outcome.errorCode);
            span?.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
            span?.end();
          });
          record(() =>
            logger.info({
              event: spec.name,
              ...correlation,
              ...outcome,
              durationMs: Math.round(performance.now() - started),
              traceId: span?.spanContext().traceId,
            }),
          );
        },
      };
      update(spec);
      return observation;
    },
    async observe(spec, task) {
      const observation = service.start(spec);
      try {
        const result = await observation.within(() => task(observation));
        observation.end({ status: "completed" });
        return result;
      } catch (error) {
        observation.end(service.outcome(error, spec.signal));
        throw error;
      }
    },
    outcome(error, signal) {
      const reason = signal?.aborted ? signal.reason : error;
      const cause = reason instanceof Error && reason.cause ? reason.cause : reason;
      if (cause instanceof Error && cause.name === "TimeoutError")
        return { status: "timeout", errorCode: "TIMEOUT" };
      if (cause instanceof ServiceError)
        return {
          status:
            cause.code === "TOOL_FORBIDDEN" || cause.code === "UNAUTHORIZED" ? "denied" : "failed",
          errorCode: cause.code,
        };
      if (signal?.aborted || (cause instanceof Error && cause.name === "AbortError"))
        return { status: "cancelled", errorCode: "CANCELLED" };
      return { status: "failed", errorCode: "EXECUTION_FAILED" };
    },
    async close() {
      try {
        await provider?.shutdown();
      } catch {
        logger.warn({ event: "telemetry.shutdown_failed" });
      }
    },
  };
  return service;
}

export const telemetry = {
  name: "telemetry",
  apply(ctx: Context, options: z.infer<typeof telemetryOptionsSchema>) {
    const service = createTelemetry({
      ...options,
      content: options.captureContent ? (value) => value : undefined,
    });
    ctx.provide("telemetry", service);
    ctx.effect(() => () => service.close());
  },
};
