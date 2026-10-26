import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { z } from "zod";

const defaultBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export const bailianConnectionSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  baseUrl: z.url({ protocol: /^https?$/ }).default(defaultBaseUrl),
});

// 模型能力与协议参数由接入验证确定。
export const bailianModels: readonly Model<"openai-completions">[] = [
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "dashscope",
    api: "openai-completions",
    baseUrl: defaultBaseUrl,
    contextWindow: 131072,
    maxTokens: 4096,
    reasoning: true,
    input: ["text"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportsLongCacheRetention: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen",
      requiresReasoningContentOnAssistantMessages: true,
    },
    // Pi 要求价格字段；实际费用仍由观测平台的模型价格映射计算。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export function createBailianProvider(input: z.input<typeof bailianConnectionSchema>) {
  const { apiKey, baseUrl } = bailianConnectionSchema.parse(input);
  return createProvider({
    id: "dashscope",
    name: "百炼",
    baseUrl,
    auth: {
      apiKey: {
        name: "百炼 API Key",
        resolve: async () => ({ auth: { apiKey }, source: "application" }),
      },
    },
    // 模型端点优先于 provider 端点，覆盖时必须同步更新模型。
    models: bailianModels.map((model) => ({ ...structuredClone(model), baseUrl })),
    api: openAICompletionsApi(),
  });
}
