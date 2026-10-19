import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { isManagement } from "../auth.js";
import { forbidden, notFound } from "../errors.js";
import { notify, audit } from "../log.js";
import { pkDate, rangeFor, isoBounds, weekRange, monthRange, quarterRange, daysBetween, previousRange } from "../time.js";

export const targetsRouter = Router();
export const METRICS = ["activities", "meetings_booked", "meetings_held", "deals_closed", "revenue_usd", "leads_added"] as const;

export function metricValue(metric: string, userId: number, range: { start: string; end: string }): number {
  const b = isoBounds(range);
  const g = (sql: string) => (db.prepare(sql).get(userId, b.from, b.to) as any).v as number;
  switch (metric) {
    case "activities": return g("SELECT COUNT(*) v FROM activities WHERE user_id = ? AND is_outreach = 1 AND occurred_at >= ? AND occurred_at < ?");
    case "meetings_booked": return g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status IN ('booked','held') AND created_at >= ? AND created_at < ?");
    case "meetings_held": return g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status = 'held' AND updated_at >= ? AND updated_at < ?");
    case "deals_closed": return g("SELECT COUNT(*) v FROM prospects WHERE (owner_id = ? ) AND closed_won_at >= ? AND closed_won_at < ?");
    case "revenue_usd": return g("SELECT COALESCE(SUM(deal_value_usd),0) v FROM prospects WHERE owner_id = ? AND closed_won_at >= ? AND closed_won_at < ?");
    case "leads_added": return g("SELECT COUNT(*) v FROM prospects WHERE created_by = ? AND created_at >= ? AND created_at < ?");
    default: return 0;
  }
}

export function periodRange(t: { period: string; custom_start: string | null; custom_end: string | null }, today = pkDate()) {
  if (t.period === "week") return weekRange(today);
  if (t.period === "month") return monthRange(today);
  if (t.period === "quarter") return quarterRange(today);
  return { start: t.custom_start!, end: t.custom_end! };
}

function appliesTo(t: any, userId: number) {
  if (t.scope === "team") return true;
  try { return (JSON.parse(t.user_ids ?? "[]") as number[]).includes(userId); } catch { return false; }
}

/** Cards for a user: current period progress for every target they are on, plus a weekly and monthly clock for each metric. */
export function targetCards(userId: number) {
  const today = pkDate();
  const targets = db.prepare("SELECT * FROM targets WHERE active = 1").all() as any[];
  const cards = [];
  for (const t of targets) {
    if (!appliesTo(t, userId)) continue;
    const r = periodRange(t, today);
    if (today < r.start || today > r.end) continue;
    const done = metricValue(t.metric, userId, r);
    const daysLeft = daysBetween(today, r.end) + 1;
    const remaining = Math.max(0, t.number - done);
    const award = db.prepare("SELECT * FROM target_awards WHERE target_id = ? AND user_id = ? AND period_start = ?").get(t.id, userId, r.start) as any;
    cards.push({ target_id: t.id, name: t.name, metric: t.metric, period: t.period, range: r, number: t.number, done, remaining, days_left: daysLeft, pace_per_day: daysLeft > 0 ? Math.ceil(remaining / daysLeft * 100) / 100 : remaining, bonus_usd: t.bonus_usd, won: !!award || done >= t.number });
  }
  // history: previous 6 periods
  const history = [];
  for (const t of targets) {
    if (!appliesTo(t, userId) || t.period === "custom") continue;
    let r = periodRange(t, today);
    for (let i = 0; i < 6; i++) {
      r = previousRange(r);
      const done = metricValue(t.metric, userId, r);
      history.push({ target_id: t.id, name: t.name, metric: t.metric, period: t.period, range: r, number: t.number, done, hit: done >= t.number, gap: done - t.number });
    }
  }
  return { cards, history };
}

