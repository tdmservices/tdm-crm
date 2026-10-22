/** Phase 2: payment schedule on a deal. Milestones for one-off projects, monthly lines for retainers. */
import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { isManagement } from "../auth.js";
import { bad, forbidden, notFound } from "../errors.js";
import { logActivity } from "../log.js";
import { toUsd, round2 } from "../fx.js";
import { pkDate, addDays } from "../time.js";
import { isRetainerType } from "../commission.js";

export const scheduleRouter = Router();

export function scheduleWithStatus(prospectId: number) {
  const today = pkDate();
  const rows = db.prepare("SELECT s.*, p.received_at, p.amount_usd AS received_usd, p.reversed_at FROM payment_schedule s LEFT JOIN payments p ON p.id = s.payment_id WHERE s.prospect_id = ? ORDER BY s.sort, s.expected_date").all(prospectId) as any[];
  return rows.map(r => ({ ...r, status: r.payment_id && !r.reversed_at ? "received" : r.expected_date < today ? "overdue" : "expected" }));
}

const milestoneSchema = z.object({ name: z.string().min(1), percentage: z.number().min(0).max(100).optional().nullable(), amount: z.number().min(0).optional().nullable(), expected_date: z.string() });
const body = z.object({
  structure: z.enum(["full_upfront", "milestones", "monthly"]),
  milestones: z.array(milestoneSchema).optional(),
  retainer: z.object({ monthly_amount: z.number().positive(), billing_day: z.number().int().min(1).max(28), start_month: z.string().regex(/^\d{4}-\d{2}$/), min_months: z.number().int().min(0).optional().nullable() }).optional(),
  expected_date: z.string().optional(),   // full upfront
});

function monthLine(p: any, ym: string, amount: number, currency: string, sort: number) {
  const [y, m] = ym.split("-").map(Number);
  const day = Math.min(p.retainer_billing_day ?? 1, 28);
  const expected = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const c = toUsd(amount, currency, expected <= pkDate() ? expected : undefined);
  db.prepare("INSERT INTO payment_schedule (prospect_id, kind, name, amount, currency, amount_usd, expected_date, sort) VALUES (?, 'month', ?, ?, ?, ?, ?, ?)")
    .run(p.id, new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }), amount, currency, c.amount_usd, expected, sort);
}
export function nextMonth(ym: string) { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; }

