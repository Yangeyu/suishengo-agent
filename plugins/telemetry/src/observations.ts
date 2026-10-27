import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { startObservation, propagateAttributes } from "@langfuse/tracing";
import type {
  Telemetry,
  Observation,
  ObservationData,
  ObservationResult,
} from "@harness/telemetry";
import { executionFailure } from "@harness/errors";
import { captureContent } from "@plugins/telemetry/src/content";
import { logger } from "@logging";

// Only recording work belongs in this guard, never a business continuation.
function record<T>(write: () => T): T | undefined {
  try {
    return write();
  } catch {
    logger.warn({ event: "telemetry.recording_failed" });
  }
}

function resultAttributes(result: ObservationResult) {
  return {
    metadata: { status: result.status, errorCode: result.errorCode },
    level:
      result.status === "completed"
        ? ("DEFAULT" as const)
        : result.status === "cancelled" || result.status === "denied"
          ? ("WARNING" as const)
          : ("ERROR" as const),
    statusMessage: result.errorCode,
  };
}

export function createTelemetry(capture: boolean): Telemetry {
  function attributes(data: ObservationData) {
    const usage = data.usage;
    return {
      input: capture && data.input !== undefined ? captureContent(data.input) : undefined,
      output: capture && data.output !== undefined ? captureContent(data.output) : undefined,
      metadata: {
        ...data.metadata,
        ...(usage ? { usageAvailable: usage.total > 0 } : {}),
      },
      model: data.model,
      modelParameters: data.modelParameters,
      prompt: data.prompt ? { ...data.prompt, isFallback: false } : undefined,
      // Harness input includes caches; Langfuse usage buckets must be mutually exclusive.
      usageDetails:
        usage && usage.total > 0
          ? {
              input: usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0),
              output: usage.output,
              total: usage.total,
              ...(usage.cacheRead === undefined ? {} : { input_cached_tokens: usage.cacheRead }),
              ...(usage.cacheWrite === undefined
                ? {}
                : { input_cache_write_tokens: usage.cacheWrite }),
            }
          : undefined,
      completionStartTime:
        data.completionStartTime === undefined ? undefined : new Date(data.completionStartTime),
    };
  }

  const telemetry: Telemetry = {
    start(spec) {
      // Create the scope independently of payload projection, so bad content cannot orphan children.
      const span = record(() => {
        switch (spec.type) {
          case "agent":
            return startObservation(spec.name, {}, { asType: "agent" });
          case "generation":
            return startObservation(spec.name, {}, { asType: "generation" });
          case "tool":
            return startObservation(spec.name, {}, { asType: "tool" });
          case "retriever":
            return startObservation(spec.name, {}, { asType: "retriever" });
          default:
            return startObservation(spec.name);
        }
      });
      const captured = record(() => {
        const parent = span ? trace.setSpan(context.active(), span.otelSpan) : context.active();
        return spec.trace
          ? context.with(parent, () => propagateAttributes(spec.trace!, () => context.active()))
          : parent;
      });
      const observation: Observation = {
        within: (execute) => (captured ? context.with(captured, execute) : execute()),
        update(data) {
          record(() => span?.update(attributes(typeof data === "function" ? data() : data)));
        },
        event(name, data = {}, result = { status: "completed" }) {
          record(() =>
            observation.within(() => {
              const fields = attributes(data);
              const state = resultAttributes(result);
              startObservation(
                name,
                {
                  ...fields,
                  ...state,
                  metadata: { ...fields.metadata, ...state.metadata },
                },
                { asType: "event" },
              );
            }),
          );
        },
        end(result = { status: "completed" }) {
          record(() => {
            const state = resultAttributes(result);
            span?.update(state);
            span?.otelSpan.setStatus({
              code: state.level === "ERROR" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            });
          });
          record(() => span?.end());
        },
      };
      observation.update(spec);
      return observation;
    },
    async observe(spec, execute) {
      const observation = telemetry.start(spec);
      try {
        const result = await observation.within(() => execute(observation));
        observation.end();
        return result;
      } catch (error) {
        observation.end(executionFailure(error, spec.signal));
        throw error;
      }
    },
  };
  return telemetry;
}
