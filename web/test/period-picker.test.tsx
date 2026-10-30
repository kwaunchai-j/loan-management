import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PeriodPicker } from "@/components/reports/PeriodPicker";

const apply = () => screen.getByRole("button", { name: "แสดงรายงาน" });
const choose = (label: string) => userEvent.selectOptions(screen.getByLabelText("ช่วงเวลา"), label);

describe("PeriodPicker", () => {
  it("offers the four kinds of period, and starts on the current month", () => {
    render(<PeriodPicker onApply={() => undefined} />);
    const options = Array.from(screen.getByLabelText("ช่วงเวลา").querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["รายเดือน", "รายปี", "ช่วงวันที่เอง", "ทั้งหมด (ทุกช่วงเวลา)"]);
    expect(screen.getByLabelText("ช่วงเวลา")).toHaveValue("month");
    expect(screen.getByLabelText("เดือน")).toBeInTheDocument();
  });

  it("does not ask the API until the button is pressed, then asks once with the chosen month", async () => {
    const onApply = vi.fn();
    render(<PeriodPicker onApply={onApply} />);
    const month = screen.getByLabelText("เดือน");
    await userEvent.clear(month);
    await userEvent.type(month, "2026-03");
    expect(onApply).not.toHaveBeenCalled(); // typing alone fetches nothing
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("month=2026-03");
  });

  it("year: shows only the year box, and sends the year", async () => {
    const onApply = vi.fn();
    render(<PeriodPicker onApply={onApply} />);
    await choose("รายปี");
    expect(screen.queryByLabelText("เดือน")).not.toBeInTheDocument();
    const year = screen.getByLabelText("ปี (ค.ศ.)");
    await userEvent.clear(year);
    await userEvent.type(year, "2025");
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith("year=2025");
  });

  it("a bad year is explained and nothing is sent", async () => {
    const onApply = vi.fn();
    render(<PeriodPicker onApply={onApply} />);
    await choose("รายปี");
    const year = screen.getByLabelText("ปี (ค.ศ.)");
    await userEvent.clear(year);
    await userEvent.type(year, "20");
    await userEvent.click(apply());
    expect(await screen.findByRole("alert")).toHaveTextContent("ปีต้องเป็นตัวเลข 4 หลัก");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("range: two day boxes; an end before the start is refused, a good range is sent, and the error goes away", async () => {
    const onApply = vi.fn();
    render(<PeriodPicker onApply={onApply} />);
    await choose("ช่วงวันที่เอง");
    const from = screen.getByLabelText("ตั้งแต่วันที่");
    const to = screen.getByLabelText("ถึงวันที่ (รวมวันนี้)");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-05-10");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-05-01");
    await userEvent.click(apply());
    expect(await screen.findByRole("alert")).toHaveTextContent("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น");
    expect(onApply).not.toHaveBeenCalled();

    await userEvent.clear(to);
    await userEvent.type(to, "2026-05-31");
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith("from=2026-05-10&to=2026-05-31");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("all time: no date box and an empty query", async () => {
    const onApply = vi.fn();
    render(<PeriodPicker onApply={onApply} />);
    await choose("ทั้งหมด (ทุกช่วงเวลา)");
    expect(screen.queryByLabelText("เดือน")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("ปี (ค.ศ.)")).not.toBeInTheDocument();
    await userEvent.click(apply());
    expect(onApply).toHaveBeenCalledWith("");
  });
});
