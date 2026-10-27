import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfig } from "@backend/config";

const env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/config_test",
  AUTH_SECRET: "test-only-secret-at-least-thirty-two-characters",
};
const model = {
  provider: "dashscope",
  modelId: "deepseek-v4.1-flash",
  maxOutputTokens: 256,
};
const modelEnv = { DASHSCOPE_BASE_URL: "http://localhost:9000/v1", DASHSCOPE_API_KEY: "fixture" };
const langfuseEnv = {
  LANGFUSE_BASE_URL: "http://localhost:9001",
  LANGFUSE_PUBLIC_KEY: "fixture-public",
  LANGFUSE_SECRET_KEY: "fixture-secret",
};

test("custom files select capabilities and reject unknown fields", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "suishengo-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "backend.yaml");
  writeFileSync(path, "model: false\ntools:\n  mcp: false\nruntime:\n  limits:\n    maxSteps: 3\n");
  const config = loadConfig({ ...env, ...modelEnv, MCP_URL: "http://unused", CONFIG_FILE: path });
  assert.equal(config.model, false);
  assert.equal(config.tools.mcp, false);
  assert.equal(config.runtime.limits.maxSteps, 3);

  writeFileSync(path, "runtime:\n  timoutMs: 5000\n");
  assert.throws(() => loadConfig({ ...env, CONFIG_FILE: path }), /timoutMs/);
  assert.throws(
    () => resolveConfig({ model: { ...model, unexpected: true } }, { ...env, ...modelEnv }),
    /unexpected/,
  );
});

test("enabled integrations require complete credentials and dependencies", () => {
  assert.equal(resolveConfig({}, env).langfuse, undefined);
  assert.throws(() => resolveConfig({ model }, env), /apiKey/);
  assert.throws(
    () => resolveConfig({ tools: { mcp: { allowedTools: ["lookup"] } } }, env),
    /serviceToken/,
  );
  assert.throws(
    () =>
      resolveConfig(
        { prompts: { bindings: { "agent.system": { name: "agent", version: 1 } } } },
        env,
      ),
    /Langfuse/,
  );
  assert.throws(
    () => resolveConfig({}, { ...env, LANGFUSE_BASE_URL: "https://example.com" }),
    /publicKey/,
  );
});

test("telemetry shutdown has a bounded deployment override", () => {
  const enabled = { ...env, ...langfuseEnv, TELEMETRY_ENABLED: "true" };
  const defaults = resolveConfig({}, enabled).telemetry;
  assert.ok(defaults);
  assert.equal(defaults.shutdownTimeoutMs, 10000);
  const overridden = resolveConfig(
    {},
    { ...enabled, LANGFUSE_SHUTDOWN_TIMEOUT_MS: "2000" },
  ).telemetry;
  assert.ok(overridden);
  assert.equal(overridden.shutdownTimeoutMs, 2000);
  for (const value of ["0", "25001", "invalid"]) {
    assert.throws(
      () => resolveConfig({}, { ...enabled, LANGFUSE_SHUTDOWN_TIMEOUT_MS: value }),
      /shutdownTimeoutMs/,
    );
  }
});

test("telemetry is opt-in independently of Langfuse prompt connections", () => {
  assert.equal(resolveConfig({}, env).telemetry, false);
  const promptsOnly = resolveConfig(
    { prompts: { bindings: { "agent.system": { name: "agent", version: 1 } } } },
    { ...env, ...langfuseEnv, TELEMETRY_ENABLED: "false" },
  );
  assert.equal(promptsOnly.telemetry, false);
  assert.ok(promptsOnly.langfuse);
  assert.throws(() => resolveConfig({}, { ...env, TELEMETRY_ENABLED: "true" }), /connection/);
  assert.throws(
    () => resolveConfig({}, { ...env, TELEMETRY_ENABLED: "invalid" }),
    /Invalid option/,
  );
  const enabled = resolveConfig({}, { ...env, ...langfuseEnv, TELEMETRY_ENABLED: "true" });
  assert.ok(enabled.telemetry);
  assert.equal(enabled.telemetry.captureContent, true);
});

test("Bailian supplies its endpoint and model capabilities; deployments can override the endpoint", () => {
  const config = resolveConfig({ model }, { ...env, DASHSCOPE_API_KEY: "fixture" });
  assert.ok(config.model);
  assert.equal(config.model.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(config.model.contextWindow, 131072);
  assert.equal(config.model.maxOutputTokens, 256);
  const overridden = resolveConfig({ model }, { ...env, ...modelEnv });
  assert.ok(overridden.model);
  assert.equal(overridden.model.baseUrl, modelEnv.DASHSCOPE_BASE_URL);
});

test("model selection, connection and budgets must satisfy the provider contract", () => {
  const keyEnv = { ...env, ...modelEnv };
  for (const [selection, error] of [
    [{ ...model, provider: "unknown" }, /provider/],
    [{ ...model, modelId: "unknown" }, /Unknown DashScope model/],
    [{ ...model, maxOutputTokens: 4097 }, /output limit/],
  ] as const) {
    assert.throws(() => resolveConfig({ model: selection }, keyEnv), error);
  }
  assert.throws(() => resolveConfig({ model }, { ...keyEnv, DASHSCOPE_API_KEY: " " }), /apiKey/);
  for (const baseUrl of ["invalid", "ftp://localhost/models"]) {
    assert.throws(
      () => resolveConfig({ model }, { ...keyEnv, DASHSCOPE_BASE_URL: baseUrl }),
      /baseUrl/,
    );
  }
  assert.throws(
    () => resolveConfig({ model, context: { compaction: { maxSummaryTokens: 131072 } } }, keyEnv),
    /Summary limit/,
  );
});

test("production requires external identity and a model; remote tool connections must use HTTPS", () => {
  const production = {
    ...env,
    ...modelEnv,
    NODE_ENV: "production",
    AUTH_SECRET: undefined,
    AUTH_JWKS_URL: "https://identity.example.com/jwks",
  };
  assert.throws(
    () => resolveConfig({ model }, { ...production, AUTH_SECRET: env.AUTH_SECRET }),
    /authentication source/,
  );
  assert.throws(
    () =>
      resolveConfig(
        { model },
        { ...production, AUTH_JWKS_URL: "http://identity.example.com/jwks" },
      ),
    /HTTPS JWKS/,
  );
  assert.throws(() => resolveConfig({}, production), /model configuration/);
  assert.throws(
    () =>
      resolveConfig(
        { model, tools: { mcp: { allowedTools: ["lookup"] } } },
        {
          ...production,
          MCP_URL: "http://tools.example.com",
          MCP_SERVICE_TOKEN: "fixture",
          MCP_ACTOR_SECRET: env.AUTH_SECRET,
          MCP_AUDIENCE: "fixture",
        },
      ),
    /Production MCP requires HTTPS/,
  );
  assert.equal(resolveConfig({ model }, { ...production, ...langfuseEnv }).telemetry, false);
  const telemetry = resolveConfig(
    { model },
    {
      ...production,
      ...langfuseEnv,
      TELEMETRY_ENABLED: "true",
    },
  ).telemetry;
  assert.ok(telemetry);
  assert.equal(telemetry.captureContent, false);
});
