import type { Prisma } from "@prisma/client";

/** 1234567.5 -> "1,234,567.50", 1135 -> "1,135" (whole baht show no decimals) — built from the exact decimal text, never through a float. */
export function formatBaht(value: Prisma.Decimal): string {
  const [whole = "0", frac = "00"] = value.toFixed(2).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = `${negative ? "-" : ""}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  return frac === "00" ? grouped : `${grouped}.${frac}`;
}

/** Date-only Date -> "29/10/2569" (Buddhist Era, as Thai readers expect). */
export function formatThaiDate(d: Date): string {
  const [y, m, day] = d.toISOString().slice(0, 10).split("-");
  return `${day}/${m}/${Number(y) + 543}`;
}
