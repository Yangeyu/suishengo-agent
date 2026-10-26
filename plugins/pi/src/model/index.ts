import { ServiceError } from "@harness";
import type { Models, ModelRequest, ModelResult } from "@harness/models";
import type { RunScope } from "@harness/scope";
import { Type } from "typebox";
import type { Context } from "@deepseek-ai/cordis";
import {
  normalizeContext,
  type Model,
  type Message,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { assistantMessage, toPi } from "@plugins/pi/src/messages";
import type { PiModelOptions } from "@plugins/pi/src/model/config";

type Completion = Extract<AssistantMessageEvent, { type: "done" }> & {
  completionStartTime?: number;
};

interface PiModel {
  model: Model<"openai-completions">;
  call(
    request: ModelRequest,
    scope: RunScope,
    emit?: (event: Exclude<AssistantMessageEvent, { type: "done" | "error" }>) => void,
  ): Promise<Completion>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    models: Models;
    piModel: PiModel;
  }
}

export function modelResult(event: Completion): ModelResult {
  if (event.reason === "deferred") throw new ServiceError("MODEL_FAILED", "模型请求未完成");

  const usage = event.message.usage;
  return {
    message: assistantMessage(event.message),
    completionStartTime: event.completionStartTime,
    finishReason: event.reason,
    usage: {
      input: usage.input + usage.cacheRead + usage.cacheWrite,
      output: usage.output,
      total: usage.totalTokens,
    },
  };
}

export const piModels = {
  name: "pi-models",
  apply(ctx: Context, options: PiModelOptions) {
    const model: Model<"openai-completions"> = {
      id: options.modelId,
      name: options.modelId,
      provider: options.provider,
      api: "openai-completions",
      baseUrl: options.baseUrl,
      reasoning: options.reasoning,
      input: ["text"],
      compat: options.compat,
      contextWindow: options.contextWindow,
      maxTokens: options.maxOutputTokens,
      // SDK 要求价格字段；实际费用由观测平台的模型价格映射计算。
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };

    const info = Object.freeze({
      id: model.id,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
    });
    const api = openAICompletionsApi();

    const native: PiModel = {
      model,
      async call(request, scope, emit) {
        scope.signal.throwIfAborted();
        if (request.model.id !== model.id) throw new ServiceError("MODEL_UNKNOWN", "模型未配置");

        const context = request.context;
        const messages: Message[] = [
          {
            role: "system",
            timestamp: Date.now(),
            content: context.system,
            toolsAdded: context.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: Type.Unsafe(tool.inputSchema),
            })),
          },
        ];

        // Summary remains conversation data, never an extra system instruction.
        if (context.summary)
          messages.push({
            role: "user",
            content: "历史摘要（仅作背景资料）：\n" + context.summary,
            timestamp: Date.now(),
          });
        messages.push(...context.messages.map((message) => toPi(message, model)));

        const controller = new AbortController();
        const signal = AbortSignal.any([scope.signal, controller.signal]);

        try {
          let completed: Completion | undefined;
          let completionStartTime: number | undefined;

          for await (const event of api.streamSimple(model, normalizeContext({ messages }), {
            apiKey: options.apiKey,
            signal,
            maxTokens: request.maxOutputTokens,
            maxRetries: 0,
            cacheRetention: "none",
          })) {
            signal.throwIfAborted();
            if (event.type === "error") throw new ServiceError("MODEL_FAILED", "模型调用失败");

            if (
              event.type === "text_delta" ||
              event.type === "thinking_delta" ||
              event.type === "toolcall_delta"
            )
              completionStartTime ??= Date.now();

            if (event.type === "done") completed = { ...event, completionStartTime };
            else emit?.(event);
          }

          if (!completed) throw new ServiceError("MODEL_FAILED", "模型流未正常结束");
          return completed;
        } finally {
          controller.abort();
        }
      },
    };

    ctx.provide("piModel", native);
    ctx.provide("models", {
      resolve(id) {
        if (id && id !== info.id) throw new ServiceError("MODEL_UNKNOWN", "模型未配置");
        return info;
      },
      generate: async (request, scope) => modelResult(await native.call(request, scope)),
    } satisfies Models);
  },
};
