import type { StepExecution } from "@harness/execution";
import { ServiceError, type AgentExecutor, type JsonValue } from "@harness";
import type { Context } from "@deepseek-ai/cordis";
import { Agent, type AgentEvent as PiEvent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { fromPi, toPi, emptyUsage } from "@plugins/pi/src/messages";

import { modelResult } from "@plugins/pi/src/model/index";

declare module "@deepseek-ai/cordis" {
  interface Context {
    agent: AgentExecutor;
  }
}

export const pi = {
  name: "pi",
  inject: ["piModel"],

  apply(ctx: Context) {
    ctx.provide("agent", {
      async run(input) {
        const { signal } = input.execution.scope;
        signal.throwIfAborted();
        let step = 0;
        let activeStep: StepExecution | undefined;
        let toolCalls = 0;
        let failure: unknown;

        const model = ctx.piModel.model;
        const pending = new Set<Promise<void>>();
        const callModel = (messages: Message[], signal?: AbortSignal) => {
          const output = createAssistantMessageEventStream();
          const abort = () => input.execution.abort(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();

          const produce = async () => {
            try {
              const info = input.execution.models.resolve();
              let completed: Extract<AssistantMessageEvent, { type: "done" }> | undefined;
              await activeStep!.within(() =>
                input.execution.model(
                  {
                    model: info,
                    purpose: "conversation",
                    prompt: input.prompt,
                    maxOutputTokens: info.maxOutputTokens,
                    context: {
                      system: input.system,
                      summary: input.execution.history.summary?.text,
                      messages: messages.filter((message) => message.role !== "system").map(fromPi),
                      tools: input.tools.definitions,
                    },
                  },
                  async (request, scope) => {
                    completed = await ctx.piModel.call(request, scope, (event) =>
                      output.push(event),
                    );
                    return modelResult(completed);
                  },
                ),
              );
              // Native completion is released only after policy hooks and resource cleanup succeed.
              if (!completed) throw new Error("Model call produced no completion");
              output.push(completed);
            } catch (error) {
              failure ??= error;
              const reason = input.execution.scope.signal.aborted ? "aborted" : "error";
              output.push({
                type: "error",
                reason,
                error: {
                  role: "assistant",
                  content: [],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  timestamp: Date.now(),
                  usage: structuredClone(emptyUsage),
                  stopReason: reason,
                  errorMessage: "模型调用未完成",
                },
              });
            } finally {
              signal?.removeEventListener("abort", abort);
              output.end();
            }
          };
          const task = produce();
          pending.add(task);
          void task.then(() => pending.delete(task));
          return output;
        };

        // 模型配置可共享，历史、预算和取消状态必须按运行隔离。
        const agent = new Agent({
          initialState: {
            model,
            systemPrompt: input.system,
            messages: input.messages.map((message) => toPi(message, model)),
            tools: input.tools.definitions.map((tool) => ({
              name: tool.name,
              label: tool.name,
              description: tool.description,
              parameters: Type.Unsafe<Record<string, JsonValue>>(tool.inputSchema),
              execute: async (callId, args) => {
                const output = await activeStep!.within(() =>
                  input.tools.invoke(callId, tool.name, args),
                );
                return {
                  content: [{ type: "text" as const, text: JSON.stringify(output) }],
                  details: { output },
                };
              },
            })),
          },
          toolExecution: "sequential",

          prepareRequest: async () => {
            if (failure) throw failure;
            signal.throwIfAborted();
            if (step > input.limits.maxSteps || input.execution.scope.budget.remaining <= 0) {
              failure = new ServiceError("AGENT_LIMIT", "Agent 轮数或 token 预算已达上限");
              throw failure;
            }
          },

          beforeToolCall: async () => {
            if (++toolCalls > input.limits.maxToolCalls) {
              failure = new ServiceError("TOOL_LIMIT", "工具调用次数已达上限");
              input.execution.abort(failure);
              agent.abort();
              return { block: true, reason: "工具调用次数已达上限", terminate: true };
            }
          },

          streamFn: (_selected, context, settings) => callModel(context.messages, settings?.signal),
        });

        async function persistEvent(event: PiEvent) {
          if (event.type === "turn_start") {
            activeStep = input.execution.startStep(++step);
            return input.onEvent({ type: "step-start", step });
          }
          if (event.type === "turn_end") {
            await input.onEvent({ type: "step-end", step });
            activeStep?.end(
              failure || signal.aborted
                ? input.execution.outcome(failure ?? signal.reason)
                : { status: "completed" },
            );
            activeStep = undefined;
            return;
          }

          if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta.type === "text_start")
              await input.onEvent({ type: "text-start", id: `${step}:${delta.contentIndex}` });
            if (delta.type === "text_delta")
              await input.onEvent({
                type: "text-delta",
                id: `${step}:${delta.contentIndex}`,
                delta: delta.delta,
              });
            if (delta.type === "text_end")
              await input.onEvent({ type: "text-end", id: `${step}:${delta.contentIndex}` });
            if (delta.type === "thinking_start")
              await input.onEvent({ type: "reasoning-start", id: `${step}:${delta.contentIndex}` });
            if (delta.type === "thinking_delta")
              await input.onEvent({
                type: "reasoning-delta",
                id: `${step}:${delta.contentIndex}`,
                delta: delta.delta,
              });
            if (delta.type === "thinking_end")
              await input.onEvent({ type: "reasoning-end", id: `${step}:${delta.contentIndex}` });
            return;
          }
          if (event.type !== "message_end") return;

          const message = event.message;
          if (message.role === "assistant") {
            if (message.stopReason === "error" || message.stopReason === "aborted") return;
            const converted = fromPi(message);
            if (converted.role !== "user")
              await input.onEvent({ type: "message", message: converted });
          }
          if (message.role === "toolResult") {
            const converted = fromPi(message);
            if (converted.role !== "user")
              await input.onEvent({ type: "message", message: converted });
          }
        }

        const unsubscribe = agent.subscribe(async (event) => {
          try {
            await persistEvent(event);
          } catch (error) {
            // 不能在持久化失败后继续产生工具副作用。
            failure ??= error;
            input.execution.abort(error);
            agent.abort();
            throw error;
          }
        });

        const abort = () => agent.abort();
        signal.addEventListener("abort", abort, { once: true });

        try {
          signal.throwIfAborted();
          await agent.continue();
          if (failure) throw failure;
          signal.throwIfAborted();

          const last = agent.state.messages.at(-1);
          if (!last || last.role !== "assistant" || last.stopReason !== "stop") {
            throw new ServiceError("MODEL_FAILED", "模型未正常完成回答");
          }
        } catch (error) {
          failure ??= error;
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
          agent.abort();
          await agent.waitForIdle();
          await Promise.all(pending);
          unsubscribe();
          activeStep?.end(
            failure || signal.aborted
              ? input.execution.outcome(failure ?? signal.reason)
              : { status: "completed" },
          );
        }
      },
    } satisfies AgentExecutor);
  },
};