/** Set or replace the schedule. Agents may set it on their own deal before approval; management anytime (lines already received are kept). */
scheduleRouter.put("/:id/schedule", (req, res) => {
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(Number(req.params.id)) as any;
  if (!p) throw notFound();
  const mine = p.owner_id === req.user.id || p.partner_id === req.user.id;
  if (!isManagement(req.user) && !mine) throw forbidden();
  if (!isManagement(req.user) && p.closed_won_at) throw forbidden("After approval only Abdul or Adnan can change the schedule");
  const b = body.parse(req.body);
  if (p.deal_value == null) throw bad("Enter the deal value first");
  const currency = p.deal_currency ?? "USD";
  const retainer = isRetainerType(p.engagement_model);
  if (b.structure === "monthly" && !retainer) throw bad("Monthly structure is for retainers and dedicated resources");
  if (b.structure !== "monthly" && retainer) throw bad("A retainer uses the monthly structure");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payment_schedule WHERE prospect_id = ? AND payment_id IS NULL").run(p.id);
    const received = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payment_schedule WHERE prospect_id = ? AND payment_id IS NOT NULL").get(p.id) as any).s as number;
    if (b.structure === "full_upfront") {
      const amt = round2(p.deal_value - received);
      const c = toUsd(amt, currency);
      db.prepare("INSERT INTO payment_schedule (prospect_id, kind, name, percentage, amount, currency, amount_usd, expected_date, sort) VALUES (?, 'milestone', 'Full payment', 100, ?, ?, ?, ?, 0)").run(p.id, amt, currency, c.amount_usd, b.expected_date ?? addDays(pkDate(), 7));
    } else if (b.structure === "milestones") {
      if (!b.milestones?.length) throw bad("Add at least one milestone");
      const lines = b.milestones.map(m => ({ ...m, amount: m.amount != null && m.amount > 0 ? m.amount : round2(p.deal_value * ((m.percentage ?? 0) / 100)) }));
      const sum = round2(lines.reduce((s, l) => s + l.amount, 0) + received);
      if (Math.abs(sum - p.deal_value) > 0.5) throw bad(`Milestones add up to ${sum} ${currency}; the deal value is ${p.deal_value} ${currency}`);
      lines.forEach((l, i) => {
        const c = toUsd(l.amount, currency);
        db.prepare("INSERT INTO payment_schedule (prospect_id, kind, name, percentage, amount, currency, amount_usd, expected_date, sort) VALUES (?, 'milestone', ?, ?, ?, ?, ?, ?, ?)").run(p.id, l.name, l.percentage ?? round2(l.amount / p.deal_value * 100), l.amount, currency, c.amount_usd, l.expected_date, i);
      });
    } else {
      if (!b.retainer) throw bad("Retainer terms are required");
      db.prepare("UPDATE prospects SET retainer_monthly_amount = ?, retainer_billing_day = ?, retainer_start_month = ?, retainer_min_months = ? WHERE id = ?").run(b.retainer.monthly_amount, b.retainer.billing_day, b.retainer.start_month, b.retainer.min_months ?? null, p.id);
      const fresh = db.prepare("SELECT * FROM prospects WHERE id = ?").get(p.id) as any;
      // generate the minimum term (or 3 months) ahead; the monthly job keeps one future month available
      const months = Math.max(b.retainer.min_months ?? 0, 3);
      let ym = b.retainer.start_month;
      for (let i = 0; i < months; i++) { monthLine(fresh, ym, b.retainer.monthly_amount, currency, i); ym = nextMonth(ym); }
    }
    db.prepare("UPDATE prospects SET payment_structure = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(b.structure, req.user.id, p.id);
    logActivity({ prospectId: p.id, userId: req.user.id, type: "schedule_set", detail: `Payment schedule: ${b.structure}` });
  });
  tx();
  res.json({ schedule: scheduleWithStatus(p.id) });
});

scheduleRouter.get("/:id/schedule", (req, res) => {
  const p = db.prepare("SELECT owner_id, partner_id FROM prospects WHERE id = ?").get(Number(req.params.id)) as any;
  if (!p) throw notFound();
  if (!isManagement(req.user) && p.owner_id !== req.user.id && p.partner_id !== req.user.id) throw forbidden();
  res.json({ schedule: scheduleWithStatus(Number(req.params.id)) });
});

/** Keep active retainers topped up with the next month's line. Called by the hourly job. */
export function rollRetainerMonths() {
  const active = db.prepare("SELECT * FROM prospects WHERE after_close_status = 'active_retainer' AND payment_structure = 'monthly' AND retainer_monthly_amount IS NOT NULL").all() as any[];
  const cur = pkDate().slice(0, 7);
  for (const p of active) {
    const last = db.prepare("SELECT MAX(expected_date) d FROM payment_schedule WHERE prospect_id = ? AND kind = 'month'").get(p.id) as any;
    let lastYm = last?.d ? last.d.slice(0, 7) : null;
    let sort = (db.prepare("SELECT COALESCE(MAX(sort),-1) s FROM payment_schedule WHERE prospect_id = ?").get(p.id) as any).s + 1;
    while (!lastYm || lastYm < nextMonth(cur)) {
      const ym = lastYm ? nextMonth(lastYm) : (p.retainer_start_month ?? cur);
      monthLine(p, ym, p.retainer_monthly_amount, p.deal_currency ?? "USD", sort++);
      lastYm = ym;
    }
  }
}
