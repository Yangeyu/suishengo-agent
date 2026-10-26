import type { Contexts } from "@harness/context";
import type { AgentMiddleware } from "@harness/execution/middleware";
import type { RunScope } from "@harness/scope";
import type { Models } from "@harness/models";
import {
  ServiceError,
  type Actor,
  type AgentExecutor,
  type Tools,
  type AgentLimits,
  type Sessions,
  type Telemetry,
  type Run,
  type RunStatus,
} from "@harness";
import { openMiddleware, notifyRun } from "@runtime/middleware";

import { policy, type ExecutionContext } from "@flow";
import { logger } from "@logging";

export function createRuntime(options: {
  sessions: Sessions;
  agent?: AgentExecutor;
  tools: Tools;
  limits: AgentLimits;
  system: string;
  timeoutMs: number;
  telemetry: Telemetry;
  contexts: Contexts;
  models?: Models;
  middleware?: readonly AgentMiddleware[];
}) {
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const admissions = new Set<Promise<unknown>>();
  let closing = false;
  let healthy = true;

  async function runAgent(input: { actor: Actor; run: Run }, execution: ExecutionContext) {
    const { actor, run } = input;
    const signal = execution.signal!;
    const history = await options.contexts.load(actor, run.id);

    let consumed = 0;
    const scope: RunScope = Object.freeze({
      actor: Object.freeze({ ...actor }),
      runId: run.id,
      sessionId: run.sessionId,
      signal,
      budget: {
        get remaining() {
          return Math.max(0, options.limits.maxTokens - consumed);
        },
        record(tokens: number) {
          if (!Number.isFinite(tokens) || tokens < 0)
            throw new ServiceError("MODEL_USAGE", "模型用量无效");
          consumed += tokens;
          if (consumed > options.limits.maxTokens)
            throw new ServiceError("AGENT_LIMIT", "运行 token 预算已达上限");
        },
      },
    });

    const middleware = await openMiddleware(
      scope,
      history,
      options.middleware ?? [],
      options.models,
    );
    let tools: Awaited<ReturnType<Tools["open"]>> | undefined;

    try {
      await middleware.start();
      tools = await options.tools.open(
        middleware.execution.scope,
        options.limits.maxToolCalls,
        middleware.execution.tool,
      );

      await options.agent!.run({
        system: options.system,
        messages: history.turns.flatMap((turn) => turn.messages),
        tools,
        execution: middleware.execution,
        limits: options.limits,
        onEvent: async (event) => {
          signal.throwIfAborted();
          await options.sessions.append(run, event);
        },
      });

      signal.throwIfAborted();
      await middleware.finish();
    } finally {
      try {
        await tools?.close();
      } finally {
        await middleware.close();
      }
    }
  }

  async function execute(actor: Actor, run: Run, controller: AbortController) {
    notifyRun(options.middleware ?? [], {
      type: "started",
      runId: run.id,
      sessionId: run.sessionId,
      actor,
      status: "running",
    });
    const trace = options.telemetry.start(run.id, run.sessionId);
    let status: Exclude<RunStatus, "running"> = "completed";

    try {
      await trace.within(() =>
        policy(runAgent).timeout(options.timeoutMs).build()(
          { actor, run },
          { signal: controller.signal },
        ),
      );
    } catch (error) {
      status = controller.signal.aborted ? "cancelled" : "failed";
      logger.warn({
        event: "run.execution_failed",
        runId: run.id,
        code: error instanceof ServiceError ? error.code : "EXECUTION_FAILED",
      });
    }

    // 终态落库失败后停止接单，避免数据库中仍运行的记录与进程状态继续分叉。
    try {
      await options.sessions.finish(run, status);
      notifyRun(options.middleware ?? [], {
        type: "finished",
        runId: run.id,
        sessionId: run.sessionId,
        actor,
        status,
      });
    } catch {
      healthy = false;
      logger.error({ event: "run.persistence_failed", runId: run.id });
    } finally {
      trace.end(status);
      active.delete(run.id);
    }
  }

  async function admit(actor: Actor, input: Parameters<Sessions["admit"]>[1]) {
    if (closing || !healthy) throw new ServiceError("NOT_READY", "服务暂不可用");
    if (!options.agent) throw new ServiceError("MODEL_NOT_CONFIGURED", "尚未配置模型服务");

    const result = await options.sessions.admit(actor, input);
    if (!result.created) return result.run;

    const controller = new AbortController();
    if (closing) controller.abort();

    // 先登记再执行，保证立即完成或取消的运行也能找到自己的生命周期记录。
    const done = Promise.resolve().then(() => execute(actor, result.run, controller));
    active.set(result.run.id, { controller, done });

    return result.run;
  }

  return {
    available: () => !closing && healthy,
    modelConfigured: Boolean(options.agent),
    toolsConfigured: options.tools.configured,

    async submit(actor: Actor, input: Parameters<Sessions["admit"]>[1]) {
      const task = admit(actor, input);
      admissions.add(task);

      try {
        return await task;
      } finally {
        admissions.delete(task);
      }
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
      await Promise.allSettled(tasks.map((task) => task.done));
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
