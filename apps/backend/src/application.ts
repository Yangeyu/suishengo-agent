import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { Model } from "@harness";
import { createRuntime } from "@runtime";
import { sessionsPg } from "@plugins/sessions-pg/src/index";
import { pi } from "@plugins/pi/src/index";
import { telemetry } from "@plugins/telemetry/src/index";
import { prompts } from "@plugins/prompts/src/index";
import { createHttp } from "@backend/http/index";
import { createAuthenticator } from "@backend/http/auth";
import { systemPrompt } from "@backend/agent/prompts";
import type { Config } from "@backend/config";

export async function createApplication(config: Config, overrides: { model?: Model } = {}) {
  const ctx = new Context();
  const fibers: Fiber[] = [];
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let http: ReturnType<typeof createHttp> | undefined;
  let closing: Promise<void> | undefined;
  const mount = async (activation: Fiber & PromiseLike<Fiber>) => {
    fibers.push(activation);
    const fiber = await activation;
    if (fiber.state !== 2) throw new Error("Plugin startup failed: " + fiber.name);
  };
  const close = () => closing ??= (async () => {
    await runtime?.close();
    await http?.close();
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    await ctx.fiber.dispose();
  })();
  try {
    await mount(ctx.plugin(sessionsPg, {
      url: config.databaseUrl, limits: { global: config.globalLimit, perUser: config.userLimit },
    }));
    await mount(ctx.plugin(telemetry, config.langfuse));
    await mount(ctx.plugin(prompts, { local: systemPrompt, connection: config.langfuse, remote: config.prompt }));
    if (overrides.model) ctx.provide("model", overrides.model);
    else if (config.modelId && config.modelBaseUrl) await mount(ctx.plugin(pi, { modelId: config.modelId, baseUrl: config.modelBaseUrl }));

    runtime = createRuntime({
      sessions: ctx.sessions, model: ctx.get("model"), system: ctx.systemPrompt,
      timeoutMs: config.timeoutMs, telemetry: ctx.telemetry,
    });
    http = createHttp({ sessions: ctx.sessions, runtime, authenticate: createAuthenticator(config) });
    return {
      http, runtime, sessions: ctx.sessions,
      listen: () => http!.listen({ host: config.host, port: config.port }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
