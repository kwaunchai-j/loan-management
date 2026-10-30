import { PrismaClient } from "@prisma/client";

export type Db = PrismaClient;

/**
 * The database URL the client should use. A Neon "-pooler" address goes through PgBouncer in transaction mode,
 * which needs `pgbouncer=true` (Prisma then avoids named prepared statements); it is added when missing, so the
 * pooled URL a hosting integration provides works as it is. Anything else (a local or direct URL) is unchanged.
 * Returns undefined when there is no URL (Prisma then reads DATABASE_URL itself and reports the problem).
 */
export function datasourceUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.hostname.includes("-pooler") && !url.searchParams.has("pgbouncer")) {
      url.searchParams.set("pgbouncer", "true");
      return url.toString();
    }
  } catch {
    /* not a URL we can read: leave it for Prisma to report */
  }
  return raw;
}

export function createPrisma(): Db {
  return new PrismaClient({ datasourceUrl: datasourceUrl(process.env.DATABASE_URL) });
}
