import { SignJWT } from "jose";
if (process.env.NODE_ENV === "production")
  throw new Error("Development tokens are disabled in production");
const secret = process.env.AUTH_SECRET;
if (!secret || secret.length < 32) throw new Error("Set the local AUTH_SECRET first");
const userId = process.argv[2] ?? "developer-a";
const token = await new SignJWT({})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(userId)
  .setIssuer(process.env.AUTH_ISSUER ?? "suishengo-local")
  .setAudience(process.env.AUTH_AUDIENCE ?? "suishengo-agent")
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(new TextEncoder().encode(secret));
console.log(token);
