import type { Context } from "@deepseek-ai/cordis";
import { LangfuseClient } from "@langfuse/client";
import type { LangfuseConnection } from "@plugins/telemetry/src/index";

declare module "@deepseek-ai/cordis" { interface Context { systemPrompt: string } }
export const prompts = {
  name: "prompts",
  async apply(ctx: Context, options: { local: string; connection?: LangfuseConnection; remote?: { name: string; version: number } }) {
    if (!options.remote) { ctx.provide("systemPrompt", options.local); return; }
    if (!options.connection) throw new Error("Missing Langfuse connection");
    const client = new LangfuseClient({ ...options.connection, timeout: 5 });
    ctx.effect(() => () => client.shutdown());
    // Resolve a fixed version once at startup. An unavailable configured prompt fails readiness.
    const prompt = await client.prompt.get(options.remote.name, {
      type: "text", version: options.remote.version, fetchTimeoutMs: 5000, maxRetries: 0,
    });
    if (prompt.isFallback) throw new Error("Configured prompt is unavailable");
    ctx.provide("systemPrompt", prompt.prompt);
  },
};
