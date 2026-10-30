import type { Db } from "../db.js";
import { LINE_TEXT_LIMIT } from "./messages.js";
import type { ChannelAdapter, RenderedMessage } from "./types.js";

/**
 * LINE Official Account channel (T-402): Messaging API push to the ADMIN's `User.lineUserId`.
 * The channel access token comes from env only and is never logged or put in an error message.
 */
export const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export interface LineAdapterOptions {
  prisma: Db;
  accessToken: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  url?: string;
  timeoutMs?: number;
}

export function createLineAdapter(opts: LineAdapterOptions): ChannelAdapter {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = opts.url ?? LINE_PUSH_URL;

  const recipients = () =>
    opts.prisma.user.findMany({
      where: { role: "ADMIN", isActive: true, lineUserId: { not: null } },
      select: { lineUserId: true },
    });

  async function pushTo(lineUserId: string, text: string): Promise<void> {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.accessToken}` },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text: text.slice(0, LINE_TEXT_LIMIT) }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.ok) return;
    // LINE explains errors in a JSON "message"; keep only that, never the request (which holds the token).
    let detail = "";
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string") detail = `: ${body.message.slice(0, 200)}`;
    } catch {
      /* no body */
    }
    throw new Error(`LINE push failed with HTTP ${res.status}${detail}`);
  }

  return {
    channel: "LINE",
    async hasRecipients() {
      return (await recipients()).length > 0;
    },
    async send(message: RenderedMessage) {
      const to = (await recipients()).map((r) => r.lineUserId!);
      if (to.length === 0) throw new Error("no LINE recipient is bound");
      const results = await Promise.allSettled(to.map((id) => pushTo(id, message.line)));
      if (results.every((r) => r.status === "rejected")) {
        const first = results[0] as PromiseRejectedResult;
        throw first.reason instanceof Error ? first.reason : new Error("LINE push failed");
      }
    },
  };
}
