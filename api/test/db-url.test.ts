import { describe, expect, it } from "vitest";
import { datasourceUrl } from "../src/db.js";

describe("datasourceUrl", () => {
  it("adds pgbouncer=true to a pooled (Neon -pooler) address and keeps the other parts", () => {
    const out = new URL(datasourceUrl("postgresql://u:p%40ss@ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require")!);
    expect(out.searchParams.get("pgbouncer")).toBe("true");
    expect(out.searchParams.get("sslmode")).toBe("require");
    expect(out.searchParams.get("channel_binding")).toBe("require");
    expect(out.hostname).toBe("ep-cool-123-pooler.ap-southeast-1.aws.neon.tech");
    expect(out.username).toBe("u");
    expect(decodeURIComponent(out.password)).toBe("p@ss"); // the password survives intact
    expect(out.pathname).toBe("/neondb");
  });

  it("does not change it when pgbouncer is already given, even as false", () => {
    for (const v of ["true", "false"]) {
      const raw = `postgresql://u:p@ep-x-pooler.neon.tech/db?pgbouncer=${v}`;
      expect(datasourceUrl(raw)).toBe(raw);
    }
  });

  it("leaves a direct Neon address, a local one and a docker one exactly as they are", () => {
    for (const raw of [
      "postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db?sslmode=require",
      "postgresql://loan:secret@localhost:5433/loan_management?schema=public",
      "postgresql://u:p@db:5432/loan",
    ]) {
      expect(datasourceUrl(raw)).toBe(raw);
    }
  });

  it("returns what it was given when it is not a URL, and undefined when there is nothing", () => {
    expect(datasourceUrl("not a url")).toBe("not a url");
    expect(datasourceUrl(undefined)).toBeUndefined();
    expect(datasourceUrl("")).toBeUndefined();
  });
});
