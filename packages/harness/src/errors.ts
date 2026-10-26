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
  ) {
    super(message);
  }
}
