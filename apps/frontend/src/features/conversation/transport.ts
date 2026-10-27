import { DefaultChatTransport } from "ai";
import type { ChatMessage } from "@frontend/types/contracts";

export function createTransport(sessionId: string | undefined, onRun: (id: string) => void) {
  return new DefaultChatTransport<ChatMessage>({
    api: "/api/chat",
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const runId = response.headers.get("x-run-id");
      if (response.ok && runId) onRun(runId);
      return response;
    },
    prepareSendMessagesRequest: ({ messages }) => {
      const message = messages.at(-1)!;
      return {
        body: {
          sessionId,
          requestId: message.id,
          message: { id: message.id, role: message.role, parts: message.parts },
        },
      };
    },
    prepareReconnectToStreamRequest: ({ body }) => ({
      api: "/api/runs/" + body?.runId + "/stream",
    }),
  });
}
