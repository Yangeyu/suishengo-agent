import type { ExecutionContext, Flow, Task } from "@flow/composition";
import { delay, validateDuration } from "@flow/delay";

export interface RetryOptions {
  /** Includes the initial attempt. Retrying side effects requires caller approval. */
  readonly maxAttempts: number;
  /** Called with the failure and the 1-based attempt that just settled. */
  readonly shouldRetry: (error: unknown, attempt: number) => boolean;
  readonly delayMs?: number;
}

export interface PolicyBuilder<Input, Output> {
  retry(options: RetryOptions): PolicyBuilder<Input, Output>;
  timeout(ms: number): PolicyBuilder<Input, Output>;
  build(): Flow<Input, Output>;
}

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Task exceeded its ${timeoutMs}ms cooperative timeout`);
  }
}

interface PolicyOptions {
  readonly retry?: RetryOptions;
  readonly timeoutMs?: number;
}

/** Immutable configuration; timeout always applies per attempt, regardless of chain order. */
export function policy<Input, Output>(task: Task<Input, Output>): PolicyBuilder<Input, Output> {
  return configurePolicy(task, {});
}

function configurePolicy<Input, Output>(
  task: Task<Input, Output>,
  options: PolicyOptions,
): PolicyBuilder<Input, Output> {
  return {
    retry(retry) {
      if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
        throw new RangeError("maxAttempts must be a positive safe integer");
      }
      if (typeof retry.shouldRetry !== "function") {
        throw new TypeError("shouldRetry must explicitly decide which failures are retryable");
      }
      validateDuration(retry.delayMs ?? 0);

      return configurePolicy(task, { ...options, retry: { ...retry } });
    },

    timeout(timeoutMs) {
      validateDuration(timeoutMs);
      return configurePolicy(task, { ...options, timeoutMs });
    },

    build() {
      return (input, context = {}) => executePolicy(task, input, context, options);
    },
  };
}

async function executePolicy<Input, Output>(
  task: Task<Input, Output>,
  input: Input,
  context: ExecutionContext,
  options: PolicyOptions,
): Promise<Output> {
  const retry = options.retry;

  for (let attempt = 1; ; attempt += 1) {
    context.signal?.throwIfAborted();

    try {
      const result = await executeAttempt(task, input, context, options.timeoutMs);
      context.signal?.throwIfAborted();
      return result;
    } catch (error) {
      context.signal?.throwIfAborted();
      if (!canRetry(error, attempt, retry)) throw error;
    }

    // Only settled attempts reach this point; cancellation also interrupts backoff.
    await delay(retry?.delayMs ?? 0, context);
  }
}

function canRetry(error: unknown, attempt: number, retry?: RetryOptions): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (!retry || attempt >= retry.maxAttempts) return false;

  return retry.shouldRetry(error, attempt);
}

async function executeAttempt<Input, Output>(
  task: Task<Input, Output>,
  input: Input,
  context: ExecutionContext,
  timeoutMs?: number,
): Promise<Output> {
  if (timeoutMs === undefined) return task(input, context);

  const controller = new AbortController();
  const onAbort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);

  try {
    // Do not race the task: even a timed-out attempt must settle before a retry.
    const result = await task(input, { signal: controller.signal });
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onAbort);
  }
}
