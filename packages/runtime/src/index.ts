import type {
  Telemetry,
  Observation,
  ObservationResult,
  ObservationData,
} from "@harness/telemetry";
import { executionFailure } from "@harness/errors";
import type { Contexts } from "@harness/context";
import type { AgentMiddleware } from "@harness/execution/middleware";
import type { RunScope } from "@harness/scope";
import type { Models } from "@harness/models";
import {
  renderPrompt,
  promptManifest,
  type PromptDefinition,
  type Prompts,
} from "@harness/prompts";
import {
  ServiceError,
  type Actor,
  type AgentEvent,
  type AgentMessage,
  type AgentExecutor,
  type Tools,
  type AgentLimits,
  type Sessions,
  type Run,
} from "@harness";
import { openMiddleware, notifyRun } from "@runtime/middleware";

import { policy, type ExecutionContext } from "@flow";
import { logger, withLogContext } from "@logging";

export function createRuntime(options: {
  sessions: Sessions;
  agent?: AgentExecutor;
  tools: Tools;
  limits: AgentLimits;
  system: PromptDefinition;
  prompts: Prompts;
  timeoutMs: number;
  contexts: Contexts;
  models?: Models;
  middleware?: readonly AgentMiddleware[];
  telemetry: Telemetry;
}) {
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const admissions = new Set<Promise<unknown>>();
  let closing = false;
  let healthy = true;

  async function runAgent(
    input: { actor: Actor; run: Run; observation: Observation },
    execution: ExecutionContext,
  ) {
    const { actor, run, observation } = input;
    const signal = execution.signal!;
    const prompts = await options.prompts.resolve(signal);
    observation.update({ metadata: { prompts: promptManifest(prompts) } });
    const history = await options.contexts.load(actor, run.id, prompts);
    const user = history.turns
      .find((turn) => turn.runId === run.id)
      ?.messages.find((message) => message.role === "user");
    if (user?.role === "user")
      observation.update(() => ({ input: [{ role: "user", content: user.text }] }));

    const scope = createRunScope(actor, run, signal, options.limits.maxTokens);

    const middleware = await openMiddleware(
      scope,
      history,
      prompts,
      options.middleware ?? [],
      options.models,
      options.telemetry,
    );
    let tools: Awaited<ReturnType<Tools["open"]>> | undefined;

    try {
      await middleware.start();
      tools = await options.tools.open(
        middleware.execution.scope,
        options.limits.maxToolCalls,
        middleware.execution.tool,
      );
      const toolTitles = new Map(
        tools.definitions.map(({ name, displayName }) => [name, displayName]),
      );

      await options.agent!.run({
        system: renderPrompt(prompts[options.system.key]!),
        messages: history.turns.flatMap((turn) => turn.messages),
        tools,
        execution: middleware.execution,
        limits: options.limits,
        onEvent: async (event) => {
          signal.throwIfAborted();
          const prepared = withToolTitles(event, toolTitles);
          await options.sessions.append(run, prepared);

          if (prepared.type === "message" && prepared.message.role === "assistant") {
            const message = prepared.message;
            observation.update(() => assistantOutput(message));
          }
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
    const observation = options.telemetry.start({
      name: "agent.run",
      type: "agent",
      trace: { sessionId: run.sessionId, metadata: { runId: run.id } },
      metadata: { runId: run.id },
    });
    let result: ObservationResult = { status: "completed" };
    const task = () =>
      withLogContext({ runId: run.id, sessionId: run.sessionId }, async () => {
        notifyRun(options.middleware ?? [], {
          type: "started",
          runId: run.id,
          sessionId: run.sessionId,
          actor,
          status: "running",
        });
        let status: "completed" | "cancelled" | "failed" = "completed";
        try {
          await policy(runAgent).timeout(options.timeoutMs).build()(
            { actor, run, observation },
            { signal: controller.signal },
          );
        } catch (error) {
          status = controller.signal.aborted ? "cancelled" : "failed";
          const failure = executionFailure(error, controller.signal);
          result = status === "cancelled" ? { status } : failure;
          logger.warn({
            event: "run.execution_failed",
            code: failure.errorCode,
          });
        }
        // A completed model is not a committed run. Failed persistence stops admission.
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
          result = { status: "failed", errorCode: "RUN_PERSISTENCE_FAILED" };
          logger.error({ event: "run.persistence_failed" });
        } finally {
          observation.update({ metadata: { executionStatus: status } });
        }
      });
    try {
      await observation.within(task);
    } finally {
      observation.end(result);
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

function createRunScope(actor: Actor, run: Run, signal: AbortSignal, maxTokens: number): RunScope {
  let consumed = 0;
  return Object.freeze({
    actor: Object.freeze({ ...actor }),
    runId: run.id,
    sessionId: run.sessionId,
    signal,
    budget: {
      get remaining() {
        return Math.max(0, maxTokens - consumed);
      },
      record(tokens: number) {
        if (!Number.isFinite(tokens) || tokens < 0)
          throw new ServiceError("MODEL_USAGE", "模型用量无效");
        consumed += tokens;
        if (consumed > maxTokens) throw new ServiceError("AGENT_LIMIT", "运行 token 预算已达上限");
      },
    },
  });
}

/** Snapshot trusted tool titles without mutating the executor's message. */
function withToolTitles(
  event: AgentEvent,
  titles: ReadonlyMap<string, string | undefined>,
): AgentEvent {
  if (event.type !== "message" || event.message.role !== "assistant") return event;

  return {
    ...event,
    message: {
      ...event.message,
      content: event.message.content.map((part) => {
        if (part.type !== "tool-call") return part;
        const displayName = titles.get(part.name);
        return {
          type: part.type,
          id: part.id,
          name: part.name,
          input: part.input,
          ...(displayName ? { displayName } : {}),
        };
      }),
    },
  };
}

function assistantOutput(message: Extract<AgentMessage, { role: "assistant" }>): ObservationData {
  const answer = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return answer ? { output: [{ role: "assistant", content: answer }] } : {};
}
