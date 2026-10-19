import { Router } from "express";
import { z } from "zod";
import { db, getSetting } from "../db.js";
import { isManagement } from "../auth.js";
import { forbidden } from "../errors.js";
import { pkDate, addDays, weekRange, monthRange, isoBounds, daysBetween } from "../time.js";
import { targetCards, awardTargets, metricValue } from "./targets.js";
import { usdToPkr } from "../fx.js";

export const todayRouter = Router();

/** Flag Cold (day 14 passed with no reply) and overdue In-delivery deals. Cheap, run on each load. */
function housekeeping() {
  const today = pkDate();
  db.prepare(`UPDATE prospects SET is_cold = 1 WHERE stage = 'contacted' AND is_cold = 0 AND contacted_at IS NOT NULL AND date(contacted_at, '+5 hours') <= date(?, '-14 days')`).run(today);
}

export function buildToday(userId: number) {
  awardTargets();
  housekeeping();
  const today = pkDate();
  const wk = weekRange(today), mo = monthRange(today);
  const wkB = isoBounds(wk), moB = isoBounds(mo);
  const mine = "(p.owner_id = ? OR p.partner_id = ?)";
  const overdueFollowUps = db.prepare(`SELECT f.id AS follow_up_id, f.due_date, f.kind, p.id AS prospect_id, p.company, p.contact_name, p.stage, p.phone, p.email, p.is_cold FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE ${mine} AND f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost') ORDER BY f.due_date`).all(userId, userId, today) as any[];
  const noDate = db.prepare(`SELECT p.id AS prospect_id, p.company, p.contact_name, p.stage, p.phone, p.email, p.is_cold FROM prospects p WHERE ${mine} AND p.stage NOT IN ('closed_won','closed_lost') AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.prospect_id = p.id AND f.done_at IS NULL) ORDER BY p.updated_at`).all(userId, userId) as any[];
  const overdueTasks = db.prepare("SELECT t.*, p.company FROM tasks t LEFT JOIN prospects p ON p.id = t.prospect_id WHERE t.assigned_to = ? AND t.status IN ('open','in_progress','blocked') AND t.due_date < ? ORDER BY t.due_date").all(userId, today);
  const dueToday = db.prepare(`SELECT f.id AS follow_up_id, f.due_date, f.kind, p.id AS prospect_id, p.company, p.contact_name, p.stage, p.phone, p.email, p.is_cold FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE ${mine} AND f.done_at IS NULL AND f.due_date = ? AND p.stage NOT IN ('closed_won','closed_lost')`).all(userId, userId, today);
  const tasksToday = db.prepare("SELECT t.*, p.company FROM tasks t LEFT JOIN prospects p ON p.id = t.prospect_id WHERE t.assigned_to = ? AND t.status IN ('open','in_progress','blocked') AND t.due_date = ?").all(userId, today);
  const tb = isoBounds({ start: today, end: today });
  const meetingsToday = db.prepare("SELECT m.*, p.company, p.contact_name FROM meetings m JOIN prospects p ON p.id = m.prospect_id WHERE m.credited_to = ? AND m.status = 'booked' AND m.scheduled_at >= ? AND m.scheduled_at < ? ORDER BY m.scheduled_at").all(userId, tb.from, tb.to);
  const meetingsWeek = db.prepare("SELECT m.*, p.company, p.contact_name FROM meetings m JOIN prospects p ON p.id = m.prospect_id WHERE m.credited_to = ? AND m.status = 'booked' AND m.scheduled_at >= ? AND m.scheduled_at < ? ORDER BY m.scheduled_at").all(userId, tb.from, isoBounds(wk).to);
  const openTasks = db.prepare("SELECT t.*, p.company, b.name AS assigned_by_name FROM tasks t LEFT JOIN prospects p ON p.id = t.prospect_id JOIN users b ON b.id = t.assigned_by WHERE t.assigned_to = ? AND t.status IN ('open','in_progress','blocked') ORDER BY t.due_date").all(userId);
  const pipeline = db.prepare(`SELECT stage, COUNT(*) AS count, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p WHERE ${mine} GROUP BY stage`).all(userId, userId);
  const chases = db.prepare(`SELECT p.id AS prospect_id, p.company, p.proposal_sent_at, p.deal_value_usd FROM prospects p WHERE ${mine} AND p.stage = 'proposal_sent' AND date(p.proposal_sent_at) <= date(?, '-' || ? || ' days')`).all(userId, userId, today, Number(getSetting("proposal_chase_days") ?? 5));
  const deliveryOverdue = db.prepare(`SELECT p.id AS prospect_id, p.company, p.expected_delivery_date FROM prospects p WHERE ${mine} AND p.after_close_status = 'in_delivery' AND p.expected_delivery_date IS NOT NULL AND p.expected_delivery_date < ?`).all(userId, userId, today);
  const pendingApproval = db.prepare(`SELECT p.id AS prospect_id, p.company, p.deal_value_usd FROM prospects p WHERE ${mine} AND p.stage = 'closed_won' AND p.closed_won_at IS NULL`).all(userId, userId);
  const nums = (r: { start: string; end: string }) => {
    const b = isoBounds(r);
    const g = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as any).v as number;
    return {
      leads_added: metricValue("leads_added", userId, r),
      prospects_reached: g("SELECT COUNT(DISTINCT prospect_id) v FROM activities WHERE user_id = ? AND is_outreach = 1 AND occurred_at >= ? AND occurred_at < ?", userId, b.from, b.to),
      activities: metricValue("activities", userId, r),
      meetings_booked: metricValue("meetings_booked", userId, r),
      meetings_held: metricValue("meetings_held", userId, r),
      deals_closed: metricValue("deals_closed", userId, r),
      revenue_usd: metricValue("revenue_usd", userId, r),
      commission_earned: g("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN paid_amount_usd ELSE amount_usd END),0) v FROM commission_entries WHERE user_id = ? AND status IN ('payable','paid') AND created_at >= ? AND created_at < ?", userId, b.from, b.to),
    };
  };
  const targets = targetCards(userId);
  const commissionDue = (db.prepare("SELECT COALESCE(SUM(amount_usd),0) v FROM commission_entries WHERE user_id = ? AND status = 'payable'").get(userId) as any).v;
  const eod = db.prepare("SELECT note FROM eod_reports WHERE user_id = ? AND report_date = ?").get(userId, today);
  const notifications = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 20").all(userId);
  const activitiesToday = (db.prepare("SELECT COUNT(*) v FROM activities WHERE user_id = ? AND is_outreach = 1 AND occurred_at >= ? AND occurred_at < ?").get(userId, tb.from, tb.to) as any).v;
  return {
    today, week: wk, month: mo,
    overdue: { follow_ups: overdueFollowUps, no_date: noDate, tasks: overdueTasks, chases, delivery: deliveryOverdue },
    due_today: { follow_ups: dueToday, tasks: tasksToday, meetings: meetingsToday },
    meetings_week: meetingsWeek,
    tasks: openTasks,
    pipeline,
    pending_approval: pendingApproval,
    numbers: { week: nums(wk), month: mos(nums, mo), commission_due: commissionDue, activities_today: activitiesToday, daily_min: Number(getSetting("daily_min_activities") ?? 30), days_left_week: daysBetween(today, wk.end) + 1, days_left_month: daysBetween(today, mo.end) + 1 },
    targets,
    eod_done: !!eod,
    notifications,
  };
}
const mos = (f: (r: { start: string; end: string }) => any, r: { start: string; end: string }) => f(r);

