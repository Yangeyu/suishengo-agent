import { z } from "zod";

const optional = (value?: string) => value?.trim() || undefined;
const schema = z.object({
  environment: z.enum(["development", "test", "production"]),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  databaseUrl: z.string().url(),
  issuer: z.string().min(1),
  audience: z.string().min(1),
  authSecret: z.string().min(32).optional(),
  jwksUrl: z.string().url().optional(),
  modelBaseUrl: z.string().url().optional(),
  modelId: z.string().min(1).optional(),
  modelContextWindow: z.coerce.number().int().min(1024).max(10000000),
  modelOutputTokens: z.coerce.number().int().positive(),
  compaction: z
    .object({
      version: z.string().min(1),
      triggerFraction: z.coerce.number().gt(0).lt(1),
      keepRecentTurns: z.coerce.number().int().min(1),
      maxSummaryTokens: z.coerce.number().int().positive(),
    })
    .optional(),
  globalLimit: z.coerce.number().int().min(1).max(1000),
  userLimit: z.coerce.number().int().min(1).max(100),
  timeoutMs: z.coerce.number().int().min(1000).max(600000),
  limits: z.object({
    maxSteps: z.coerce.number().int().min(1).max(50),
    maxToolCalls: z.coerce.number().int().min(1).max(100),
    maxTokens: z.coerce.number().int().min(1).max(1000000),
  }),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]),
  mcp: z
    .object({
      url: z.string().url(),
      allowedTools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/)).min(1),
      serviceToken: z.string().min(1),
      actorSecret: z.string().min(32),
      audience: z.string().min(1),
    })
    .optional(),
  langfuse: z
    .object({
      baseUrl: z.string().url(),
      publicKey: z.string().min(1),
      secretKey: z.string().min(1),
    })
    .optional(),
  prompt: z
    .object({ name: z.string().min(1), version: z.coerce.number().int().positive() })
    .optional(),
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const compactionEnabled =
    z.enum(["true", "false"]).parse(env.CONTEXT_COMPACTION ?? "true") === "true";
  const config = schema.parse({
    environment: env.NODE_ENV ?? "development",
    host: env.HOST ?? "127.0.0.1",
    port: env.PORT ?? 4400,
    databaseUrl: env.DATABASE_URL,
    issuer: env.AUTH_ISSUER,
    audience: env.AUTH_AUDIENCE,
    authSecret: optional(env.AUTH_SECRET),
    jwksUrl: optional(env.AUTH_JWKS_URL),
    modelBaseUrl: optional(env.MODEL_BASE_URL),
    modelId: optional(env.MODEL_ID),
    modelContextWindow: env.MODEL_CONTEXT_WINDOW ?? 128000,
    modelOutputTokens: env.MODEL_OUTPUT_TOKENS ?? 2048,
    compaction: !compactionEnabled
      ? undefined
      : {
          version: "summary-v1",
          triggerFraction: env.CONTEXT_TRIGGER_FRACTION ?? 0.7,
          keepRecentTurns: env.CONTEXT_KEEP_RECENT_TURNS ?? 2,
          maxSummaryTokens: env.CONTEXT_SUMMARY_TOKENS ?? 1024,
        },
    globalLimit: env.MAX_CONCURRENT_RUNS ?? 8,
    userLimit: env.MAX_USER_RUNS ?? 2,
    timeoutMs: env.RUN_TIMEOUT_MS ?? 120000,
    limits: {
      maxSteps: env.AGENT_MAX_STEPS ?? 8,
      maxToolCalls: env.AGENT_MAX_TOOL_CALLS ?? 12,
      maxTokens: env.AGENT_MAX_TOKENS ?? 32000,
    },
    logLevel: env.LOG_LEVEL ?? "info",
    mcp: [
      env.MCP_URL,
      env.MCP_ALLOWED_TOOLS,
      env.MCP_SERVICE_TOKEN,
      env.MCP_ACTOR_SECRET,
      env.MCP_AUDIENCE,
    ].some(Boolean)
      ? {
          url: env.MCP_URL,
          allowedTools: env.MCP_ALLOWED_TOOLS?.split(",")
            .map((name) => name.trim())
            .filter(Boolean),
          serviceToken: env.MCP_SERVICE_TOKEN,
          actorSecret: env.MCP_ACTOR_SECRET,
          audience: env.MCP_AUDIENCE,
        }
      : undefined,
    langfuse: [env.LANGFUSE_BASE_URL, env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY].some(
      Boolean,
    )
      ? {
          baseUrl: env.LANGFUSE_BASE_URL,
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
        }
      : undefined,
    prompt:
      env.LANGFUSE_PROMPT_NAME || env.LANGFUSE_PROMPT_VERSION
        ? { name: env.LANGFUSE_PROMPT_NAME, version: env.LANGFUSE_PROMPT_VERSION }
        : undefined,
  });
  if (
    config.modelOutputTokens >= config.modelContextWindow ||
    (config.compaction && config.compaction.maxSummaryTokens >= config.modelContextWindow)
  )
    throw new Error("Model output and summary limits must be smaller than the context window");
  if (Boolean(config.authSecret) === Boolean(config.jwksUrl))
    throw new Error("Configure exactly one authentication source");
  if (
    config.environment === "production" &&
    (config.authSecret || !config.jwksUrl?.startsWith("https://"))
  ) {
    throw new Error("Production requires HTTPS JWKS authentication");
  }
  const modelFields = [config.modelBaseUrl, config.modelId, optional(env.MODEL_API_KEY)];
  if (modelFields.some(Boolean) && !modelFields.every(Boolean))
    throw new Error("Model configuration is incomplete");
  if (config.environment === "production" && !modelFields.every(Boolean))
    throw new Error("Production requires a model configuration");
  if (config.prompt && !config.langfuse) throw new Error("Remote prompt requires Langfuse");
  if (config.environment === "production" && config.mcp && !config.mcp.url.startsWith("https://"))
    throw new Error("Production MCP requires HTTPS");
  return config;
}
