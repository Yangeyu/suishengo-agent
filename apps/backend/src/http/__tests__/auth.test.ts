import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { createAuthenticator } from "@backend/http/auth";
import { loadConfig } from "@backend/config";

const env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/unused",
  AUTH_ISSUER: "test",
  AUTH_AUDIENCE: "suishengo-agent",
  AUTH_SECRET: "test-only-secret-at-least-thirty-two-characters",
};
test("identity requires a signed, unexpired token for this audience", async () => {
  const authenticate = createAuthenticator(loadConfig(env));
  const sign = (audience: string, expiry: string) =>
    new SignJWT({})
      .setSubject("alice")
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(env.AUTH_ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(new TextEncoder().encode(env.AUTH_SECRET));
  assert.deepEqual(await authenticate("Bearer " + (await sign(env.AUTH_AUDIENCE, "1h"))), {
    userId: "alice",
  });
  await assert.rejects(authenticate(undefined));
  await assert.rejects(authenticate("Bearer " + (await sign("another-service", "1h"))));
  await assert.rejects(authenticate("Bearer " + (await sign(env.AUTH_AUDIENCE, "-1h"))));
  const valid = await sign(env.AUTH_AUDIENCE, "1h");
  const segments = valid.split(".");
  segments[1] = Buffer.from(JSON.stringify({ sub: "bob" })).toString("base64url");
  await assert.rejects(authenticate("Bearer " + segments.join(".")));
});
test("production requires external identity and a complete model connection", () => {
  assert.throws(() => loadConfig({ ...env, NODE_ENV: "production" }));
  assert.throws(() => loadConfig({ ...env, MODEL_ID: "incomplete" }));
});
