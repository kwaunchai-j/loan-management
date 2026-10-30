import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentSubmitCard } from "@/components/PaymentSubmitCard";
import { slipLimit } from "@/lib/limits";
import { mockApi } from "./mocks";

afterEach(() => vi.unstubAllEnvs());

describe("slipLimit", () => {
  it("is 5 MB unless the build says otherwise", () => {
    expect(slipLimit()).toEqual({ bytes: 5 * 1024 * 1024, mb: 5 });
  });

  it("follows NEXT_PUBLIC_SLIP_MAX_MB (4 on Vercel, where a request body may not exceed 4.5 MB)", () => {
    vi.stubEnv("NEXT_PUBLIC_SLIP_MAX_MB", "4");
    expect(slipLimit()).toEqual({ bytes: 4 * 1024 * 1024, mb: 4 });
  });

  it.each([["4.7", 4], ["1", 1], ["50", 50]])("rounds down to whole MB: %s -> %d", (value, mb) => {
    vi.stubEnv("NEXT_PUBLIC_SLIP_MAX_MB", value);
    expect(slipLimit().mb).toBe(mb);
  });

  it.each(["", "abc", "0", "0.5", "-3", "51", "1000", "NaN", "Infinity"])("falls back to 5 MB for the unusable value %j", (value) => {
    vi.stubEnv("NEXT_PUBLIC_SLIP_MAX_MB", value);
    expect(slipLimit().mb).toBe(5);
  });
});

describe("the slip form uses the configured limit", () => {
  const open = async () => {
    mockApi({ "GET /me/payment-submissions": { body: { items: [] } } });
    render(<PaymentSubmitCard contractId="c1" disbursedOn="2026-10-01" />);
    await screen.findByText("ยังไม่เคยส่งสลิปของสัญญานี้");
  };

  it("says 5 MB by default", async () => {
    await open();
    expect(screen.getByText(/ไม่เกิน 5 MB/)).toBeInTheDocument();
  });

  it("says 4 MB and refuses a 4.5 MB picture when the build is set to 4", async () => {
    vi.stubEnv("NEXT_PUBLIC_SLIP_MAX_MB", "4");
    await open();
    expect(screen.getByText(/ไม่เกิน 4 MB/)).toBeInTheDocument();
    const user = userEvent.setup({ applyAccept: false });
    const big = new File([new Uint8Array(4.5 * 1024 * 1024)], "slip.jpg", { type: "image/jpeg" });
    await user.type(screen.getByLabelText(/จำนวนเงินที่โอน/), "300");
    await user.upload(screen.getByLabelText(/สลิปการโอนเงิน/), big);
    await user.click(screen.getByRole("button", { name: "ส่งสลิป" }));
    expect(await screen.findByText("ไฟล์ใหญ่เกิน 4 MB")).toBeInTheDocument();
  });
});
