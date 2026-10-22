import { Router } from "express";
import { z } from "zod";
import { db, getSetting } from "../db.js";
import { isManagement } from "../auth.js";
import { bad, forbidden, notFound } from "../errors.js";
import { audit, logActivity } from "../log.js";
import { toUsd, usdToPkr } from "../fx.js";
import { onPaymentRecorded, onPaymentReversed, payUser } from "../commission.js";
import { rangeFor, isoBounds, previousRange } from "../time.js";
import { metricValue, METRICS } from "./targets.js";

export const paymentsRouter = Router();
export const commissionRouter = Router();

/** Phase 1: simple payment-received entry per deal, recorded by Abdul or Adnan. */
paymentsRouter.post("/", (req, res) => {
  if (!isManagement(req.user)) throw forbidden("Only Abdul or Adnan record payments");
  const body = z.object({ prospect_id: z.number(), amount: z.number().positive(), currency: z.string().default("USD"), received_at: z.string(), label: z.string().optional(), note: z.string().optional(), schedule_id: z.number().optional().nullable() }).parse(req.body);
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(body.prospect_id) as any;
  if (!p) throw notFound("Deal not found");
  if (!p.closed_won_at) throw bad("Payments can only be recorded on an approved Closed won deal");
  if (p.after_close_status === "retainer_finished") throw bad("This retainer is finished");
  const seq = ((db.prepare("SELECT COALESCE(MAX(sequence),0) s FROM payments WHERE prospect_id = ?").get(p.id) as any).s as number) + 1;
  const c = toUsd(body.amount, body.currency, body.received_at.slice(0, 10));
  const line = body.schedule_id ? db.prepare("SELECT * FROM payment_schedule WHERE id = ? AND prospect_id = ?").get(body.schedule_id, p.id) as any : null;
  if (body.schedule_id && !line) throw bad("That scheduled payment does not belong to this deal");
  if (line?.payment_id) throw bad("That scheduled payment is already received");
  const tx = db.transaction(() => {
    const r = db.prepare("INSERT INTO payments (prospect_id, sequence, label, amount, currency, amount_usd, fx_rate_used, fx_fallback, received_at, note, recorded_by, schedule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, seq, body.label ?? line?.name ?? (seq === 1 ? "First payment" : `Payment ${seq}`), body.amount, body.currency.toUpperCase(), c.amount_usd, c.rate, c.fallback ? 1 : 0, body.received_at, body.note ?? null, req.user.id, line?.id ?? null);
    if (line) {
      db.prepare("UPDATE payment_schedule SET payment_id = ? WHERE id = ?").run(Number(r.lastInsertRowid), line.id);
      db.prepare("UPDATE documents SET status = 'paid' WHERE schedule_id = ? AND status IN ('sent','accepted')").run(line.id);
    }
    onPaymentRecorded(Number(r.lastInsertRowid));
    logActivity({ prospectId: p.id, userId: req.user.id, type: "payment_received", detail: `${body.amount} ${body.currency.toUpperCase()} ($${c.amount_usd}) ${c.fallback ? "[fallback rate]" : ""}` });
    res.status(201).json({ id: r.lastInsertRowid, amount_usd: c.amount_usd, fx_fallback: c.fallback });
  });
  tx();
});

paymentsRouter.post("/:id/reverse", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const pay = db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(req.params.id)) as any;
  if (!pay) throw notFound();
  if (pay.reversed_at) throw bad("Already reversed");
  const body = z.object({ reason: z.string().min(1) }).parse(req.body);
  const windowDays = Number(getSetting("clawback_days") ?? 30);
  const ageDays = Math.floor((Date.now() - new Date(pay.received_at).getTime()) / 86400000);
  const tx = db.transaction(() => {
    db.prepare("UPDATE payments SET reversed_at = datetime('now'), reversed_by = ?, note = COALESCE(note || ' | ', '') || ? WHERE id = ?").run(req.user.id, `Reversed: ${body.reason}`, pay.id);
    db.prepare("UPDATE payment_schedule SET payment_id = NULL WHERE payment_id = ?").run(pay.id);
    onPaymentReversed(pay.id);
    logActivity({ prospectId: pay.prospect_id, userId: req.user.id, type: "payment_reversed", detail: `${body.reason} (${ageDays}d after receipt, window ${windowDays}d)` });
    audit(req.user.id, "payment", pay.id, "reverse", { reason: body.reason, age_days: ageDays, outside_window: ageDays > windowDays });
  });
  tx();
  res.json({ ok: true, outside_window: ageDays > windowDays });
});

