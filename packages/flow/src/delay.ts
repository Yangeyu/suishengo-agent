import type { ExecutionContext } from "@flow/composition";

// Node clamps larger timers to 1ms; rejecting avoids silently changing policy.
export function validateDuration(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) {
    throw new RangeError("Duration must be between 0 and 2147483647 milliseconds");
  }
}

export async function delay(ms: number, { signal }: ExecutionContext = {}): Promise<void> {
  validateDuration(ms);
  signal?.throwIfAborted();

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });

  signal?.throwIfAborted();
}
