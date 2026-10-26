import { createServer, type Server } from "node:http";
import { jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const actorSecret = "integration-mcp-assertion-secret-thirty-two";
export const serviceToken = "integration-service-token";
export type ModelRequest = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string } }[];
};

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function createFixtures() {
  const requests: ModelRequest[] = [];
  const calls: { userId: string; runId: string; query: string }[] = [];
  const active = new Set<McpServer>();
  let toolCalls = 0;

  const mcpHttp = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== "Bearer " + serviceToken)
        throw new Error("Missing service credential");
      const { payload } = await jwtVerify(
        String(request.headers["x-agent-actor"]),
        new TextEncoder().encode(actorSecret),
        {
          issuer: "suishengo-agent",
          audience: "fixture-mcp",
          algorithms: ["HS256"],
        },
      );
      if (!payload.sub || !payload.runId || !payload.sessionId)
        throw new Error("Missing actor context");
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }

      const server = new McpServer({ name: "business-fixture", version: "1.0.0" });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      server.registerTool("lookup", { inputSchema: { query: z.string() } }, async ({ query }) => {
        calls.push({ userId: payload.sub!, runId: String(payload.runId), query });
        const result = { owner: payload.sub, query };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      });
      server.registerTool("not_allowed", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "never expose" }],
      }));
      active.add(server);
      response.once("close", () => {
        active.delete(server);
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(401).end();
      else response.end();
    }
  });

  const modelHttp = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as ModelRequest;
    requests.push(input);
    const last = input.messages.at(-1)!;

    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          "\n\n",
      );

    if (last.role === "tool") {
      const result = JSON.parse(last.content) as { owner: string };
      send({ role: "assistant", content: "查询完成：" + result.owner });
      send({}, "stop");
    } else {
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture_" + ++toolCalls,
            type: "function",
            function: { name: "mcp_lookup", arguments: JSON.stringify({ query: last.content }) },
          },
        ],
      });
      send({}, "tool_calls");
    }

    response.end("data: [DONE]\n\n");
  });

  const mcpUrl = await listen(mcpHttp);
  const modelUrl = await listen(modelHttp);

  return {
    mcpUrl,
    modelUrl,
    requests,
    calls,
    async close() {
      await Promise.allSettled([...active].map((server) => server.close()));
      await Promise.all([close(mcpHttp), close(modelHttp)]);
    },
  };
}
