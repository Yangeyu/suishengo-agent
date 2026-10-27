import { logs } from "@opentelemetry/api-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { context, trace, propagation, diag, DiagLogLevel } from "@opentelemetry/api";
import { LangfuseSpanProcessor, type LangfuseSpanProcessorParams } from "@langfuse/otel";
import type { Context } from "@deepseek-ai/cordis";
import type { Telemetry } from "@harness/telemetry";
import { createTelemetry } from "@plugins/telemetry/src/observations";

declare module "@deepseek-ai/cordis" {
  interface Context {
    telemetry: Telemetry;
  }
}
import { logger } from "@logging";
import { z } from "zod";

export const telemetryOptionsSchema = z.strictObject({
  environment: z.string().min(1),
  release: z.string().min(1).optional(),
  captureContent: z.boolean(),
  shutdownTimeoutMs: z.number().int().positive().max(25000).default(10000),
});

type Options = z.infer<typeof telemetryOptionsSchema> & {
  connection: Required<Pick<LangfuseSpanProcessorParams, "baseUrl" | "publicKey" | "secretKey">>;
};

let active = false;

/** The backend owns one process-wide SDK; concurrent applications in one process are unsupported. */
export function startTelemetry(options: Options) {
  if (active) throw new Error("Telemetry is already initialized in this process");
  const sdk = new NodeSDK({
    autoDetectResources: false,
    serviceName: "suishengo-agent",
    logRecordProcessors: [],
    metricReaders: [],
    spanProcessors: [
      new LangfuseSpanProcessor({
        ...options.connection,
        environment: options.environment,
        release: options.release,
        mediaUploadEnabled: false,
        timeout: 5,
      }),
    ],
  });
  // SDK export diagnostics must not include transport errors that can contain payloads or keys.
  diag.setLogger(
    {
      error: () => logger.error({ event: "telemetry.sdk_error" }),
      warn: () => logger.warn({ event: "telemetry.sdk_warning" }),
      info() {},
      debug() {},
      verbose() {},
    },
    DiagLogLevel.WARN,
  );
  sdk.start();
  active = true;
  const telemetry = createTelemetry(options.captureContent);
  let closing: Promise<void> | undefined;
  return { telemetry, shutdown: () => (closing ??= shutdown()) };

  async function shutdown() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sdk.shutdown(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Telemetry shutdown timed out")),
            options.shutdownTimeoutMs,
          );
        }),
      ]);
    } catch {
      logger.warn({ event: "telemetry.shutdown_failed" });
    } finally {
      clearTimeout(timer);
      trace.disable();
      logs.disable();
      context.disable();
      propagation.disable();
      diag.disable();
      active = false;
    }
  }
}

export const telemetry = {
  name: "telemetry",
  apply(ctx: Context, options: Options) {
    const service = startTelemetry(options);
    ctx.provide("telemetry", service.telemetry);
    ctx.effect(() => service.shutdown);
  },
};