/** Award bonuses for any target hit that has not yet been awarded. Idempotent; run on every today-view load and nightly. */
export function awardTargets() {
  const today = pkDate();
  const targets = db.prepare("SELECT * FROM targets WHERE active = 1").all() as any[];
  const users = db.prepare("SELECT id FROM users WHERE active = 1").all() as { id: number }[];
  for (const t of targets) {
    const r = periodRange(t, today);
    if (today < r.start || today > r.end) continue;
    for (const u of users) {
      if (!appliesTo(t, u.id)) continue;
      const exists = db.prepare("SELECT id FROM target_awards WHERE target_id = ? AND user_id = ? AND period_start = ?").get(t.id, u.id, r.start);
      if (exists) continue;
      const done = metricValue(t.metric, u.id, r);
      if (done >= t.number) {
        const tx = db.transaction(() => {
          let entryId: number | null = null;
          if (t.bonus_usd > 0) {
            const ins = db.prepare("INSERT INTO commission_entries (user_id, kind, model, amount_usd, status, description) VALUES (?, 'bonus', 'target_bonus', ?, 'payable', ?)").run(u.id, t.bonus_usd, `Bonus: ${t.name} (${r.start} to ${r.end})`);
            entryId = Number(ins.lastInsertRowid);
          }
          db.prepare("INSERT INTO target_awards (target_id, user_id, period_start, period_end, achieved_value, commission_entry_id) VALUES (?, ?, ?, ?, ?, ?)").run(t.id, u.id, r.start, r.end, done, entryId);
          notify(u.id, "target_won", `Target won: ${t.name}`, t.bonus_usd > 0 ? `$${t.bonus_usd} bonus added as Payable` : undefined);
        });
        tx();
      }
    }
  }
}

targetsRouter.get("/", (req, res) => {
  if (!isManagement(req.user)) return res.json(targetCards(req.user.id));
  const targets = db.prepare("SELECT t.*, u.name AS created_by_name FROM targets t JOIN users u ON u.id = t.created_by ORDER BY t.active DESC, t.created_at DESC").all() as any[];
  const agents = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role = 'agent'").all() as { id: number; name: string }[];
  const today = pkDate();
  const out = targets.map(t => {
    const r = periodRange(t, today);
    const progress = agents.filter(a => appliesTo(t, a.id)).map(a => ({ user_id: a.id, name: a.name, done: metricValue(t.metric, a.id, r), number: t.number }));
    return { ...t, user_ids: JSON.parse(t.user_ids ?? "[]"), range: r, progress };
  });
  res.json({ targets: out, metrics: METRICS });
});

targetsRouter.post("/", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const body = z.object({ name: z.string().min(1), scope: z.enum(["user", "team"]), user_ids: z.array(z.number()).optional(), metric: z.enum(METRICS), number: z.number().positive(), period: z.enum(["week", "month", "quarter", "custom"]), custom_start: z.string().optional(), custom_end: z.string().optional(), repeat: z.boolean().default(true), bonus_usd: z.number().min(0).default(0) }).parse(req.body);
  const r = db.prepare("INSERT INTO targets (name, scope, user_ids, metric, number, period, custom_start, custom_end, repeat, bonus_usd, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(body.name, body.scope, JSON.stringify(body.user_ids ?? []), body.metric, body.number, body.period, body.custom_start ?? null, body.custom_end ?? null, body.repeat ? 1 : 0, body.bonus_usd, req.user.id);
  audit(req.user.id, "target", Number(r.lastInsertRowid), "create", body);
  res.status(201).json({ id: r.lastInsertRowid });
});

targetsRouter.patch("/:id", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const t = db.prepare("SELECT id FROM targets WHERE id = ?").get(Number(req.params.id));
  if (!t) throw notFound();
  const body = z.object({ active: z.boolean().optional(), number: z.number().optional(), bonus_usd: z.number().optional(), name: z.string().optional() }).parse(req.body);
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) if (v !== undefined) { sets.push(`${k} = ?`); vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v); }
  if (sets.length) db.prepare(`UPDATE targets SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(req.params.id));
  res.json({ ok: true });
});
void rangeFor;
