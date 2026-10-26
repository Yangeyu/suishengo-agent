import { ServiceError } from "@harness";
import { estimateContext, type ConversationHistory } from "@harness/context";
import type { ModelInput, ModelHandler, ModelResult, Models } from "@harness/models";
import type { AgentExecution } from "@harness/execution";
import type {
  AgentMiddleware,
  MiddlewareInstance,
  RunLifecycleEvent,
} from "@harness/execution/middleware";
import type { RunScope } from "@harness/scope";
import type { ToolHandler } from "@harness/tools";
import { logger } from "@logging";

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }

  return value;
}

function validateContext(context: ModelInput, granted: ModelInput["tools"]) {
  const names = new Set<string>();
  for (const tool of context.tools) {
    if (
      names.has(tool.name) ||
      !granted.some((item) => JSON.stringify(item) === JSON.stringify(tool))
    ) {
      throw new ServiceError("CONTEXT_TOOLS", "上下文不能扩大或改写工具授权");
    }
    names.add(tool.name);
  }

  const pending = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.callId))
        throw new ServiceError("CONTEXT_MESSAGES", "工具结果缺少调用");
      continue;
    }
    if (pending.size) throw new ServiceError("CONTEXT_MESSAGES", "工具调用缺少结果");
    if (message.role === "assistant") {
      for (const part of message.content)
        if (part.type === "tool-call") {
          if (pending.has(part.id)) throw new ServiceError("CONTEXT_MESSAGES", "工具调用重复");
          pending.add(part.id);
        }
    }
  }
  if (pending.size) throw new ServiceError("CONTEXT_MESSAGES", "工具调用缺少结果");
}

