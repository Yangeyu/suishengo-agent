import { setTimeout as delay } from "node:timers/promises";
import type { Actor, Sessions } from "@harness";
import type { ChatChunk } from "@protocol";

/** Subscription cancellation never owns the run. PG events are the only stream source. */
export function eventStream(sessions: Sessions, actor: Actor, runId: string, after = 0) {
  const subscription = new AbortController();
  let buffer: Awaited<ReturnType<Sessions["events"]>> = [];
  let cursor = after;
  return new ReadableStream<ChatChunk>({
    async pull(controller) {
      try {
        while (!subscription.signal.aborted) {
          if (!buffer.length) buffer = await sessions.events(actor, runId, cursor);
          const event = buffer.shift();
          if (event) {
            cursor = event.sequence;
            controller.enqueue(event.chunk);
            return;
          }
          const run = await sessions.getRun(actor, runId);
          if (run.status !== "running" && cursor >= run.sequence) {
            controller.close();
            return;
          }
          await delay(100, undefined, { signal: subscription.signal });
        }
      } catch {
        if (!subscription.signal.aborted) controller.error(new Error("输出订阅失败，请重新加载会话"));
      }
    },
    cancel() { subscription.abort(); },
  });
}
