import { describe, expect, it } from "vitest";
import { buildCalendar, escapeText, foldLine, icsDate, icsTimestamp } from "../src/lib/ics.js";

const octets = (s: string) => Buffer.byteLength(s);

describe("iCalendar writer", () => {
  it("escapes the characters that have a meaning in iCalendar text", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeText("line one\nline two\r\nthree")).toBe("line one\\nline two\\nthree");
  });

  it("folds long lines at 75 octets without splitting a Thai character", () => {
    const folded = foldLine(`SUMMARY:${"ครบกำหนด".repeat(20)}`);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(octets(p)).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    // unfolding gives the original text back
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(`SUMMARY:${"ครบกำหนด".repeat(20)}`);
    expect(foldLine("short")).toBe("short");
  });

  it("writes dates and timestamps the way iCalendar wants them", () => {
    expect(icsDate("2026-11-02")).toBe("20261102");
    expect(icsTimestamp(new Date("2026-11-02T03:15:09.123Z"))).toBe("20261102T031509Z");
  });

  it("writes one all-day event per entry that ends on the next day, even across a month or year end", () => {
    const text = buildCalendar({
      name: "วันครบกำหนด",
      description: "d",
      stamp: new Date("2026-11-02T00:00:00Z"),
      events: [
        { uid: "a@x", day: "2026-12-31", summary: "สรุป, ยอด; หนึ่ง", description: "บรรทัด 1\nบรรทัด 2", alertAtHour: 9 },
        { uid: "b@x", day: "2028-02-28", summary: "ปีอธิกสุรทิน", description: "-" },
      ],
    });
    expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // every line ends with CRLF and none is longer than 75 octets
    for (const line of text.split("\r\n").slice(0, -1)) expect(octets(line)).toBeLessThanOrEqual(75);
    const unfolded = text.replace(/\r\n /g, "");
    expect(unfolded).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101");
    expect(unfolded).toContain("DTSTART;VALUE=DATE:20280228\r\nDTEND;VALUE=DATE:20280229");
    expect(unfolded).toContain("SUMMARY:สรุป\\, ยอด\\; หนึ่ง");
    expect(unfolded).toContain("DESCRIPTION:บรรทัด 1\\nบรรทัด 2");
    expect(unfolded).toContain("X-WR-TIMEZONE:Asia/Bangkok");
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    // only the event that asked for an alert has one: 09:00 on the day
    expect(unfolded.match(/BEGIN:VALARM/g)).toHaveLength(1);
    expect(unfolded).toContain("TRIGGER:PT9H");
  });

  it("is a valid empty calendar when there are no events", () => {
    const text = buildCalendar({ name: "n", description: "d", stamp: new Date(), events: [] });
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).not.toContain("BEGIN:VEVENT");
  });
});
