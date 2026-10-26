import type { AgentExecutor, ToolDefinition } from "@harness";
import type { AgentMiddleware } from "@harness/execution/middleware";
import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";

import { createRuntime } from "@runtime";
import { sessionsPg } from "@plugins/sessions-pg/src/index";
import { pi } from "@plugins/pi/src/loop/index";
import { piModels } from "@plugins/pi/src/model/index";
import { createBailianProvider } from "@plugins/pi/src/model/providers/bailian";
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
  logger.level = config.logging.level;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let http: ReturnType<typeof createHttp> | undefined;
  let closing: Promise<void> | undefined;

  const mount = async <T>(plugin: Plugin.Object<T>, options: NoInfer<T> | false) => {
    if (options === false) return;
    const activation = ctx.plugin(plugin, options);
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
    await mount(sessionsPg, config.storage);
    await mount(telemetry, config.telemetry);
    await mount(prompts, {
      local: systemPrompt,
      connection: config.telemetry.connection,
      remote: config.prompts.remote,
    });

    await mount(mcp, config.tools.mcp);
    await mount(toolsPlugin, {
      definitions: overrides.tools,
      sources: [ctx.get("mcp")],
    });

    await mount(
      piModels,
      config.model && {
        provider: createBailianProvider({
          apiKey: config.model.apiKey,
          baseUrl: config.model.baseUrl,
        }),
        modelId: config.model.modelId,
        maxOutputTokens: config.model.maxOutputTokens,
      },
    );
    if (overrides.agent) ctx.provide("agent", overrides.agent);
    else if (config.model) await mount(pi, undefined);

    const models = ctx.get("models");
    const middleware: AgentMiddleware[] = [];
    let summaryVersion: string | undefined;
    if (models && config.context.compaction) {
      const policy = config.context.compaction;
      middleware.push(contextCompaction({ store: ctx.sessions, policy }));
      summaryVersion = policy.version;
    }
    middleware.push(...(overrides.middleware ?? []));

    runtime = createRuntime({
      sessions: ctx.sessions,
      agent: ctx.get("agent"),
      tools: ctx.tools,
      limits: config.runtime.limits,
      system: ctx.systemPrompt.text,
      prompt: ctx.systemPrompt.reference,
      timeoutMs: config.runtime.timeoutMs,
      telemetry: ctx.telemetry,
      models,
      contexts: createContexts(ctx.sessions, ctx.sessions, summaryVersion),
      middleware,
    });
    http = createHttp({
      sessions: ctx.sessions,
      runtime,
      authenticate: createAuthenticator(config.auth),
    });

    return {
      http,
      runtime,
      sessions: ctx.sessions,
      listen: () => http!.listen(config.http),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
