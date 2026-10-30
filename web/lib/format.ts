/** A moment shown in Thai, Bangkok time, Buddhist Era (e.g. "29 ต.ค. 2569 14:05"). */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
}
