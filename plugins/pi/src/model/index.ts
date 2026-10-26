import { ServiceError } from "@harness";
import type { Models, ModelRequest, ModelResult } from "@harness/models";
import type { RunScope } from "@harness/scope";
import { Type } from "typebox";
import type { Context } from "@deepseek-ai/cordis";
import {
  createModels,
  type Api,
  type Model,
  type Provider,
  type Message,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";

import { assistantMessage, toPi } from "@plugins/pi/src/messages";

type Completion = Extract<AssistantMessageEvent, { type: "done" }> & {
  completionStartTime?: number;
};

interface PiModel {
  model: Model<Api>;
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
  apply(ctx: Context, options: { provider: Provider; modelId: string; maxOutputTokens: number }) {
    const collection = createModels();
    collection.setProvider(options.provider);
    const model = collection.getModel(options.provider.id, options.modelId);
    if (!model) throw new ServiceError("MODEL_UNKNOWN", "模型未配置");
    if (
      !Number.isInteger(options.maxOutputTokens) ||
      options.maxOutputTokens < 1 ||
      options.maxOutputTokens > model.maxTokens ||
      options.maxOutputTokens >= model.contextWindow
    )
      throw new Error("Model output limit exceeds the supported model capability");

    const info = Object.freeze({
      id: model.id,
      contextWindow: model.contextWindow,
      maxOutputTokens: options.maxOutputTokens,
    });

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

          for await (const event of collection.streamSimple(
            model,
            { messages },
            {
              signal,
              maxTokens: request.maxOutputTokens,
              maxRetries: 0,
              cacheRetention: "none",
            },
          )) {
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
