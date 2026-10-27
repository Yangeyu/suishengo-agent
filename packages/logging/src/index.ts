import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { trace, isSpanContextValid } from "@opentelemetry/api";

type LogContext = Readonly<{
  requestId?: string;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  stepId?: string;
  stepIndex?: number;
}>;

// 只承载诊断字段；业务数据和权限身份由各自的执行参数负责。
const context = new AsyncLocalStorage<LogContext>();

export const logger = pino({
  level: "info",
  mixin: () => {
    const span = trace.getActiveSpan()?.spanContext();
    return {
      ...context.getStore(),
      ...(span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {}),
    };
  },
  redact: ["authorization", "apiKey", "secret", "req.headers.authorization"],
});

export function withLogContext<T>(fields: LogContext, task: () => T): T {
  return context.run(Object.freeze({ ...context.getStore(), ...fields }), task);
}

export function logContext(): LogContext {
  return context.getStore() ?? {};
}
