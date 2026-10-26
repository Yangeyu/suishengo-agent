import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { withLogContext, logContext } from "@logging";

test("concurrent runs and nested tools keep independent log context", async () => {
  const results = await Promise.all(
    ["alice", "bob"].map((runId) =>
      withLogContext({ runId }, async () => {
        await delay(runId === "alice" ? 5 : 1);
        assert.deepEqual(logContext(), { runId });

        await withLogContext({ toolCallId: runId + "-call" }, async () => {
          await delay(1);
          assert.deepEqual(logContext(), { runId, toolCallId: runId + "-call" });
        });

        return logContext();
      }),
    ),
  );

  assert.deepEqual(results, [{ runId: "alice" }, { runId: "bob" }]);
  assert.deepEqual(logContext(), {});
});