/* ---- Commission views ---- */
commissionRouter.get("/mine", (req, res) => {
  const uid = req.user.id;
  const entries = db.prepare("SELECT c.*, p.company FROM commission_entries c LEFT JOIN prospects p ON p.id = c.prospect_id WHERE c.user_id = ? ORDER BY c.created_at DESC").all(uid);
  const m = isoBounds(rangeFor("month"));
  const sum = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as any).s as number;
  res.json({
    entries,
    totals: {
      pending: sum("SELECT COALESCE(SUM(amount_usd),0) s FROM commission_entries WHERE user_id = ? AND status = 'pending'", uid),
      payable: sum("SELECT COALESCE(SUM(amount_usd),0) s FROM commission_entries WHERE user_id = ? AND status = 'payable'", uid),
      paid_this_month: sum("SELECT COALESCE(SUM(paid_amount_usd),0) s FROM commission_entries WHERE user_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?", uid, m.from, m.to),
      paid_all_time: sum("SELECT COALESCE(SUM(paid_amount_usd),0) s FROM commission_entries WHERE user_id = ? AND status = 'paid'", uid),
    },
    profile: { model: req.user.commission_model, rate: req.user.commission_rate },
  });
});

commissionRouter.get("/payouts", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const m = isoBounds(rangeFor("month"));
  const rows = db.prepare(`
    SELECT u.id, u.name, u.role, u.commission_model, u.commission_rate,
      COALESCE(SUM(CASE WHEN c.status='payable' AND c.frozen=0 THEN c.amount_usd END),0) AS payable,
      COALESCE(SUM(CASE WHEN c.status='payable' AND c.frozen=1 THEN c.amount_usd END),0) AS frozen,
      COALESCE(SUM(CASE WHEN c.status='pending' THEN c.amount_usd END),0) AS pending,
      COALESCE(SUM(CASE WHEN c.status='paid' AND c.paid_at >= ? AND c.paid_at < ? THEN c.paid_amount_usd END),0) AS paid_this_month
    FROM users u LEFT JOIN commission_entries c ON c.user_id = u.id
    WHERE u.role != 'owner' AND (u.role = 'agent' OR EXISTS (SELECT 1 FROM commission_entries x WHERE x.user_id = u.id))
    GROUP BY u.id ORDER BY payable DESC, u.name`).all(m.from, m.to);
  const entries = db.prepare("SELECT c.*, u.name AS user_name, p.company FROM commission_entries c JOIN users u ON u.id = c.user_id LEFT JOIN prospects p ON p.id = c.prospect_id WHERE c.status IN ('payable','pending') ORDER BY c.user_id, c.created_at").all();
  res.json({ people: rows, open_entries: entries });
});

commissionRouter.post("/payouts/:userId/pay", (req, res) => {
  if (req.user.role !== "owner") throw forbidden("Only Abdul approves payouts");
  const body = z.object({ note: z.string().optional() }).parse(req.body ?? {});
  const result = payUser(Number(req.params.userId), req.user.id, body.note);
  audit(req.user.id, "payout", Number(req.params.userId), "pay", result);
  res.json(result);
});

/** Reassignment: decide a frozen pending entry. */
commissionRouter.post("/entries/:id/decide", (req, res) => {
  if (req.user.role !== "owner") throw forbidden();
  const e = db.prepare("SELECT * FROM commission_entries WHERE id = ?").get(Number(req.params.id)) as any;
  if (!e) throw notFound();
  const body = z.object({ decision: z.enum(["keep", "transfer", "cancel"]), new_user_id: z.number().optional() }).parse(req.body);
  if (body.decision === "keep") db.prepare("UPDATE commission_entries SET frozen = 0, updated_at = datetime('now') WHERE id = ?").run(e.id);
  if (body.decision === "cancel") db.prepare("UPDATE commission_entries SET frozen = 0, status = 'reversed', updated_at = datetime('now') WHERE id = ?").run(e.id);
  if (body.decision === "transfer") {
    if (!body.new_user_id) throw bad("Pick who receives it");
    db.prepare("UPDATE commission_entries SET frozen = 0, user_id = ?, description = description || ' (transferred)', updated_at = datetime('now') WHERE id = ?").run(body.new_user_id, e.id);
  }
  audit(req.user.id, "commission_entry", e.id, "decide", body);
  res.json({ ok: true });
});

