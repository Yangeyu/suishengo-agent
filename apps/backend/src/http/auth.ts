import { ServiceError, type Actor } from "@harness";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Config } from "@backend/config";

export function createAuthenticator(
  config: Pick<Config, "authSecret" | "jwksUrl" | "issuer" | "audience">,
) {
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
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (!payload.sub || payload.sub.length > 200) throw new Error("Invalid subject");
      return Object.freeze({ userId: payload.sub });
    } catch {
      throw new ServiceError("UNAUTHORIZED", "访问令牌无效或已过期");
    }
  };
}
