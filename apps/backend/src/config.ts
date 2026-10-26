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
  globalLimit: z.coerce.number().int().min(1).max(1000),
  userLimit: z.coerce.number().int().min(1).max(100),
  timeoutMs: z.coerce.number().int().min(1000).max(600000),
  langfuse: z.object({ baseUrl: z.string().url(), publicKey: z.string().min(1), secretKey: z.string().min(1) }).optional(),
  prompt: z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).optional(),
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse({
    environment: env.NODE_ENV ?? "development", host: env.HOST ?? "127.0.0.1", port: env.PORT ?? 4400,
    databaseUrl: env.DATABASE_URL, issuer: env.AUTH_ISSUER, audience: env.AUTH_AUDIENCE,
    authSecret: optional(env.AUTH_SECRET), jwksUrl: optional(env.AUTH_JWKS_URL),
    modelBaseUrl: optional(env.MODEL_BASE_URL), modelId: optional(env.MODEL_ID),
    globalLimit: env.MAX_CONCURRENT_RUNS ?? 8, userLimit: env.MAX_USER_RUNS ?? 2,
    timeoutMs: env.RUN_TIMEOUT_MS ?? 120000,
    langfuse: [env.LANGFUSE_BASE_URL, env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY].some(Boolean)
      ? { baseUrl: env.LANGFUSE_BASE_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY } : undefined,
    prompt: env.LANGFUSE_PROMPT_NAME || env.LANGFUSE_PROMPT_VERSION
      ? { name: env.LANGFUSE_PROMPT_NAME, version: env.LANGFUSE_PROMPT_VERSION } : undefined,
  });
  if (Boolean(config.authSecret) === Boolean(config.jwksUrl)) throw new Error("Configure exactly one authentication source");
  if (config.environment === "production" && (config.authSecret || !config.jwksUrl?.startsWith("https://"))) {
    throw new Error("Production requires HTTPS JWKS authentication");
  }
  const modelFields = [config.modelBaseUrl, config.modelId, optional(env.MODEL_API_KEY)];
  if (modelFields.some(Boolean) && !modelFields.every(Boolean)) throw new Error("Model configuration is incomplete");
  if (config.environment === "production" && !modelFields.every(Boolean)) throw new Error("Production requires a model configuration");
  if (config.prompt && !config.langfuse) throw new Error("Remote prompt requires Langfuse");
  return config;
}
