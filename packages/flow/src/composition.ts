export interface ExecutionContext {
  readonly signal?: AbortSignal;
}

export type Task<Input, Output> = (
  input: Input,
  context: ExecutionContext,
) => Output | PromiseLike<Output>;

export type Flow<Input, Output> = (input: Input, context?: ExecutionContext) => Promise<Output>;

export function pipeline<A, B>(first: Task<A, B>): Flow<A, B>;
export function pipeline<A, B, C>(first: Task<A, B>, second: Task<B, C>): Flow<A, C>;
export function pipeline<A, B, C, D>(
  first: Task<A, B>,
  second: Task<B, C>,
  third: Task<C, D>,
): Flow<A, D>;
export function pipeline<A, B, C, D, E>(
  first: Task<A, B>,
  second: Task<B, C>,
  third: Task<C, D>,
  fourth: Task<D, E>,
): Flow<A, E>;
export function pipeline<A, B, C, D, E, F>(
  first: Task<A, B>,
  second: Task<B, C>,
  third: Task<C, D>,
  fourth: Task<D, E>,
  fifth: Task<E, F>,
): Flow<A, F>;
export function pipeline<A, B, C, D, E, F, G>(
  first: Task<A, B>,
  second: Task<B, C>,
  third: Task<C, D>,
  fourth: Task<D, E>,
  fifth: Task<E, F>,
  sixth: Task<F, G>,
): Flow<A, G>;
export function pipeline(...stages: readonly Task<never, unknown>[]): Flow<never, unknown> {
  return async (input, context = {}) => {
    let value: unknown = input;

    for (const stage of stages) {
      context.signal?.throwIfAborted();
      // The overloads establish each adjacent input/output relationship.
      value = await (stage as Task<unknown, unknown>)(value, context);
    }

    context.signal?.throwIfAborted();
    return value;
  };
}

export function branch<Input, Then, Else>(
  predicate: Task<Input, boolean>,
  paths: { then: Task<Input, Then>; else: Task<Input, Else> },
): Flow<Input, Then | Else> {
  return async (input, context = {}) => {
    context.signal?.throwIfAborted();
    const selected = (await predicate(input, context)) ? paths.then : paths.else;

    context.signal?.throwIfAborted();
    const result = await selected(input, context);

    context.signal?.throwIfAborted();
    return result;
  };
}

type ParallelResults<First, Rest extends readonly Task<never, unknown>[]> = [
  Awaited<First>,
  ...{ [Index in keyof Rest]: Awaited<ReturnType<Rest[Index]>> },
];

/**
 * Results retain declaration order. A failure rejects without cancelling siblings
 * or rolling back effects. Pass a signal explicitly for cooperative cancellation.
 */
export function parallel<Input, First, const Rest extends readonly Task<Input, unknown>[]>(
  first: Task<Input, First>,
  ...rest: Rest
): Flow<Input, ParallelResults<First, Rest>> {
  return async (input, context = {}) => {
    context.signal?.throwIfAborted();
    const results = await Promise.all(
      [first, ...rest].map(async (task) => {
        context.signal?.throwIfAborted();
        return task(input, context);
      }),
    );

    context.signal?.throwIfAborted();
    // Promise.all preserves the heterogeneous task tuple's order.
    return results as ParallelResults<First, Rest>;
  };
}
