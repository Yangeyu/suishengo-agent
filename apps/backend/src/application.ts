import type { AgentExecutor, ToolDefinition } from "@harness";
import type { AgentMiddleware } from "@harness/execution/middleware";
import { Context, type Fiber } from "@deepseek-ai/cordis";

import { createRuntime } from "@runtime";
import { sessionsPg } from "@plugins/sessions-pg/src/index";
import { pi } from "@plugins/pi/src/loop/index";
import { piModels } from "@plugins/pi/src/model/index";
import { createContexts } from "@plugins/context/src/index";
import { contextCompaction } from "@plugins/context/src/compaction";

import { telemetry } from "@plugins/telemetry/src/index";
import { prompts } from "@plugins/prompts/src/index";
import { createHttp } from "@backend/http/index";
import { createAuthenticator } from "@backend/http/auth";
import { systemPrompt } from "@backend/agent/prompts";
import type { Config } from "@backend/config";
import { toolsPlugin } from "@plugins/tools/src/index";
import { mcp } from "@plugins/mcp/src/index";
import { logger } from "@logging";

export async function createApplication(
  config: Config,
  overrides: {
    agent?: AgentExecutor;
    tools?: ToolDefinition[];
    middleware?: readonly AgentMiddleware[];
  } = {},
) {
  logger.level = config.logLevel;
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

  // 先排空运行和 HTTP 请求，再逆序释放插件持有的连接与观测资源。
  const close = () =>
    (closing ??= (async () => {
      await runtime?.close();
      await http?.close();
      for (const fiber of [...fibers].reverse()) await fiber.dispose();
      await ctx.fiber.dispose();
    })());

  try {
    await mount(
      ctx.plugin(sessionsPg, {
        url: config.databaseUrl,
        limits: { global: config.globalLimit, perUser: config.userLimit },
      }),
    );
    await mount(ctx.plugin(telemetry, config.langfuse));
    await mount(
      ctx.plugin(prompts, {
        local: systemPrompt,
        connection: config.langfuse,
        remote: config.prompt,
      }),
    );

    if (config.mcp) await mount(ctx.plugin(mcp, config.mcp));
    await mount(
      ctx.plugin(toolsPlugin, {
        definitions: overrides.tools ?? [],
        sources: config.mcp ? [ctx.mcp] : [],
        telemetry: ctx.telemetry,
      }),
    );

    if (config.modelId && config.modelBaseUrl) {
      await mount(
        ctx.plugin(piModels, {
          modelId: config.modelId,
          baseUrl: config.modelBaseUrl,
          contextWindow: config.modelContextWindow,
          maxOutputTokens: config.modelOutputTokens,
          telemetry: ctx.telemetry,
        }),
      );
    }
    if (overrides.agent) ctx.provide("agent", overrides.agent);
    else if (ctx.get("models")) await mount(ctx.plugin(pi));

    const models = ctx.get("models");
    const compaction =
      models && config.compaction
        ? contextCompaction({ store: ctx.sessions, policy: config.compaction })
        : undefined;

    runtime = createRuntime({
      sessions: ctx.sessions,
      agent: ctx.get("agent"),
      tools: ctx.tools,
      limits: config.limits,
      system: ctx.systemPrompt,
      timeoutMs: config.timeoutMs,
      telemetry: ctx.telemetry,
      models,
      contexts: createContexts(
        ctx.sessions,
        ctx.sessions,
        compaction ? config.compaction!.version : undefined,
      ),
      middleware: [...(compaction ? [compaction] : []), ...(overrides.middleware ?? [])],
    });
    http = createHttp({
      sessions: ctx.sessions,
      runtime,
      authenticate: createAuthenticator(config),
    });

    return {
      http,
      runtime,
      sessions: ctx.sessions,
      listen: () => http!.listen({ host: config.host, port: config.port }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
