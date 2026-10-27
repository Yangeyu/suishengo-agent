import test from "node:test";
import assert from "node:assert/strict";
import { captureContent } from "@plugins/telemetry/src/content";

test("captured structured content is bounded and redacted", () => {
  const result = captureContent(
    Array.from({ length: 128 }, () => ({ text: "内容".repeat(10000), secret: "private-large" })),
  );
  const encoded = JSON.stringify(result);
  assert.ok(Buffer.byteLength(encoded) <= 65536);
  assert.ok(!encoded.includes("private-large"));
  assert.equal((result as { truncated: boolean }).truncated, true);
});