/* ---- Leaderboards ---- */
export const leaderboardRouter = Router();
leaderboardRouter.get("/", (req, res) => {
  const period = String(req.query.period ?? "month");
  const r = rangeFor(period); const b = isoBounds(r);
  const prev = period === "all" ? null : isoBounds(previousOf(r));
  const agents = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role = 'agent' ORDER BY name").all() as { id: number; name: string }[];
  const meetings = (uid: number, bb: { from: string; to: string }) => (db.prepare("SELECT COUNT(*) c FROM meetings WHERE credited_to = ? AND status IN ('booked','held') AND created_at >= ? AND created_at < ?").get(uid, bb.from, bb.to) as any).c as number;
  const commission = (uid: number, bb: { from: string; to: string }) => (db.prepare("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN paid_amount_usd ELSE amount_usd END),0) s FROM commission_entries WHERE user_id = ? AND kind IN ('sales','true_up','clawback') AND status IN ('payable','paid') AND created_at >= ? AND created_at < ?").get(uid, bb.from, bb.to) as any).s as number;
  const rank = (rows: { id: number; name: string; total: number; previous: number | null }[]) => rows.sort((a, b2) => b2.total - a.total).map((x, i) => ({ rank: i + 1, ...x, is_me: x.id === req.user.id, badge: period === "month" && i < 3 ? ["gold", "silver", "bronze"][i] : null }));
  const custom = (db.prepare("SELECT * FROM leaderboards WHERE active = 1 ORDER BY id").all() as any[]).map(lb => ({
    id: lb.id, name: lb.name, metric: lb.metric,
    rows: rank(agents.map(a => ({ id: a.id, name: a.name, total: metricValue(lb.metric, a.id, r), previous: prev ? metricValue(lb.metric, a.id, previousOf(r)) : null }))),
  }));
  res.json({
    period, range: r,
    meetings: rank(agents.map(a => ({ id: a.id, name: a.name, total: meetings(a.id, b), previous: prev ? meetings(a.id, prev) : null }))),
    commission: rank(agents.map(a => { const t = commission(a.id, b); return { id: a.id, name: a.name, total: t, total_pkr: usdToPkr(t), previous: prev ? commission(a.id, prev) : null }; })),
    custom,
  });
});
/** Abdul adds a board on any metric the CRM already counts, without new development. */
leaderboardRouter.get("/custom", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  res.json({ boards: db.prepare("SELECT * FROM leaderboards ORDER BY id").all(), metrics: METRICS });
});
leaderboardRouter.post("/custom", (req, res) => {
  if (req.user.role !== "owner") throw forbidden();
  const b = z.object({ name: z.string().min(1), metric: z.enum(METRICS) }).parse(req.body);
  const r = db.prepare("INSERT INTO leaderboards (name, metric, created_by) VALUES (?, ?, ?)").run(b.name, b.metric, req.user.id);
  audit(req.user.id, "leaderboard", Number(r.lastInsertRowid), "create", b);
  res.status(201).json({ id: r.lastInsertRowid });
});
leaderboardRouter.patch("/custom/:id", (req, res) => {
  if (req.user.role !== "owner") throw forbidden();
  const b = z.object({ active: z.boolean().optional(), name: z.string().optional() }).parse(req.body);
  if (b.active !== undefined) db.prepare("UPDATE leaderboards SET active = ? WHERE id = ?").run(b.active ? 1 : 0, Number(req.params.id));
  if (b.name) db.prepare("UPDATE leaderboards SET name = ? WHERE id = ?").run(b.name, Number(req.params.id));
  res.json({ ok: true });
});
const previousOf = previousRange;
