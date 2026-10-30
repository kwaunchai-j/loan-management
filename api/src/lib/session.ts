import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

/**
 * Stateless session token (the Data Model has no session table, and it is a contract).
 * Claims: sub = user id, pv = fingerprint of the current password hash. The fingerprint makes
 * every token die when the password changes or is reset. Role and isActive are NOT trusted
 * from the token — the middleware reloads the user on every request.
 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const ALG = "HS256";

export interface SessionClaims {
  userId: string;
  passwordVersion: string;
}

export function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 22);
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(
  claims: SessionClaims,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ pv: claims.passwordVersion })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(key(secret));
}

/** Returns the claims, or null for any invalid, tampered, wrong-algorithm or expired token. */
export async function verifySession(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: [ALG],
      currentDate: now,
    });
    if (typeof payload.sub !== "string" || typeof payload.pv !== "string") return null;
    return { userId: payload.sub, passwordVersion: payload.pv };
  } catch {
    return null;
  }
}
