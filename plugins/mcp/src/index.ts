import {
  ServiceError,
  type ToolContext,
  type ToolSource,
  type ToolDefinition,
  type JsonValue,
} from "@harness";
import type { Context } from "@deepseek-ai/cordis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";
import { z } from "zod";

export const mcpOptionsSchema = z.strictObject({
  url: z.url(),
  allowedTools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/)).min(1),
  serviceToken: z.string().min(1),
  actorSecret: z.string().min(32),
  audience: z.string().min(1),
});
export type McpOptions = z.infer<typeof mcpOptionsSchema>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    mcp: ToolSource;
  }
}

function createTransport(options: McpOptions, context: ToolContext) {
  return new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: async (url, init) => {
      // 自定义服务间身份契约：接收方必须验签并据此授权，不能信任模型传入的 userId。
      const assertion = await new SignJWT({ runId: context.runId, sessionId: context.sessionId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("suishengo-agent")
        .setAudience(options.audience)
        .setSubject(context.actor.userId)
        .setIssuedAt()
        .setExpirationTime("60s")
        .sign(new TextEncoder().encode(options.actorSecret));
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer " + options.serviceToken);
      headers.set("x-agent-actor", assertion);

      const signals = [context.signal, AbortSignal.timeout(30000)];
      if (init?.signal) signals.push(init.signal);

      return fetch(url, { ...init, headers, redirect: "error", signal: AbortSignal.any(signals) });
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  });
}

async function discoverTools(client: Client, options: McpOptions, context: ToolContext) {
  const catalog: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  const remaining = new Set(options.allowedTools);
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (++pages > 20) throw new Error("MCP tool catalog pagination limit exceeded");

    const result = await client.listTools({ cursor }, { signal: context.signal, timeout: 10000 });
    catalog.push(...result.tools.filter((tool) => remaining.delete(tool.name)));
    cursor = result.nextCursor;
  } while (cursor);

  // 配置即允许暴露的集合；目录缺失时失败，不能悄悄改变模型可用的能力。
  if (remaining.size) throw new Error("Configured MCP tools were not advertised");

  return catalog.map((tool): ToolDefinition => ({
    name: "mcp_" + tool.name,
    description: tool.description ?? tool.name,
    inputSchema: tool.inputSchema,
    effect: "read",
    timeoutMs: 30000,
    authorize: (invocation) => invocation.actor.userId === context.actor.userId,

    async execute(input, invocation) {
      const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
        signal: invocation.signal,
        timeout: 30000,
      });
      if (result.isError) throw new ServiceError("MCP_TOOL_FAILED", "远程工具执行失败");

      return JSON.parse(JSON.stringify(result.structuredContent ?? result.content)) as JsonValue;
    },
  }));
}

export const mcp = {
  name: "mcp",
  apply(ctx: Context, options: McpOptions) {
    const clients = new Set<Client>();

    ctx.effect(() => async () => {
      await Promise.allSettled([...clients].map((client) => client.close()));
    });

    ctx.provide("mcp", {
      async open(context) {
        // 每次运行独占客户端与远程会话，身份不存放在共享的可变 transport 上。
        const client = new Client({ name: "suishengo-agent", version: "0.1.0" });
        clients.add(client);

        const close = async () => {
          clients.delete(client);
          await client.close();
        };

        try {
          await client.connect(createTransport(options, context), {
            signal: context.signal,
            timeout: 10000,
          });
          const tools = await discoverTools(client, options, context);

          return { tools, close };
        } catch (error) {
          await close();
          throw error;
        }
      },
    } satisfies ToolSource);
  },
};
