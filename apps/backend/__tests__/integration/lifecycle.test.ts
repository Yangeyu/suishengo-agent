import test from "node:test";
import { trace } from "@opentelemetry/api";
import assert from "node:assert/strict";
import { createApplication } from "@backend/application";
import { resolveConfig } from "@backend/config";
import { databaseUrl, prepareDatabase } from "@backend-tests/integration/database";

for (const enabled of [false, true])
  test(
    `telemetry ${enabled ? "enabled" : "disabled"}: SDK lifecycle and cleanup after HTTP failure`,
    { skip: !databaseUrl },
    async (t) => {
      await prepareDatabase();
      const config = resolveConfig(
        {},
        {
          NODE_ENV: "test",
          TELEMETRY_ENABLED: String(enabled),
          LANGFUSE_BASE_URL: "http://127.0.0.1:1",
          LANGFUSE_PUBLIC_KEY: "fixture-public",
          LANGFUSE_SECRET_KEY: "fixture-secret",
          DATABASE_URL: databaseUrl,
          AUTH_ISSUER: "integration-test",
          AUTH_AUDIENCE: "suishengo-agent",
          AUTH_SECRET: "integration-only-secret-at-least-thirty-two",
        },
      );
      config.http.port = 0;
      const app = await createApplication(config);
      const probe = trace.getTracer("lifecycle-test").startSpan("probe");
      assert.equal(probe.isRecording(), enabled);
      probe.end();
      const failure = new Error("fixture HTTP cleanup failure");
      app.http.addHook("onClose", async () => {
        throw failure;
      });
      t.after(() => app.close().catch(() => {}));
      await app.listen();
      await assert.rejects(app.close(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(failure));
        return true;
      });
      // Both the database execution lock and the process-global SDK must have been released.
      const restarted = await createApplication(config);
      t.after(() => restarted.close());
      await restarted.listen();
    },
  );
