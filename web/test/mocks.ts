import { vi } from "vitest";
import type { ZodType } from "zod";

// One router double for every page: tests read `routerMock.replace` to see where a page sent the user.
export const routerMock = { replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
export const pathnameMock = { value: "/" };

export interface Call {
  method: string;
  path: string; // without the /api prefix, with the query string
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Error;
type Handler = Reply | ((call: Call) => Reply);

/**
 * Replaces fetch with a fake API. `routes` maps "METHOD /path" (query string ignored) to a reply.
 * A request nobody planned for fails the test, so no page can call an endpoint unnoticed.
 * Returns the list of calls made, in order.
 */
export function mockApi(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/")) throw new Error(`unexpected non-API request: ${url}`);
      const path = url.slice("/api".length);
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const body =
        raw === undefined || raw === null
          ? undefined
          : typeof raw === "string"
            ? JSON.parse(raw)
            : raw instanceof Blob
              ? { file: { type: raw.type, size: raw.size } } // a slip upload: what matters is type and size
              : undefined;
      const call: Call = { method, path, body };
      calls.push(call);
      const handler = routes[`${method} ${path.split("?")[0]}`];
      if (handler === undefined) throw new Error(`unplanned API call: ${method} ${path}`);
      const reply = typeof handler === "function" ? handler(call) : handler;
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

export const apiError = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message } },
});

// the fake API answers must themselves satisfy the contract schemas (so tests cannot drift from it)
export function valid<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

export const admin = { id: "u1", username: "boss", role: "ADMIN", mustChangePassword: false, borrowerId: null, pdpaAccepted: null } as const;
export const borrowerUser = { id: "u2", username: "somchai", role: "BORROWER", mustChangePassword: false, borrowerId: "b1", pdpaAccepted: true } as const;
