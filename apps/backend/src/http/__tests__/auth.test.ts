import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { createAuthenticator, authOptionsSchema } from "@backend/http/auth";

const credentials = {
  AUTH_ISSUER: "test",
  AUTH_AUDIENCE: "suishengo-agent",
  AUTH_SECRET: "test-only-secret-at-least-thirty-two-characters",
};
test("identity accepts a signed token without expiry and rejects missing, mismatched or tampered credentials", async () => {
  const authenticate = createAuthenticator(
    authOptionsSchema.parse({
      issuer: credentials.AUTH_ISSUER,
      audience: credentials.AUTH_AUDIENCE,
      authSecret: credentials.AUTH_SECRET,
    }),
  );
  const sign = (audience: string) =>
    new SignJWT({})
      .setSubject("alice")
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(credentials.AUTH_ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .sign(new TextEncoder().encode(credentials.AUTH_SECRET));
  assert.deepEqual(await authenticate("Bearer " + (await sign(credentials.AUTH_AUDIENCE))), {
    userId: "alice",
  });
  await assert.rejects(authenticate(undefined));
  await assert.rejects(authenticate("Bearer " + (await sign("another-service"))));
  const valid = await sign(credentials.AUTH_AUDIENCE);
  const segments = valid.split(".");
  segments[1] = Buffer.from(JSON.stringify({ sub: "bob" })).toString("base64url");
  await assert.rejects(authenticate("Bearer " + segments.join(".")));
});
