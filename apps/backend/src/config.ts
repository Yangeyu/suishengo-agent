import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { authOptionsSchema } from "@backend/http/auth";
import { runtimeOptionsSchema } from "@runtime/config";
import { contextOptionsSchema, validateContextOptions } from "@plugins/context/src/config";
import { mcpOptionsSchema } from "@plugins/mcp/src/index";
import { piModelOptionsSchema, piModelSelectionSchema } from "@plugins/pi/src/model/config";
import { promptsOptionsSchema } from "@plugins/prompts/src/config";
import { postgresOptionsSchema } from "@plugins/sessions-pg/src/index";
import { telemetryOptionsSchema } from "@plugins/telemetry/src/index";

const optional = (value?: string) => value?.trim() || undefined;
const langfuseConnectionSchema = z.strictObject({
  baseUrl: z.url(),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});
const fileSchema = z.strictObject({
  model: z.union([z.literal(false), piModelSelectionSchema]).default(false),
  context: contextOptionsSchema.prefault({}),
  runtime: runtimeOptionsSchema
    .extend({
      concurrency: postgresOptionsSchema.shape.limits,
    })
    .prefault({}),
  tools: z
    .strictObject({
      mcp: z
        .union([z.literal(false), mcpOptionsSchema.pick({ allowedTools: true })])
        .default(false),
    })
    .prefault({}),
  prompts: promptsOptionsSchema.prefault({}),
});

export type Config = ReturnType<typeof resolveConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = optional(env.CONFIG_FILE) ?? new URL("../config.yaml", import.meta.url);
  return resolveConfig(parse(readFileSync(path, "utf8")), env);
}

export function resolveConfig(input: unknown, env: NodeJS.ProcessEnv) {
  const file = fileSchema.parse(input);
  const environment = z
    .enum(["development", "test", "production"])
    .parse(env.NODE_ENV ?? "development");
  const http = z
    .strictObject({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.coerce.number().int().min(1).max(65535).default(4400),
    })
    .parse({ host: optional(env.HOST), port: optional(env.PORT) });
  const logging = {
    level: z.enum(["debug", "info", "warn", "error", "silent"]).parse(env.LOG_LEVEL ?? "info"),
  };
  const auth = authOptionsSchema.parse({
    issuer: optional(env.AUTH_ISSUER),
    audience: optional(env.AUTH_AUDIENCE),
    authSecret: optional(env.AUTH_SECRET),
    jwksUrl: optional(env.AUTH_JWKS_URL),
  });
  const storage = postgresOptionsSchema.parse({
    url: optional(env.DATABASE_URL),
    limits: file.runtime.concurrency,
  });
  const model =
    file.model &&
    piModelOptionsSchema.parse({
      ...file.model,
      baseUrl: optional(env.DASHSCOPE_BASE_URL),
      apiKey: optional(env.DASHSCOPE_API_KEY),
    });
  const mcp =
    file.tools.mcp &&
    mcpOptionsSchema.parse({
      ...file.tools.mcp,
      url: optional(env.MCP_URL),
      serviceToken: optional(env.MCP_SERVICE_TOKEN),
      actorSecret: optional(env.MCP_ACTOR_SECRET),
      audience: optional(env.MCP_AUDIENCE),
    });
  const langfuse = [env.LANGFUSE_BASE_URL, env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY].some(
    optional,
  )
    ? langfuseConnectionSchema.parse({
        baseUrl: optional(env.LANGFUSE_BASE_URL),
        publicKey: optional(env.LANGFUSE_PUBLIC_KEY),
        secretKey: optional(env.LANGFUSE_SECRET_KEY),
      })
    : undefined;
  const telemetryEnabled =
    z.enum(["true", "false"]).parse(env.TELEMETRY_ENABLED ?? "false") === "true";
  const telemetry =
    telemetryEnabled &&
    telemetryOptionsSchema.extend({ connection: langfuseConnectionSchema }).parse({
      connection: langfuse,
      environment,
      release: optional(env.APP_RELEASE),
      shutdownTimeoutMs: env.LANGFUSE_SHUTDOWN_TIMEOUT_MS
        ? Number(env.LANGFUSE_SHUTDOWN_TIMEOUT_MS)
        : undefined,
      captureContent:
        z
          .enum(["true", "false"])
          .parse(
            env.LANGFUSE_CAPTURE_CONTENT ?? (environment === "production" ? "false" : "true"),
          ) === "true",
    });

  if (environment === "production" && (auth.authSecret || !auth.jwksUrl?.startsWith("https://")))
    throw new Error("Production requires HTTPS JWKS authentication");
  if (environment === "production" && !model)
    throw new Error("Production requires a model configuration");
  if (Object.keys(file.prompts.bindings).length && !langfuse)
    throw new Error("Remote prompt requires Langfuse");
  if (environment === "production" && mcp && !mcp.url.startsWith("https://"))
    throw new Error("Production MCP requires HTTPS");
  if (model) validateContextOptions(file.context, model.contextWindow);

  return {
    environment,
    http,
    logging,
    auth,
    storage,
    model,
    telemetry,
    langfuse,
    context: file.context,
    prompts: file.prompts,
    tools: { mcp },
    runtime: { timeoutMs: file.runtime.timeoutMs, limits: file.runtime.limits },
  };
}
