import { Prisma, type NotificationType } from "@prisma/client";
import type { Db } from "../db.js";
import { bangkokToday } from "../lib/dates.js";
import { renderNewRequest, renderPaymentSubmitted } from "./messages.js";
import type { ChannelAdapter, DeliveryOutcome, RenderedMessage } from "./types.js";

/**
 * The central notification service (T-401, DES-013). Recipient: the ADMIN only.
 *
 * Exactly-once per (type, key, channel):  `NotificationLog.dedupeKey` is unique. The first process
 * to insert the row owns the delivery (the insert already counts as attempt 1); anyone else who
 * finds the row backs off. A delivery that fails is retried, at most 3 attempts in total, then the
 * row is FAILED with the error text. The channels are independent: one failing never stops the other.
 */
export const MAX_ATTEMPTS = 3;
/** A PENDING row older than this is treated as abandoned (the process died mid-send) and resumed. */
export const STALE_PENDING_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000];
const MAX_ERROR_LENGTH = 500;

export interface NotifierOptions {
  prisma: Db;
  adapters: ChannelAdapter[];
  /** Pause before attempt 2 and attempt 3. Tests pass zeros. */
  retryDelaysMs?: number[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface DeliverInput {
  type: NotificationType;
  /** Identifies this notification within its type: a request id, or the Bangkok date of a round. */
  key: string;
  /** Bangkok calendar date the notification belongs to. */
  scheduledDate: Date;
  message: RenderedMessage;
}

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : "unknown error").slice(0, MAX_ERROR_LENGTH);

export class Notifier {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (m: string) => void;
  private readonly delays: number[];
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly opts: NotifierOptions) {
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((m) => console.log(m));
    this.delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  get channels() {
    return this.opts.adapters;
  }

  /** Delivers on every channel that has a recipient; returns what happened per channel. */
  async deliver(input: DeliverInput): Promise<Record<string, DeliveryOutcome>> {
    const entries = await Promise.all(
      this.opts.adapters.map(async (adapter) => {
        try {
          return [adapter.channel, await this.deliverOn(adapter, input)] as const;
        } catch (err) {
          // Bookkeeping trouble (e.g. database) on one channel must not stop the other.
          this.log(`notification ${input.type} on ${adapter.channel} errored: ${errorText(err)}`);
          return [adapter.channel, "failed" as DeliveryOutcome] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private async deliverOn(adapter: ChannelAdapter, input: DeliverInput): Promise<DeliveryOutcome> {
    if (!(await adapter.hasRecipients())) return "unavailable";
    const { prisma } = this.opts;
    const dedupeKey = `${input.type}:${input.key}:${adapter.channel}`;

    let row: { id: string; attempts: number };
    try {
      // Inserting counts as owning attempt 1, so two racing callers can never both send.
      row = await prisma.notificationLog.create({
        data: {
          dedupeKey,
          type: input.type,
          channel: adapter.channel,
          scheduledDate: input.scheduledDate,
          status: "PENDING",
          attempts: 1,
        },
        select: { id: true, attempts: true },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const existing = await prisma.notificationLog.findUniqueOrThrow({ where: { dedupeKey } });
      const stale = this.now().getTime() - existing.createdAt.getTime() > STALE_PENDING_MS;
      if (existing.status !== "PENDING" || existing.attempts >= MAX_ATTEMPTS || !stale) return "skipped";
      // abandoned mid-send: take over with the next attempt (compare-and-set so only one taker wins)
      const taken = await prisma.notificationLog.updateMany({
        where: { id: existing.id, status: "PENDING", attempts: existing.attempts },
        data: { attempts: existing.attempts + 1 },
      });
      if (taken.count === 0) return "skipped";
      row = { id: existing.id, attempts: existing.attempts + 1 };
    }

    for (;;) {
      try {
        await adapter.send(input.message);
        await prisma.notificationLog.update({
          where: { id: row.id },
          data: { status: "SENT", sentAt: this.now(), error: null },
        });
        return "sent";
      } catch (err) {
        const message = errorText(err);
        if (row.attempts >= MAX_ATTEMPTS) {
          await prisma.notificationLog.update({ where: { id: row.id }, data: { status: "FAILED", error: message } });
          this.log(`notification ${input.type} on ${adapter.channel} FAILED after ${row.attempts} attempts: ${message}`);
          return "failed";
        }
        await prisma.notificationLog.update({ where: { id: row.id }, data: { error: message } });
        await this.sleep(this.delays[row.attempts - 1] ?? this.delays[this.delays.length - 1] ?? 0);
        row = { id: row.id, attempts: row.attempts + 1 };
        await prisma.notificationLog.update({ where: { id: row.id }, data: { attempts: row.attempts } });
      }
    }
  }

  /** NEW_REQUEST: sent right away for a request that has just been filed (DES-013). */
  async newRequest(loanRequestId: string): Promise<Record<string, DeliveryOutcome>> {
    const r = await this.opts.prisma.loanRequest.findUnique({
      where: { id: loanRequestId },
      select: { amount: true, requestedDueDate: true, status: true, createdAt: true, borrower: { select: { fullName: true } } },
    });
    if (!r || r.status !== "PENDING") return {};
    return this.deliver({
      type: "NEW_REQUEST",
      key: loanRequestId,
      scheduledDate: bangkokToday(r.createdAt),
      message: renderNewRequest({
        borrowerName: r.borrower.fullName,
        amount: r.amount,
        requestedDueDate: r.requestedDueDate,
      }),
    });
  }

  /** PAYMENT_SUBMITTED: sent right away when a borrower sends a payment slip (CR-1). */
  async paymentSubmitted(submissionId: string): Promise<Record<string, DeliveryOutcome>> {
    const r = await this.opts.prisma.paymentSubmission.findUnique({
      where: { id: submissionId },
      select: {
        amount: true,
        paidOn: true,
        status: true,
        createdAt: true,
        contract: { select: { contractNo: true } },
        borrower: { select: { fullName: true } },
      },
    });
    if (!r || r.status !== "PENDING") return {};
    return this.deliver({
      type: "PAYMENT_SUBMITTED",
      key: submissionId,
      scheduledDate: bangkokToday(r.createdAt),
      message: renderPaymentSubmitted({
        borrowerName: r.borrower.fullName,
        contractNo: r.contract.contractNo,
        amount: r.amount,
        paidOn: r.paidOn,
      }),
    });
  }

  /** Runs `task` in the background without letting its failure reach (or delay) the caller. */
  dispatch(task: () => Promise<unknown>): void {
    const p = task()
      .catch((err) => this.log(`background notification failed: ${errorText(err)}`))
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /** Waits for every background notification started so far (used by tests and at shutdown). */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }
}
