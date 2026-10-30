/**
 * The largest slip image the form accepts. It mirrors the API's SLIP_MAX_BYTES (the API checks again and its
 * answer wins). 5 MB by default; on Vercel a request body is limited to 4.5 MB, so there both are set to 4:
 * the API with SLIP_MAX_BYTES=4194304 and the web with NEXT_PUBLIC_SLIP_MAX_MB=4 (read when the web is built).
 */
const DEFAULT_SLIP_MAX_MB = 5;

export function slipLimit(): { bytes: number; mb: number } {
  const n = Number(process.env.NEXT_PUBLIC_SLIP_MAX_MB);
  const mb = Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : DEFAULT_SLIP_MAX_MB;
  return { bytes: mb * 1024 * 1024, mb };
}
