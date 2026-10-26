import { ServiceError, type Actor } from "@harness";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { z } from "zod";

export const authOptionsSchema = z
  .strictObject({
    issuer: z.string().min(1).default("suishengo-local"),
    audience: z.string().min(1).default("suishengo-agent"),
    authSecret: z.string().min(32).optional(),
    jwksUrl: z.url().optional(),
  })
  .refine((config) => Boolean(config.authSecret) !== Boolean(config.jwksUrl), {
    message: "Configure exactly one authentication source",
  });

export function createAuthenticator(config: z.infer<typeof authOptionsSchema>) {
  const key = config.jwksUrl
    ? createRemoteJWKSet(new URL(config.jwksUrl))
    : new TextEncoder().encode(config.authSecret);
  return async (authorization?: string): Promise<Actor> => {
    if (!authorization?.startsWith("Bearer "))
      throw new ServiceError("UNAUTHORIZED", "需要有效的访问令牌");
    try {
      const { payload } = await jwtVerify(authorization.slice(7), key, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: config.jwksUrl ? ["RS256", "ES256"] : ["HS256"],
        requiredClaims: ["sub", "iat"],
      });
      if (!payload.sub || payload.sub.length > 200) throw new Error("Invalid subject");
      return Object.freeze({ userId: payload.sub });
    } catch {
      throw new ServiceError("UNAUTHORIZED", "访问令牌无效");
    }
  };
}
