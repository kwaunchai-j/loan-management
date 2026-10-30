import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  hashPassword,
  passwordPolicyViolation,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "../src/lib/password.js";
import {
  passwordVersion,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
} from "../src/lib/session.js";
import { clearedSessionCookie, parseCookies, sessionCookie } from "../src/lib/cookie.js";
import { FailureLimiter } from "../src/lib/rate-limit.js";

const SECRET = "x".repeat(40);

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash and never stores the plain password", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
    expect(a).not.toContain("same-password-1");
    expect(a.startsWith("scrypt$")).toBe(true);
  });

  it("treats malformed stored hashes as a mismatch instead of throwing", async () => {
    for (const bad of ["", "plain", "scrypt$1$2$3", "bcrypt$1$2$3$a$b", "scrypt$x$8$1$AAAA$AAAA", "scrypt$16384$8$1$AAAA$"]) {
      expect(await verifyPassword("whatever-123", bad)).toBe(false);
    }
  });

  it("normalises Unicode so equivalent Thai/Latin input matches", async () => {
    const hash = await hashPassword("café-password");
    expect(await verifyPassword("café-password", hash)).toBe(true);
  });

  it("enforces the length policy", () => {
    expect(passwordPolicyViolation("a".repeat(PASSWORD_MIN_LENGTH - 1))).not.toBeNull();
    expect(passwordPolicyViolation("a".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordPolicyViolation("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(passwordPolicyViolation("a".repeat(PASSWORD_MAX_LENGTH + 1))).not.toBeNull();
  });
});

describe("session tokens", () => {
  const claims = { userId: "u1", passwordVersion: passwordVersion("hash-1") };

  it("round-trips the claims", async () => {
    const token = await signSession(claims, SECRET);
    expect(await verifySession(token, SECRET)).toEqual(claims);
  });

  it("rejects a token signed with another secret or tampered with", async () => {
    const token = await signSession(claims, SECRET);
    expect(await verifySession(token, "y".repeat(40))).toBeNull();
    const [h, p, s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "admin", pv: claims.passwordVersion })).toString("base64url")}.${s}`;
    expect(await verifySession(forged, SECRET)).toBeNull();
    expect(await verifySession(`${h}.${p}`, SECRET)).toBeNull();
    expect(await verifySession("not-a-token", SECRET)).toBeNull();
  });

  it("rejects alg=none and other algorithms", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "u1", pv: "x", exp: 9999999999 }),
    ).toString("base64url")}.`;
    expect(await verifySession(none, SECRET)).toBeNull();
    const hs512 = await new SignJWT({ pv: "x" })
      .setProtectedHeader({ alg: "HS512" })
      .setSubject("u1")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySession(hs512, SECRET)).toBeNull();
  });

  it("expires after the session lifetime", async () => {
    const issued = new Date("2026-10-29T00:00:00Z");
    const token = await signSession(claims, SECRET, issued);
    const justBefore = new Date(issued.getTime() + (SESSION_TTL_SECONDS - 1) * 1000);
    const justAfter = new Date(issued.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);
    expect(await verifySession(token, SECRET, justBefore)).toEqual(claims);
    expect(await verifySession(token, SECRET, justAfter)).toBeNull();
  });

  it("fingerprint changes when the password hash changes", () => {
    expect(passwordVersion("hash-1")).toBe(passwordVersion("hash-1"));
    expect(passwordVersion("hash-1")).not.toBe(passwordVersion("hash-2"));
  });
});

describe("cookies", () => {
  it("parses a cookie header and ignores junk", () => {
    expect(parseCookies("a=1; loan_session=abc%2Edef; broken; =x")).toEqual({
      a: "1",
      loan_session: "abc.def",
    });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("a=%E0%A4%A")).toEqual({});
  });

  it("keeps the first value when a name repeats", () => {
    expect(parseCookies("loan_session=first; loan_session=second")).toEqual({ loan_session: "first" });
  });

  it("builds an HttpOnly, SameSite=Lax cookie, Secure only when asked", () => {
    const c = sessionCookie("tok", 60, false);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Secure");
    expect(sessionCookie("tok", 60, true)).toContain("Secure");
    expect(clearedSessionCookie(false)).toContain("Max-Age=0");
  });
});

describe("FailureLimiter", () => {
  it("blocks after the maximum failures and frees after the window", () => {
    let t = 1_000_000;
    const l = new FailureLimiter({ maxFailures: 3, windowMs: 60_000, now: () => t });
    expect(l.retryAfterSeconds("k")).toBe(0);
    l.recordFailure("k");
    l.recordFailure("k");
    expect(l.retryAfterSeconds("k")).toBe(0);
    l.recordFailure("k");
    expect(l.retryAfterSeconds("k")).toBe(60);
    t += 30_000;
    expect(l.retryAfterSeconds("k")).toBe(30);
    t += 30_001;
    expect(l.retryAfterSeconds("k")).toBe(0);
  });

  it("keeps keys independent and reset clears a key", () => {
    const l = new FailureLimiter({ maxFailures: 1, windowMs: 60_000, now: () => 1 });
    l.recordFailure("a");
    expect(l.retryAfterSeconds("a")).toBeGreaterThan(0);
    expect(l.retryAfterSeconds("b")).toBe(0);
    l.reset("a");
    expect(l.retryAfterSeconds("a")).toBe(0);
  });
});
