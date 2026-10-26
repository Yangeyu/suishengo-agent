import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

type LogContext = Readonly<{
  requestId?: string;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  traceId?: string;
}>;

// 只承载诊断字段；业务数据和权限身份由各自的执行参数负责。
const context = new AsyncLocalStorage<LogContext>();

export const logger = pino({
  level: "info",
  mixin: () => ({ ...context.getStore() }),
  redact: ["authorization", "apiKey", "secret", "req.headers.authorization"],
});

export function withLogContext<T>(fields: LogContext, task: () => T): T {
  return context.run(Object.freeze({ ...context.getStore(), ...fields }), task);
}

export function logContext(): LogContext {
  return context.getStore() ?? {};
}
