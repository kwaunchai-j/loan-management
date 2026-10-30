import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/Modal";

function Harness({ onClose = () => undefined, children }: { onClose?: () => void; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>เปิด</button>
      <button>ปุ่มอื่นของหน้า</button>
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="หัวข้อ"
      >
        {children ?? (
          <>
            <button>ข้างใน 1</button>
            <button>ข้างใน 2</button>
          </>
        )}
      </Modal>
    </>
  );
}

const dialog = () => screen.queryByRole("dialog", { name: "หัวข้อ" });

describe("Modal", () => {
  it("is not in the page until it is opened", () => {
    render(<Harness />);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("opens as a named, modal dialog with its content", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    const d = dialog()!;
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "หัวข้อ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ข้างใน 1" })).toBeInTheDocument();
  });

  it("puts the focus inside it when it opens", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("closes with the × button, and the focus goes back to the button that opened it", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "เปิด" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "ปิดหน้าต่าง" }));
    expect(dialog()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
  });

  it("closes with the Escape key", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    await userEvent.keyboard("{Escape}");
    expect(dialog()).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the dark area behind it is clicked, but not when the panel itself is", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    await userEvent.click(screen.getByRole("heading", { name: "หัวข้อ" }));
    expect(dialog()).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("modal-backdrop"));
    expect(dialog()).not.toBeInTheDocument();
  });

  it("keeps Tab inside: from the last control it goes to the first, and Shift+Tab goes the other way round", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    const first = screen.getByRole("button", { name: "ปิดหน้าต่าง" }); // the × is the first control of the panel
    const last = screen.getByRole("button", { name: "ข้างใน 2" });
    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    expect(screen.getByRole("button", { name: "ปุ่มอื่นของหน้า" })).not.toHaveFocus();
  });

  it("stops the page behind it from scrolling while open, and lets it scroll again afterwards", async () => {
    document.body.style.overflow = "auto";
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    expect(document.body.style.overflow).toBe("hidden");
    await userEvent.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("auto");
  });

  it("works with nothing focusable inside except the × (Tab stays on it)", async () => {
    render(<Harness>แค่ข้อความ</Harness>);
    await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
    await userEvent.tab();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("can be opened again after it was closed", async () => {
    render(<Harness />);
    for (let i = 0; i < 2; i++) {
      await userEvent.click(screen.getByRole("button", { name: "เปิด" }));
      expect(dialog()).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(dialog()).not.toBeInTheDocument();
    }
  });
});
