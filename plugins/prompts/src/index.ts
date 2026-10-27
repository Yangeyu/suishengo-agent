import type { Context } from "@deepseek-ai/cordis";
import { LangfuseClient, type LangfuseClientParams } from "@langfuse/client";
import type { PromptDefinition, Prompts } from "@harness/prompts";
import type { PromptsOptions, PromptBinding } from "@plugins/prompts/src/config";
import { createPrompts } from "@plugins/prompts/src/service";
import { loadLangfusePrompt } from "@plugins/prompts/src/langfuse";

declare module "@deepseek-ai/cordis" {
  interface Context {
    prompts: Prompts;
  }
}

export const prompts = {
  name: "prompts",
  apply(
    ctx: Context,
    options: PromptsOptions & {
      definitions: readonly PromptDefinition[];
      connection?: Required<Pick<LangfuseClientParams, "baseUrl" | "publicKey" | "secretKey">>;
    },
  ) {
    const client = options.connection && new LangfuseClient({ ...options.connection, timeout: 5 });
    ctx.effect(() => () => client?.shutdown());

    const load = client
      ? (source: PromptBinding) => loadLangfusePrompt(client, source, options.cacheTtlSeconds)
      : undefined;
    const service = createPrompts(options.definitions, options.bindings, load);

    ctx.provide("prompts", service);
  },
};
