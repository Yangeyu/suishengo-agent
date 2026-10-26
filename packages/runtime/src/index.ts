import { ServiceError, type Actor, type Model, type Sessions, type Telemetry, type RunStatus } from "@harness";

export function createRuntime(options: { sessions: Sessions; model?: Model; system: string; timeoutMs: number; telemetry: Telemetry }) {
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closing = false;
  let healthy = true;
  const admissions = new Set<Promise<unknown>>();

  async function execute(actor: Actor, run: Awaited<ReturnType<Sessions["getRun"]>>, controller: AbortController) {
    const trace = options.telemetry.start(run.id, run.sessionId);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Run deadline exceeded")); }, options.timeoutMs);
    let status: Exclude<RunStatus, "running"> = "completed";
    try {
      const history = await options.sessions.history(actor, run);
      await options.model!.generate({
        system: options.system, messages: history, signal: controller.signal,
        onText: async delta => {
          controller.signal.throwIfAborted();
          await options.sessions.appendText(run, delta);
        },
      });
      controller.signal.throwIfAborted();
    } catch {
      status = controller.signal.aborted && !timedOut ? "cancelled" : "failed";
    } finally {
      clearTimeout(timer);
    }
    try {
      await options.sessions.finish(run, status);
    } catch {
      healthy = false;
      console.error(JSON.stringify({ event: "run.persistence_failed", runId: run.id }));
    } finally {
      trace.end(status);
      active.delete(run.id);
    }
  }

  async function admit(actor: Actor, input: Parameters<Sessions["admit"]>[1]) {
    if (closing || !healthy) throw new ServiceError("NOT_READY", 503, "服务暂不可用");
    if (!options.model) throw new ServiceError("MODEL_NOT_CONFIGURED", 503, "尚未配置模型服务");
    const result = await options.sessions.admit(actor, input);
    if (result.created) {
      const controller = new AbortController();
      if (closing) controller.abort();
      // Defer execution until the map entry exists; each run owns its state and cancellation.
      const done = Promise.resolve().then(() => execute(actor, result.run, controller));
      active.set(result.run.id, { controller, done });
    }
    return result.run;
  }
  return {
    available: () => !closing && healthy,
    modelConfigured: Boolean(options.model),
    async submit(actor: Actor, input: Parameters<Sessions["admit"]>[1]) {
      const task = admit(actor, input);
      admissions.add(task);
      try { return await task; } finally { admissions.delete(task); }
    },
    async cancel(actor: Actor, runId: string) {
      await options.sessions.getRun(actor, runId);
      const task = active.get(runId);
      task?.controller.abort();
      await task?.done;
      return options.sessions.getRun(actor, runId);
    },
    async close() {
      closing = true;
      await Promise.allSettled([...admissions]);
      const tasks = [...active.values()];
      for (const task of tasks) task.controller.abort();
      await Promise.allSettled(tasks.map(task => task.done));
    },
  };
}
export type Runtime = ReturnType<typeof createRuntime>;
