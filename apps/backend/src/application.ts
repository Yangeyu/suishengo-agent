import type { AgentExecutor, ToolDefinition } from "@harness";
import { noopTelemetry } from "@harness/telemetry";
import type { AgentMiddleware } from "@harness/execution/middleware";
import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";

import { createRuntime } from "@runtime";
import { sessionsPg } from "@plugins/sessions-pg/src/index";
import { pi } from "@plugins/pi/src/loop/index";
import { piModels } from "@plugins/pi/src/model/index";
import { createBailianProvider } from "@plugins/pi/src/model/providers/bailian";
import { createContext } from "@plugins/context/src/index";

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
      const errors: unknown[] = [];
      const release = async (dispose: () => Promise<unknown>) => {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      };
      await release(async () => runtime?.close());
      await release(async () => http?.close());
      for (const fiber of [...fibers].reverse()) await release(() => fiber.dispose());
      await release(() => ctx.fiber.dispose());
      if (errors.length) throw new AggregateError(errors, "Application shutdown failed");
    })());

  try {
    await mount(sessionsPg, config.storage);
    if (config.telemetry) await mount(telemetry, config.telemetry);
    else ctx.provide("telemetry", noopTelemetry);

    await mount(mcp, config.tools.mcp);
    await mount(toolsPlugin, {
      sessions: ctx.sessions,
      definitions: overrides.tools,
      sources: [ctx.get("mcp")],
      telemetry: ctx.telemetry,
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
    const context = createContext({
      sessions: ctx.sessions,
      store: ctx.sessions,
      config: config.context,
      telemetry: ctx.telemetry,
    });
    const middleware: AgentMiddleware[] = [...context.middleware, ...(overrides.middleware ?? [])];
    await mount(prompts, {
      ...config.prompts,
      definitions: [systemPrompt, ...middleware.flatMap((item) => item.prompts ?? [])],
      connection: config.langfuse,
    });

    runtime = createRuntime({
      sessions: ctx.sessions,
      agent: ctx.get("agent"),
      tools: ctx.tools,
      limits: config.runtime.limits,
      system: systemPrompt,
      prompts: ctx.prompts,
      timeoutMs: config.runtime.timeoutMs,
      models,
      contexts: context.contexts,
      middleware,
      telemetry: ctx.telemetry,
    });
    http = createHttp({
      sessions: ctx.sessions,
      runtime,
      businessTools: Boolean(config.tools.mcp) || Boolean(overrides.tools?.length),
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
    try {
      await close();
    } catch {
      logger.error({ event: "backend.cleanup_failed" });
    }
    throw error;
  }
}
