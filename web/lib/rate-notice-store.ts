import { create } from "zustand";
import { apiFetch, errorMessage } from "./api";
import { rateNoticeSchema, type RateNotice } from "./schemas";

/**
 * The rate-adjustment notice of the logged-in borrower (CR-9), shared by the /me layout (which shows the dialog) and the
 * request page (which holds the form back until the borrower has acknowledged). The API is the real gate: a new request is
 * refused with 409 RATE_NOTICE_REQUIRED until the notice is acknowledged.
 */
interface RateNoticeState {
  notice: RateNotice | null;
  /** The dialog is on screen. Closing it without acknowledging only hides it: the notice stays required. */
  open: boolean;
  busy: boolean;
  error: string | null;
  /** Asks the API; opens the dialog when there is something to acknowledge. */
  load: () => Promise<void>;
  show: () => void;
  hide: () => void;
  acknowledge: () => Promise<void>;
  reset: () => void;
}

const EMPTY = { notice: null, open: false, busy: false, error: null } as const;

export const useRateNotice = create<RateNoticeState>((set, get) => ({
  ...EMPTY,

  async load() {
    try {
      const notice = await apiFetch("/me/rate-notice", { schema: rateNoticeSchema });
      set({ notice, open: notice.required, error: null });
    } catch {
      // the notice is not shown, but nothing is lost: the API still refuses a new request until it is acknowledged
      set({ notice: null, open: false });
    }
  },

  show: () => set({ open: true, error: null }),
  hide: () => set({ open: false }),

  async acknowledge() {
    const { notice } = get();
    if (!notice?.required || notice.seq === null) return;
    set({ busy: true, error: null });
    try {
      const next = await apiFetch("/me/rate-notice/acknowledge", { method: "POST", json: { seq: notice.seq }, schema: rateNoticeSchema });
      // a newer adjustment made meanwhile keeps the dialog open, now with the newer figures
      set({ notice: next, open: next.required, busy: false });
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  reset: () => set({ ...EMPTY }),
}));
