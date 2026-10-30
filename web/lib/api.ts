import type { ZodType } from "zod";

/**
 * The only way the web app talks to the API. Calls go to /api/... on this same origin (forwarded to
 * the API by next.config.mjs); the session is an httpOnly cookie the browser sends by itself, so no
 * token is ever visible to the page's JavaScript.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** The session store registers itself here so a 401 anywhere sends the user back to the login page. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export const NETWORK_MESSAGE = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่";
const GENERIC_MESSAGE = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
const BAD_RESPONSE_MESSAGE = "ข้อมูลที่ได้จากเซิร์ฟเวอร์ไม่ถูกต้อง กรุณาแจ้งผู้ดูแลระบบ";

export interface ApiOptions<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  /** Raw bytes to send as the body (a slip image); mutually exclusive with `json`. */
  file?: Blob;
  /** The response is validated against this; anything else is an error. */
  schema?: ZodType<T>;
  signal?: AbortSignal;
}

export async function apiFetch<T = void>(path: string, options: ApiOptions<T> = {}): Promise<T> {
  const { method = "GET", json, file, schema, signal } = options;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: file ? { "content-type": file.type || "application/octet-stream" } : json === undefined ? undefined : { "content-type": "application/json" },
      body: file ?? (json === undefined ? undefined : JSON.stringify(json)),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", NETWORK_MESSAGE);
  }

  if (!res.ok) {
    let code = "ERROR";
    let message = GENERIC_MESSAGE;
    try {
      const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === "string") code = body.error.code;
      if (typeof body.error?.message === "string" && body.error.message.length > 0) message = body.error.message;
    } catch {
      /* not JSON: keep the generic message */
    }
    if (res.status === 401 && code === "UNAUTHENTICATED") unauthorizedHandler?.();
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, "BAD_RESPONSE", BAD_RESPONSE_MESSAGE);
  }
  if (!schema) return data as T;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(res.status, "BAD_RESPONSE", BAD_RESPONSE_MESSAGE);
  return parsed.data;
}

/** A message safe to show a user for anything thrown while calling the API. */
export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : GENERIC_MESSAGE;
}
