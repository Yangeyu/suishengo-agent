import type { Sessions, ToolDefinition } from "@harness";

export function searchCurrentSession(
  sessions: Pick<Sessions, "getRun" | "search">,
): ToolDefinition {
  return {
    name: "search_current_session",
    displayName: "检索当前会话",
    description:
      "按关键词检索当前会话中本轮之前已完成的用户消息和助手正文，包括已被上下文摘要省略的原文。" +
      "关键词按不区分大小写的连续文本匹配，结果按最近消息优先，返回来源 ID 和最多 1000 字符的片段。" +
      "仅用于回忆本会话，不查询业务事实或其他会话；历史助手回答不代表已核实的业务事实。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
          description: "原文关键词或短语",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "最多返回几条消息，默认 5",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    effect: "read",
    timeoutMs: 5000,
    async authorize(context) {
      context.signal.throwIfAborted();
      const run = await sessions.getRun(context.actor, context.runId);
      return run.sessionId === context.sessionId;
    },
    execute(input, context) {
      return sessions.search(
        context.actor,
        context.runId,
        {
          query: input.query as string,
          limit: input.limit as number | undefined,
        },
        context.signal,
      );
    },
  };
}