todayRouter.get("/", (req, res) => {
  const t = buildToday(req.user.id);
  const lb = leaderboardPosition(req.user.id);
  res.json({ ...t, leaderboard: lb });
});

function leaderboardPosition(userId: number) {
  const mo = isoBounds(monthRange(pkDate()));
  const agents = db.prepare("SELECT id, name FROM users WHERE active = 1 AND role = 'agent'").all() as { id: number; name: string }[];
  const mt = agents.map(a => ({ ...a, total: (db.prepare("SELECT COUNT(*) c FROM meetings WHERE credited_to = ? AND status IN ('booked','held') AND created_at >= ? AND created_at < ?").get(a.id, mo.from, mo.to) as any).c })).sort((a, b) => b.total - a.total);
  const ct = agents.map(a => ({ ...a, total: (db.prepare("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN paid_amount_usd ELSE amount_usd END),0) s FROM commission_entries WHERE user_id = ? AND kind IN ('sales','true_up','clawback') AND status IN ('payable','paid') AND created_at >= ? AND created_at < ?").get(a.id, mo.from, mo.to) as any).s })).sort((a, b) => b.total - a.total);
  const pos = (list: { id: number; name: string; total: number }[]) => { const i = list.findIndex(x => x.id === userId); return { rank: i + 1, of: list.length, above: i > 0 ? list[i - 1] : null, total: i >= 0 ? list[i].total : 0 }; };
  const c = pos(ct);
  return { meetings: pos(mt), commission: { ...c, total_pkr: usdToPkr(c.total) } };
}

