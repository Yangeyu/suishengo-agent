import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { pipeline, policy, TimeoutError, delay } from "@flow";

test("timeouts settle before the next retry starts", async () => {
  const order: string[] = [];
  let attempts = 0;
  const task = policy(async (_: undefined, execution) => {
    const attempt = ++attempts;
    order.push("start" + attempt);
    try {
      await delay(100, execution);
    } finally {
      // 即使底层清理较慢，也不能同时启动下一次可能产生副作用的尝试。
      await sleep(5);
      order.push("end" + attempt);
    }
  })
    .timeout(5)
    .retry({ maxAttempts: 2, shouldRetry: (error) => error instanceof TimeoutError })
    .build();

  await assert.rejects(task(undefined), TimeoutError);
  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
});

test("cancellation prevents later pipeline stages", async () => {
  const controller = new AbortController();
  let entered = false;
  const flow = pipeline(
    async () => {
      controller.abort();
      return 1;
    },
    (value) => {
      entered = true;
      return value + 1;
    },
  );
  await assert.rejects(flow(undefined, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(entered, false);
});