export async function openMiddleware(
  inputScope: RunScope,
  inputHistory: ConversationHistory,
  definitions: readonly AgentMiddleware[],
  models?: Models,
) {
  const controller = new AbortController();
  const scope = Object.freeze({
    ...inputScope,
    signal: AbortSignal.any([inputScope.signal, controller.signal]),
  });
  const history = frozen(structuredClone(inputHistory));
  const instances: MiddlewareInstance[] = [];
  let closed = false;

  const close = async () => {
    if (closed) return;

    closed = true;
    controller.abort();

    const errors: unknown[] = [];
    for (const instance of [...instances].reverse()) {
      try {
        await instance.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) throw new AggregateError(errors, "Middleware disposal failed");
  };

  const modelService = () => {
    if (!models) throw new ServiceError("MODEL_NOT_CONFIGURED", "尚未配置模型服务");
    return models;
  };

  let allowedTools = new Set<string>();
  const execution: AgentExecution = {
    scope,
    history,
    abort: (reason) => controller.abort(reason),
    models: { resolve: (id) => modelService().resolve(id) },
    async model(initial, call) {
      scope.signal.throwIfAborted();

      let context = structuredClone(initial.context);
      if (initial.purpose === "conversation") {
        for (const instance of instances) {
          if (instance.beforeModel)
            context = await instance.beforeModel(
              frozen({ ...initial, context: structuredClone(context) }),
            );
          scope.signal.throwIfAborted();
        }
      }

      validateContext(context, initial.context.tools);
      if (initial.purpose === "conversation")
        allowedTools = new Set(context.tools.map((tool) => tool.name));

      const request = frozen({ ...initial, context: structuredClone(context) });
      const controller = new AbortController();
      const signal = AbortSignal.any([scope.signal, controller.signal]);

      const terminal: ModelHandler = async (input) => {
        const model = modelService().resolve(input.model.id);
        validateContext(input.context, context.tools);
        if (initial.purpose === "conversation")
          allowedTools = new Set(input.context.tools.map((tool) => tool.name));

        const estimate = estimateContext(input.context);
        const maxOutputTokens = Math.min(
          input.maxOutputTokens,
          model.maxOutputTokens,
          scope.budget.remaining - estimate,
        );
        if (maxOutputTokens < 1) throw new ServiceError("AGENT_LIMIT", "运行 token 预算已达上限");
        if (estimate + maxOutputTokens > model.contextWindow)
          throw new ServiceError("CONTEXT_LIMIT", "必要上下文超过模型窗口");

        const result = frozen(
          await (call ?? modelService().generate)(frozen({ ...input, model, maxOutputTokens }), {
            ...scope,
            signal,
          }),
        );
        scope.budget.record(result.usage.total);

        return result;
      };

      const execute = instances.reduceRight<ModelHandler>((next, instance) => {
        if (!instance.wrapModelCall) return next;
        return async (input) => {
          let called = false;
          let settled = false;
          let pending: Promise<ModelResult> | undefined;
          try {
            const result = await instance.wrapModelCall!(input, (updated) => {
              if (called || settled)
                throw new ServiceError("MIDDLEWARE_REENTRY", "模型调用不能重复执行");
              called = true;
              pending = next(frozen(structuredClone(updated)));
              return pending;
            });
            // Wrappers control the call; output replacement would disagree with the native stream.
            if (!pending || result !== (await pending))
              throw new ServiceError("MIDDLEWARE_RESULT", "模型中间件必须返回本次调用结果");

            return result;
          } finally {
            settled = true;
            await pending?.catch(() => undefined);
          }
        };
      }, terminal);

      let result: ModelResult;
      try {
        result = await execute(request);
        scope.signal.throwIfAborted();
      } finally {
        controller.abort();
      }

      // Only commit a final response after all wrappers and provider cleanup have settled.
      if (initial.purpose === "conversation") {
        const snapshot = frozen(structuredClone(result));
        for (const instance of [...instances].reverse()) {
          await instance.afterModel?.(snapshot);
          scope.signal.throwIfAborted();
        }
      }

      return result;
    },
    async tool(call, terminal) {
      scope.signal.throwIfAborted();
      if (!allowedTools.has(call.name))
        throw new ServiceError("TOOL_FORBIDDEN", "工具未在本次上下文中开放");

      const original = frozen(structuredClone(call));

      const execute = instances.reduceRight<ToolHandler>((next, instance) => {
        if (!instance.wrapToolCall) return next;
        return async (input) => {
          let called = false;
          let pending: Promise<Awaited<ReturnType<ToolHandler>>> | undefined;
          let settled = false;
          try {
            return await instance.wrapToolCall!(input, (updated) => {
              if (called || settled)
                throw new ServiceError("MIDDLEWARE_REENTRY", "工具不能重复执行");
              if (JSON.stringify(updated) !== JSON.stringify(original)) {
                throw new ServiceError("MIDDLEWARE_TOOL_INPUT", "工具中间件不能改写调用");
              }
              called = true;
              pending = next(original);
              return pending;
            });
          } finally {
            settled = true;
            // Do not release a run while a faulty wrapper left an effect in flight.
            await pending?.catch(() => undefined);
          }
        };
      }, terminal);

      const result = await execute(original);
      scope.signal.throwIfAborted();

      return result;
    },
  };

  let ready = false;
  try {
    const names = new Set<string>();
    for (const definition of definitions) {
      scope.signal.throwIfAborted();
      if (names.has(definition.name)) throw new Error("Duplicate middleware: " + definition.name);
      names.add(definition.name);
      instances.push(
        await definition.create(scope, {
          history,
          models: {
            resolve: (id) => modelService().resolve(id),
            generate: (request) => {
              if (!ready) throw new Error("Model execution belongs in middleware hooks, not setup");
              return execution.model(request);
            },
          },
        }),
      );
    }
  } catch (error) {
    try {
      await close();
    } catch {
      logger.error({ event: "middleware.dispose_failed" });
    }
    throw error;
  }

  ready = true;

  return {
    execution,
    async start() {
      for (const instance of instances) {
        await instance.beforeAgent?.();
        scope.signal.throwIfAborted();
      }
    },
    async finish() {
      for (const instance of [...instances].reverse()) {
        scope.signal.throwIfAborted();
        await instance.afterAgent?.();
      }
    },
    close,
  };
}

/** Observers receive committed facts. Their failures and pending promises do not own the run. */
export function notifyRun(definitions: readonly AgentMiddleware[], event: RunLifecycleEvent) {
  const snapshot = frozen(structuredClone(event));
  for (const definition of definitions) {
    if (definition.onRunEvent)
      void Promise.resolve()
        .then(() => definition.onRunEvent!(snapshot))
        .catch(() =>
          logger.warn({ event: "middleware.observer_failed", middleware: definition.name }),
        );
  }
}
