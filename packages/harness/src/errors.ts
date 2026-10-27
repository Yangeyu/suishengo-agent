export type ServiceErrorCode =
  | "AGENT_LIMIT"
  | "CAPACITY_EXCEEDED"
  | "COMPACTION_FAILED"
  | "COMPACTION_LIMIT"
  | "CONTEXT_LIMIT"
  | "CONTEXT_MESSAGES"
  | "CONTEXT_TOOLS"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_INPUT"
  | "MCP_TOOL_FAILED"
  | "MIDDLEWARE_REENTRY"
  | "MIDDLEWARE_RESULT"
  | "MIDDLEWARE_TOOL_INPUT"
  | "MODEL_FAILED"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_UNKNOWN"
  | "MODEL_USAGE"
  | "NOT_FOUND"
  | "NOT_READY"
  | "SESSION_BUSY"
  | "SUMMARY_BOUNDARY"
  | "SUMMARY_CONFLICT"
  | "TOOL_FAILED"
  | "TOOL_FORBIDDEN"
  | "TOOL_INPUT_INVALID"
  | "TOOL_LIMIT"
  | "TOOL_NOT_FOUND"
  | "TOOL_OUTPUT_INVALID"
  | "UNAUTHORIZED";

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ExecutionFailure {
  status: "cancelled" | "timeout" | "denied" | "failed";
  errorCode: string;
}

/** Safe execution diagnostics, independent of HTTP status codes and observability providers. */
export function executionFailure(error: unknown, signal?: AbortSignal): ExecutionFailure {
  const reason = signal?.aborted ? signal.reason : error;
  const code = reason instanceof ServiceError ? reason.code : undefined;
  const cause = reason instanceof Error ? reason.cause : undefined;
  if (
    (reason instanceof Error && reason.name === "TimeoutError") ||
    (cause instanceof Error && cause.name === "TimeoutError")
  )
    return { status: "timeout", errorCode: code ?? "TIMEOUT" };
  if (code)
    return {
      status: code === "TOOL_FORBIDDEN" || code === "UNAUTHORIZED" ? "denied" : "failed",
      errorCode: code,
    };
  if (signal?.aborted || (reason instanceof Error && reason.name === "AbortError"))
    return { status: "cancelled", errorCode: "CANCELLED" };
  return { status: "failed", errorCode: "EXECUTION_FAILED" };
}
