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
  provider: "fixture",
  modelId: "fixture",
  contextWindow: 4096,
  maxOutputTokens: 256,
};
const modelEnv = { DASHSCOPE_BASE_URL: "http://localhost:9000/v1", DASHSCOPE_API_KEY: "fixture" };

test("configuration file controls capabilities and rejects invalid or incomplete enabled integrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "suishengo-config-"));
  const path = join(directory, "backend.yaml");
  try {
    writeFileSync(
      path,
      "model: false\ntools:\n  mcp: false\nruntime:\n  limits:\n    maxSteps: 3\n",
    );
    const config = loadConfig({ ...env, ...modelEnv, MCP_URL: "http://unused", CONFIG_FILE: path });
    assert.equal(config.model, false);
    assert.equal(config.tools.mcp, false);
    assert.equal(config.runtime.limits.maxSteps, 3);
    assert.equal(config.telemetry.connection, undefined);

    writeFileSync(path, "runtime:\n  timoutMs: 5000\n");
    assert.throws(() => loadConfig({ ...env, CONFIG_FILE: path }), /timoutMs/);
    assert.throws(() => resolveConfig({ model }, env), /apiKey/);
    assert.throws(
      () => resolveConfig({ tools: { mcp: { allowedTools: ["lookup"] } } }, env),
      /serviceToken/,
    );
    assert.throws(
      () => resolveConfig({ prompts: { remote: { name: "agent", version: 1 } } }, env),
      /Langfuse/,
    );
    assert.throws(
      () => resolveConfig({}, { ...env, LANGFUSE_BASE_URL: "https://example.com" }),
      /publicKey/,
    );
    assert.throws(
      () => resolveConfig({ model: { ...model, maxOutputTokens: 4096 } }, { ...env, ...modelEnv }),
      /output limit/,
    );
    assert.throws(
      () =>
        resolveConfig(
          { model, context: { compaction: { maxSummaryTokens: 4096 } } },
          { ...env, ...modelEnv },
        ),
      /Summary limit/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.equal(resolveConfig({ model }, production).telemetry.captureContent, false);
});
