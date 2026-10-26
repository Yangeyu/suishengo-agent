import type { Actor, Sessions } from "@harness";
import type { UIMessageChunk } from "ai";
import { setTimeout as delay } from "node:timers/promises";
import { createUIStreamMapper } from "@backend/http/ai-sdk";

/** Subscription cancellation never owns the run. PG events are the only stream source. */
export function eventStream(sessions: Sessions, actor: Actor, runId: string) {
  const subscription = new AbortController();
  let buffer: Awaited<ReturnType<Sessions["events"]>> = [];
  let cursor = 0;
  const project = createUIStreamMapper(runId);
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        while (!subscription.signal.aborted) {
          if (!buffer.length) buffer = await sessions.events(actor, runId, cursor);
          const event = buffer.shift();
          if (event) {
            cursor = event.sequence;
            const chunks = project(event.event);
            for (const chunk of chunks) controller.enqueue(chunk);
            if (chunks.length) return;
            continue;
          }
          const run = await sessions.getRun(actor, runId);
          if (run.status !== "running" && cursor >= run.sequence) {
            controller.close();
            return;
          }
          await delay(100, undefined, { signal: subscription.signal });
        }
      } catch {
        if (!subscription.signal.aborted)
          controller.error(new Error("输出订阅失败，请重新加载会话"));
      }
    },

    cancel() {
      subscription.abort();
    },
  });
}
