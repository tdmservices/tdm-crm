import { db, getSetting } from "./db.js";
import { pkDate } from "./time.js";

/**
 * Daily rates pulled from a free rate service (open.er-api.com, no key, covers PKR/AED/GBP).
 * Rates are stored per Pakistan date. If the day's rate cannot be fetched the last fetched
 * rate is used and the entry is flagged (is_fallback). Entries are never re-rated.
 */
const RATE_URL = process.env.FX_URL ?? "https://open.er-api.com/v6/latest/USD";
export const SUPPORTED = ["USD", "PKR", "AED", "GBP", "EUR", "SAR", "CAD", "AUD"];

export async function refreshRates(): Promise<{ ok: boolean; date: string; error?: string }> {
  const date = pkDate();
  try {
    const res = await fetch(RATE_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { rates?: Record<string, number> };
    if (!json.rates) throw new Error("No rates in response");
    const ins = db.prepare(
      "INSERT INTO fx_rates (currency, rate_date, usd_per_unit, is_fallback, fetched_at) VALUES (?, ?, ?, 0, datetime('now')) ON CONFLICT(currency, rate_date) DO UPDATE SET usd_per_unit = excluded.usd_per_unit, is_fallback = 0, fetched_at = excluded.fetched_at"
    );
    const tx = db.transaction(() => {
      for (const c of SUPPORTED) {
        const perUsd = c === "USD" ? 1 : json.rates![c];
        if (perUsd) ins.run(c, date, 1 / perUsd);
      }
    });
    tx();
    return { ok: true, date };
  } catch (e) {
    return { ok: false, date, error: (e as Error).message };
  }
}

export interface RateLookup { usd_per_unit: number; is_fallback: boolean; rate_date: string }

/** Rate for a currency on a Pakistan date. Falls back to the latest fetched rate, then to the seeded setting. */
export function rateFor(currency: string, date = pkDate()): RateLookup {
  const cur = currency.toUpperCase();
  if (cur === "USD") return { usd_per_unit: 1, is_fallback: false, rate_date: date };
  const exact = db.prepare("SELECT usd_per_unit, is_fallback, rate_date FROM fx_rates WHERE currency = ? AND rate_date = ?").get(cur, date) as RateLookup | undefined;
  if (exact) return { ...exact, is_fallback: !!exact.is_fallback };
  const latest = db.prepare("SELECT usd_per_unit, rate_date FROM fx_rates WHERE currency = ? ORDER BY rate_date DESC LIMIT 1").get(cur) as { usd_per_unit: number; rate_date: string } | undefined;
  if (latest) return { usd_per_unit: latest.usd_per_unit, is_fallback: true, rate_date: latest.rate_date };
  const seeded = getSetting(`fx_fallback_${cur.toLowerCase()}`);
  if (seeded) return { usd_per_unit: Number(seeded), is_fallback: true, rate_date: "seed" };
  throw new Error(`No exchange rate available for ${cur}`);
}

export function toUsd(amount: number, currency: string, date?: string) {
  const r = rateFor(currency, date);
  return { amount_usd: round2(amount * r.usd_per_unit), rate: r.usd_per_unit, fallback: r.is_fallback };
}
/** Live display conversion from USD to PKR for leaderboards. */
export function usdToPkr(usd: number) {
  const r = rateFor("PKR");
  return round2(usd / r.usd_per_unit);
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