/* ---- End of day report ---- */
todayRouter.post("/eod", (req, res) => {
  const body = z.object({ note: z.string().min(1), report_date: z.string().optional() }).parse(req.body);
  const d = body.report_date ?? pkDate();
  db.prepare("INSERT INTO eod_reports (user_id, report_date, note) VALUES (?, ?, ?) ON CONFLICT(user_id, report_date) DO UPDATE SET note = excluded.note").run(req.user.id, d, body.note);
  res.json({ ok: true });
});

todayRouter.post("/notifications/read", (req, res) => {
  const body = z.object({ ids: z.array(z.number()).optional() }).parse(req.body ?? {});
  if (body.ids?.length) db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id IN (${body.ids.map(() => "?").join(",")})`).run(req.user.id, ...body.ids);
  else db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true });
});

/* ---- Team overview (Abdul / Adnan) ---- */
todayRouter.get("/team", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  awardTargets(); housekeeping();
  const today = pkDate();
  const tb = isoBounds({ start: today, end: today });
  const wk = isoBounds(weekRange(today));
  const mo = isoBounds(monthRange(today));
  const alertDays = Number(getSetting("overdue_alert_days") ?? 2);
  const agents = db.prepare("SELECT id, name, last_login_at FROM users WHERE active = 1 AND role = 'agent' ORDER BY name").all() as any[];
  const g = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as any).v as number;
  const people = agents.map(a => ({
    ...a,
    activities_today: g("SELECT COUNT(*) v FROM activities WHERE user_id = ? AND is_outreach = 1 AND occurred_at >= ? AND occurred_at < ?", a.id, tb.from, tb.to),
    activities_week: g("SELECT COUNT(*) v FROM activities WHERE user_id = ? AND is_outreach = 1 AND occurred_at >= ? AND occurred_at < ?", a.id, wk.from, wk.to),
    open_tasks: g("SELECT COUNT(*) v FROM tasks WHERE assigned_to = ? AND status IN ('open','in_progress','blocked')", a.id),
    overdue_tasks: g("SELECT COUNT(*) v FROM tasks WHERE assigned_to = ? AND status IN ('open','in_progress','blocked') AND due_date < ?", a.id, today),
    overdue_follow_ups: g("SELECT COUNT(*) v FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE p.owner_id = ? AND f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost')", a.id, today),
    overdue_2d: g("SELECT COUNT(*) v FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE p.owner_id = ? AND f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost')", a.id, addDays(today, -alertDays)),
    no_date: g("SELECT COUNT(*) v FROM prospects p WHERE p.owner_id = ? AND p.stage NOT IN ('closed_won','closed_lost') AND NOT EXISTS (SELECT 1 FROM follow_ups f WHERE f.prospect_id = p.id AND f.done_at IS NULL)", a.id),
    meetings_booked_month: g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status IN ('booked','held') AND created_at >= ? AND created_at < ?", a.id, mo.from, mo.to),
    meetings_held_month: g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status = 'held' AND created_at >= ? AND created_at < ?", a.id, mo.from, mo.to),
    no_shows_month: g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status = 'no_show' AND created_at >= ? AND created_at < ?", a.id, mo.from, mo.to),
    eod_today: !!db.prepare("SELECT 1 FROM eod_reports WHERE user_id = ? AND report_date = ?").get(a.id, today),
    eod_gaps_week: 0,
  }));
  for (const p of people) {
    const { start } = weekRange(today); let gaps = 0;
    for (let d = start; d < today; d = addDays(d, 1)) if (!db.prepare("SELECT 1 FROM eod_reports WHERE user_id = ? AND report_date = ?").get(p.id, d)) gaps++;
    p.eod_gaps_week = gaps;
  }
  const overdueAll = db.prepare("SELECT f.due_date, f.kind, p.id AS prospect_id, p.company, p.stage, u.name AS owner_name FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id LEFT JOIN users u ON u.id = p.owner_id WHERE f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost') ORDER BY f.due_date LIMIT 200").all(today);
  const proposals = db.prepare("SELECT p.id AS prospect_id, p.company, p.deal_value_usd, p.proposal_sent_at, u.name AS owner_name, CAST(julianday(?) - julianday(date(p.proposal_sent_at)) AS INTEGER) AS age_days FROM prospects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.stage = 'proposal_sent' ORDER BY age_days DESC").all(today);
  const approvals = db.prepare("SELECT p.id AS prospect_id, p.company, p.deal_value_usd, p.payment_terms, u.name AS owner_name, p.closed_won_requested_at FROM prospects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.stage = 'closed_won' AND p.closed_won_at IS NULL").all();
  const partnerRequests = db.prepare("SELECT r.*, p.company, u.name AS requester_name, o.name AS owner_name FROM partner_requests r JOIN prospects p ON p.id = r.prospect_id JOIN users u ON u.id = r.requester_id LEFT JOIN users o ON o.id = p.owner_id WHERE r.status = 'pending'").all();
  const unassigned = g("SELECT COUNT(*) v FROM prospects WHERE owner_id IS NULL");
  const deliveryOverdue = db.prepare("SELECT p.id AS prospect_id, p.company, p.expected_delivery_date, u.name AS owner_name FROM prospects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.after_close_status = 'in_delivery' AND p.expected_delivery_date < ?").all(today);
  const unpaidRetainers = db.prepare("SELECT p.id AS prospect_id, p.company, u.name AS owner_name FROM prospects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.after_close_status = 'active_retainer' AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.prospect_id = p.id AND pay.reversed_at IS NULL AND pay.received_at >= ? AND pay.received_at < ?)").all(mo.from, mo.to);
  const meetingsToday = db.prepare("SELECT m.*, p.company, u.name AS credited_name FROM meetings m JOIN prospects p ON p.id = m.prospect_id JOIN users u ON u.id = m.credited_to WHERE m.status = 'booked' AND m.scheduled_at >= ? AND m.scheduled_at < ? ORDER BY m.scheduled_at").all(tb.from, tb.to);
  const pipeline = db.prepare("SELECT stage, COUNT(*) AS count, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects GROUP BY stage").all();
  const eodLog = db.prepare("SELECT e.*, u.name FROM eod_reports e JOIN users u ON u.id = e.user_id WHERE e.report_date >= ? ORDER BY e.report_date DESC, u.name").all(addDays(today, -7));
  const notifications = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 30").all(req.user.id);
  res.json({ today, people, overdue_all: overdueAll, proposals, approvals, partner_requests: partnerRequests, unassigned, delivery_overdue: deliveryOverdue, unpaid_retainers: unpaidRetainers, meetings_today: meetingsToday, pipeline, eod_log: eodLog, notifications, daily_min: Number(getSetting("daily_min_activities") ?? 30) });
});
