import { useEffect, useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import type { ChatMessage, ChatSnapshot } from "@frontend/types/contracts";
import { createTransport } from "@frontend/features/conversation/transport";
import { loadConversation, cancelRun } from "@frontend/features/conversation/api";

type ConversationState = {
  sessionId?: string;
  chat: Chat<ChatMessage>;
  controller: AbortController;
  runId?: string;
  working: boolean;
  notice: string;
};

export function useConversation() {
  const [state, setState] = useState<ConversationState>(() => createState());
  const { messages, status, error } = useChat({ chat: state.chat });
  const busy = status === "submitted" || status === "streaming";

  function update(target: ConversationState, patch: Partial<ConversationState>) {
    if (target.controller.signal.aborted) return;
    setState((current) => (current.chat === target.chat ? { ...current, ...patch } : current));
  }

  function createState(snapshot?: ChatSnapshot): ConversationState {
    const sessionId = snapshot?.session.id;
    const target: ConversationState = {
      sessionId,
      controller: new AbortController(),
      working: false,
      notice: "",
      runId: snapshot?.activeRun?.id,
      chat: new Chat<ChatMessage>({
        id: sessionId ?? "new",
        messages: snapshot?.messages ?? [],
        generateId: () => crypto.randomUUID(),
        transport: createTransport(sessionId, (runId) => update(target, { runId })),
        onFinish: ({ isDisconnect, isError, isAbort }) => {
          if (!isDisconnect && !isError && !isAbort) update(target, { runId: undefined });
        },
      }),
    };
    return target;
  }

  useEffect(() => {
    const { controller, chat } = state;
    return () => {
      controller.abort();
      void chat.stop();
    };
  }, [state.chat]);

  function open(snapshot?: ChatSnapshot) {
    state.controller.abort();
    void state.chat.stop();
    const next = createState(snapshot);
    setState(next);
    return next;
  }

  async function send(text: string, target = state) {
    if (!target.sessionId || target.controller.signal.aborted) return;
    target.chat.clearError();
    update(target, { notice: "" });
    await target.chat.sendMessage({ text });
  }

  async function synchronize() {
    if (!state.sessionId || busy || state.working) return;
    update(state, { working: true, notice: "" });
    state.chat.clearError();
    try {
      const snapshot = await loadConversation(state.sessionId, state.controller.signal);
      state.controller.signal.throwIfAborted();
      const runId = snapshot.activeRun?.id ?? state.runId;
      update(state, { runId: snapshot.activeRun?.id });
      if (!runId) {
        state.chat.messages = snapshot.messages;
        return;
      }
      // 服务从头重放整轮；移除该轮的部分回答，防止重复追加。
      state.chat.messages = snapshot.messages.filter(
        (message) => !(message.role === "assistant" && message.metadata?.runId === runId),
      );
      const replay = state.chat.resumeStream({ body: { runId } });
      update(state, { working: false });
      await replay;
    } catch (error) {
      update(state, { notice: (error as Error).message });
    } finally {
      update(state, { working: false });
    }
  }

  async function cancel() {
    if (!state.sessionId || state.working) return;
    update(state, { working: true, notice: "" });
    try {
      const signal = state.controller.signal;
      const snapshot = await loadConversation(state.sessionId, signal);
      if (snapshot.activeRun) await cancelRun(snapshot.activeRun.id, signal);
      signal.throwIfAborted();
      await state.chat.stop();
      const stopped = await loadConversation(state.sessionId, signal);
      signal.throwIfAborted();
      state.chat.messages = stopped.messages;
      state.chat.clearError();
      update(state, { runId: undefined, notice: "已停止生成，你可以继续对话。" });
    } catch (error) {
      update(state, { notice: (error as Error).message });
    } finally {
      update(state, { working: false });
    }
  }

  async function retry() {
    if (busy || state.working || state.runId) return;
    state.chat.clearError();
    update(state, { notice: "" });
    await state.chat.regenerate();
  }

  return {
    messages,
    status,
    error,
    busy,
    runId: state.runId,
    working: state.working,
    notice: state.notice,
    open,
    send,
    synchronize,
    cancel,
    retry,
  };
}
