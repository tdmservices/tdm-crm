// All day boundaries use the agency's local time. Default is Pakistan time (UTC+5, no DST).
// Another agency packages the app by setting TZ_OFFSET_HOURS at deployment (whole or half hours, no DST handling).
const PK_OFFSET_MS = Number(process.env.TZ_OFFSET_HOURS ?? 5) * 60 * 60 * 1000;

export function nowIso(): string {
  return new Date().toISOString();
}
/** YYYY-MM-DD in Pakistan time for a given instant (default now). */
export function pkDate(d: Date = new Date()): string {
  return new Date(d.getTime() + PK_OFFSET_MS).toISOString().slice(0, 10);
}
/** Start of a Pakistan-time day as a UTC ISO string. */
export function pkDayStartIso(dateStr: string): string {
  return new Date(new Date(dateStr + "T00:00:00Z").getTime() - PK_OFFSET_MS).toISOString();
}
export function pkDayEndIso(dateStr: string): string {
  return new Date(new Date(dateStr + "T00:00:00Z").getTime() - PK_OFFSET_MS + 86400000).toISOString();
}
export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}
/** Monday-start week containing dateStr. */
export function weekRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Monday=0
  const start = addDays(dateStr, -dow);
  return { start, end: addDays(start, 6) };
}
export function monthRange(dateStr: string): { start: string; end: string } {
  const [y, m] = dateStr.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(next, -1) };
}
export function quarterRange(dateStr: string): { start: string; end: string } {
  const [y, m] = dateStr.split("-").map(Number);
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  const start = `${y}-${String(qm).padStart(2, "0")}-01`;
  const endM = qm + 2;
  const { end } = monthRange(`${y}-${String(endM).padStart(2, "0")}-01`);
  return { start, end };
}
export function previousRange(r: { start: string; end: string }): { start: string; end: string } {
  const len = daysBetween(r.start, r.end) + 1;
  return { start: addDays(r.start, -len), end: addDays(r.start, -1) };
}
export function rangeFor(period: string, today = pkDate()): { start: string; end: string } {
  switch (period) {
    case "week": return weekRange(today);
    case "month": return monthRange(today);
    case "quarter": return quarterRange(today);
    case "all": return { start: "2000-01-01", end: "2999-12-31" };
    default: return monthRange(today);
  }
}
/** [startIso, endIsoExclusive) for a Pakistan date range. */
export function isoBounds(r: { start: string; end: string }): { from: string; to: string } {
  return { from: pkDayStartIso(r.start), to: pkDayEndIso(r.end) };
}
