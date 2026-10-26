import type { Context } from "@deepseek-ai/cordis";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth, type Message, type Model as PiModel } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Model } from "@harness";

export interface PiOptions { baseUrl: string; modelId: string }
declare module "@deepseek-ai/cordis" { interface Context { model: Model } }

export const pi = {
  name: "pi",
  apply(ctx: Context, options: PiOptions) {
    const model: PiModel<"openai-completions"> = {
      id: options.modelId, name: options.modelId, provider: "configured",
      api: "openai-completions", baseUrl: options.baseUrl, reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const models = createModels();
    models.setProvider(createProvider({
      id: model.provider, baseUrl: model.baseUrl, models: [model],
      api: openAICompletionsApi(),
      auth: { apiKey: envApiKeyAuth("Model credential", ["MODEL_API_KEY"]) },
    }));
    const executor: Model = {
      async generate(input) {
        input.signal.throwIfAborted();
        const history: Message[] = input.messages.map(message => message.role === "user"
          ? { role: "user", content: message.text, timestamp: Date.now() }
          : {
            role: "assistant", content: [{ type: "text", text: message.text }],
            api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            stopReason: "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          });
        const agent = new Agent({
          initialState: { model, systemPrompt: input.system, messages: history, tools: [] },
          streamFn: (selected, context, settings) => models.streamSimple(selected, context, {
            ...settings, maxTokens: 2048, maxRetries: 0,
          }),
        });
        let persistenceError: unknown;
        const unsubscribe = agent.subscribe(async event => {
          if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
          try { await input.onText(event.assistantMessageEvent.delta); }
          catch (error) { persistenceError = error; agent.abort(); throw error; }
        });
        const abort = () => agent.abort();
        input.signal.addEventListener("abort", abort, { once: true });
        try {
          await agent.continue();
          input.signal.throwIfAborted();
          if (persistenceError) throw persistenceError;
          const last = agent.state.messages.at(-1);
          if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
            throw new Error("Model generation failed");
          }
        } finally {
          input.signal.removeEventListener("abort", abort);
          agent.abort();
          await agent.waitForIdle();
          unsubscribe();
        }
      },
    };
    ctx.provide("model", executor);
  },
};
