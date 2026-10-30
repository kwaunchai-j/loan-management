import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Alert, Badge, Button, Card, Icon, Item, PageTitle, PasswordField, SelectField, Spinner, TextAreaField, TextField } from "@/components/ui";

describe("Button", () => {
  it("is a button that does not submit a form unless told to, and runs onClick", async () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button onClick={onClick}>กด</Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "กด" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a form when it is type=submit", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">ส่ง</Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "ส่ง" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>กด</Button>);
    await userEvent.click(screen.getByRole("button", { name: "กด" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("has a primary, secondary and danger look that differ, and keeps a 44 px touch target", () => {
    render(
      <>
        <Button>a</Button>
        <Button variant="secondary">b</Button>
        <Button variant="danger">c</Button>
      </>,
    );
    const classes = ["a", "b", "c"].map((n) => screen.getByRole("button", { name: n }).className);
    expect(new Set(classes).size).toBe(3);
    for (const c of classes) expect(c).toContain("min-h-11");
  });
});

describe("TextField", () => {
  it("ties the label to the box so a screen reader and getByLabelText find it", async () => {
    const onChange = vi.fn();
    render(<TextField label="ชื่อ" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("ชื่อ"), "ab");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("shows the hint, and an error as an alert with the box marked invalid and described by it", () => {
    render(<TextField label="เบอร์" hint="เช่น 081" error="เบอร์ไม่ถูกต้อง" />);
    const box = screen.getByLabelText("เบอร์");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("เบอร์ไม่ถูกต้อง");
    const described = (box.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["เช่น 081", "เบอร์ไม่ถูกต้อง"]);
  });

  it("has no alert and is not invalid when there is no error", () => {
    render(<TextField label="เบอร์" error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("เบอร์")).not.toHaveAttribute("aria-invalid");
  });
});

describe("PasswordField", () => {
  it("hides the password, and the show/hide button reveals and hides it again", async () => {
    render(<PasswordField label="รหัสผ่าน" />);
    const box = screen.getByLabelText("รหัสผ่าน");
    expect(box).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "แสดง" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(box).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "ซ่อน" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "ซ่อน" }));
    expect(box).toHaveAttribute("type", "password");
  });

  it("never submits the form when the toggle is pressed", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField label="รหัสผ่าน" />
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: "แสดง" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("SelectField and TextAreaField", () => {
  it("SelectField: choosing an option reports it; an error is an alert", async () => {
    const onChange = vi.fn();
    render(
      <SelectField label="สถานะ" error="เลือกสถานะ" onChange={(e) => onChange(e.target.value)} defaultValue="a">
        <option value="a">เอ</option>
        <option value="b">บี</option>
      </SelectField>,
    );
    await userEvent.selectOptions(screen.getByLabelText("สถานะ"), "b");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.getByRole("alert")).toHaveTextContent("เลือกสถานะ");
    expect(screen.getByLabelText("สถานะ")).toHaveAttribute("aria-invalid", "true");
  });

  it("TextAreaField: label, hint and error all work", async () => {
    const onChange = vi.fn();
    render(<TextAreaField label="หมายเหตุ" hint="ไม่เกิน 500 ตัวอักษร" error="ยาวเกินไป" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("หมายเหตุ"), "x");
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByText("ไม่เกิน 500 ตัวอักษร")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("ยาวเกินไป");
  });
});

describe("Alert", () => {
  it.each([
    ["error", "alert"],
    ["warning", "status"],
    ["success", "status"],
    ["info", "status"],
  ] as const)("a %s message is announced as role=%s", (kind, role) => {
    render(<Alert kind={kind}>ข้อความ</Alert>);
    expect(screen.getByRole(role)).toHaveTextContent("ข้อความ");
  });

  it("defaults to info, and its icon is hidden from screen readers (the words carry the meaning)", () => {
    const { container } = render(<Alert>ทราบไว้</Alert>);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Badge, Card, Item, PageTitle, Spinner, Icon", () => {
  it("Badge shows its words in each tone", () => {
    render(
      <>
        <Badge tone="green">ก</Badge>
        <Badge tone="red">ข</Badge>
        <Badge tone="gray">ค</Badge>
        <Badge tone="amber">ง</Badge>
      </>,
    );
    for (const w of ["ก", "ข", "ค", "ง"]) expect(screen.getByText(w)).toBeInTheDocument();
  });

  it("Card has a heading only when it has a title", () => {
    const { rerender } = render(<Card title="หัวข้อ">เนื้อหา</Card>);
    expect(screen.getByRole("heading", { level: 2, name: "หัวข้อ" })).toBeInTheDocument();
    rerender(<Card>เนื้อหา</Card>);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("เนื้อหา")).toBeInTheDocument();
  });

  it("Item pairs a label with its value in a description list", () => {
    render(
      <dl>
        <Item label="ยอดค้าง" value="1,135 บาท" strong />
        <Item label="สถานะ" value="กำลังใช้งาน" />
      </dl>,
    );
    expect(screen.getByText("ยอดค้าง").tagName).toBe("DT");
    expect(screen.getByText("1,135 บาท").tagName).toBe("DD");
    expect(screen.getByText("1,135 บาท").className).toContain("font-bold");
    expect(screen.getByText("กำลังใช้งาน").className).not.toContain("font-bold");
  });

  it("PageTitle is the page's one h1", () => {
    render(<PageTitle>สัญญา</PageTitle>);
    expect(screen.getByRole("heading", { level: 1, name: "สัญญา" })).toBeInTheDocument();
  });

  it("Spinner says it is loading, or says what it was told to", () => {
    const { rerender } = render(<Spinner />);
    expect(screen.getByRole("status")).toHaveTextContent("กำลังโหลด...");
    rerender(<Spinner label="กำลังบันทึก" />);
    expect(screen.getByRole("status")).toHaveTextContent("กำลังบันทึก");
  });

  it("Icon is decorative: hidden from screen readers, not focusable, sized by the class it is given", () => {
    const { container } = render(<Icon name="calendar" className="h-4 w-4" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveClass("h-4", "w-4");
  });
});
