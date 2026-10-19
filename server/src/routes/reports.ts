import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { isManagement } from "../auth.js";
import { bad, forbidden } from "../errors.js";
import { audit, logActivity, notify } from "../log.js";
import { pkDate, monthRange, previousRange, isoBounds, addDays } from "../time.js";
import { findDuplicates, normaliseDomain, normalisePhone, SOURCES, SERVICES } from "./prospects.js";

export const reportsRouter = Router();
reportsRouter.use((req, _res, next) => { if (!isManagement(req.user)) return next(forbidden()); next(); });

function filters(q: Record<string, string>) {
  const where: string[] = ["1=1"]; const params: unknown[] = [];
  if (q.owner_id) { where.push("p.owner_id = ?"); params.push(Number(q.owner_id)); }
  if (q.service) { where.push("p.service_interest = ?"); params.push(q.service); }
  if (q.source) { where.push("p.source = ?"); params.push(q.source); }
  if (q.campaign) { where.push("p.campaign_tag = ?"); params.push(q.campaign); }
  const from = q.from ?? addDays(pkDate(), -90), to = q.to ?? pkDate();
  return { where: where.join(" AND "), params, from, to, b: isoBounds({ start: from, end: to }) };
}

reportsRouter.get("/pipeline", (req, res) => {
  const f = filters(req.query as any);
  const now = db.prepare(`SELECT stage, COUNT(*) AS count, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p WHERE ${f.where} GROUP BY stage`).all(...f.params);
  const lastMonth = isoBounds(previousRange(monthRange(pkDate())));
  // stage at end of last month approximated by stage_change activities
  const prev = db.prepare(`SELECT stage, COUNT(*) AS count, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p WHERE ${f.where} AND p.created_at < ? GROUP BY stage`).all(...f.params, lastMonth.to);
  res.json({ now, previous_month_snapshot: prev });
});

reportsRouter.get("/funnel", (req, res) => {
  const f = filters(req.query as any);
  const by = (req.query as any).by === "source" ? "p.source" : "o.name";
  const rows = db.prepare(`
    SELECT ${by} AS grp, COUNT(*) AS leads,
      SUM(CASE WHEN p.contacted_at IS NOT NULL OR p.stage NOT IN ('new_lead') THEN 1 ELSE 0 END) AS contacted,
      SUM(CASE WHEN p.stage IN ('replied','meeting_booked','meeting_held','proposal_sent','negotiation','closed_won') OR EXISTS (SELECT 1 FROM activities a WHERE a.prospect_id = p.id AND a.type='stage_change' AND a.detail LIKE '%→ replied%') THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id) THEN 1 ELSE 0 END) AS meeting,
      SUM(CASE WHEN p.proposal_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS proposal,
      SUM(CASE WHEN p.closed_won_at IS NOT NULL THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN p.stage = 'closed_lost' THEN 1 ELSE 0 END) AS lost
    FROM prospects p LEFT JOIN users o ON o.id = p.owner_id
    WHERE ${f.where} AND p.created_at >= ? AND p.created_at < ? GROUP BY grp ORDER BY leads DESC`).all(...f.params, f.b.from, f.b.to);
  res.json(rows);
});

reportsRouter.get("/revenue", (req, res) => {
  const f = filters(req.query as any);
  const byMonth = db.prepare(`SELECT substr(closed_won_at,1,7) AS month, COUNT(*) AS deals, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p WHERE ${f.where} AND closed_won_at IS NOT NULL GROUP BY month ORDER BY month`).all(...f.params);
  const byService = db.prepare(`SELECT service_interest AS service, COUNT(*) AS deals, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p WHERE ${f.where} AND closed_won_at IS NOT NULL GROUP BY service ORDER BY value_usd DESC`).all(...f.params);
  const byAgent = db.prepare(`SELECT o.name AS agent, COUNT(*) AS deals, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p LEFT JOIN users o ON o.id = p.owner_id WHERE ${f.where} AND closed_won_at IS NOT NULL GROUP BY o.id ORDER BY value_usd DESC`).all(...f.params);
  const expected = (db.prepare(`SELECT COALESCE(SUM(deal_value_usd),0) v FROM prospects p WHERE ${f.where} AND closed_won_at IS NOT NULL AND engagement_model = 'one_off_project'`).get(...f.params) as any).v;
  const received = (db.prepare(`SELECT COALESCE(SUM(pay.amount_usd),0) v FROM payments pay JOIN prospects p ON p.id = pay.prospect_id WHERE ${f.where} AND pay.reversed_at IS NULL`).get(...f.params) as any).v;
  const outstanding = db.prepare(`SELECT p.id, p.company, o.name AS owner_name, p.deal_value_usd, COALESCE((SELECT SUM(amount_usd) FROM payments pay WHERE pay.prospect_id = p.id AND pay.reversed_at IS NULL),0) AS received_usd FROM prospects p LEFT JOIN users o ON o.id = p.owner_id WHERE ${f.where} AND p.closed_won_at IS NOT NULL AND p.engagement_model = 'one_off_project' AND p.after_close_status != 'retainer_finished'`).all(...f.params) as any[];
  res.json({ by_month: byMonth, by_service: byService, by_agent: byAgent, expected_usd: expected, received_usd: received, outstanding: outstanding.map(o => ({ ...o, balance_usd: Math.round(((o.deal_value_usd ?? 0) - o.received_usd) * 100) / 100 })).filter(o => o.balance_usd > 0) });
});

reportsRouter.get("/team", (req, res) => {
  const f = filters(req.query as any);
  const agents = db.prepare("SELECT id, name FROM users WHERE role = 'agent' ORDER BY name").all() as any[];
  const g = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as any).v as number;
  const today = pkDate();
  res.json(agents.map(a => {
    const won = g("SELECT COUNT(*) v FROM prospects WHERE owner_id = ? AND closed_won_at >= ? AND closed_won_at < ?", a.id, f.b.from, f.b.to);
    const lost = g("SELECT COUNT(*) v FROM prospects WHERE owner_id = ? AND closed_lost_at >= ? AND closed_lost_at < ?", a.id, f.b.from, f.b.to);
    const value = g("SELECT COALESCE(SUM(deal_value_usd),0) v FROM prospects WHERE owner_id = ? AND closed_won_at >= ? AND closed_won_at < ?", a.id, f.b.from, f.b.to);
    return {
      id: a.id, name: a.name,
      leads_added: g("SELECT COUNT(*) v FROM prospects WHERE created_by = ? AND created_at >= ? AND created_at < ?", a.id, f.b.from, f.b.to),
      activities: g("SELECT COUNT(*) v FROM activities WHERE user_id = ? AND is_outreach = 1 AND occurred_at >= ? AND occurred_at < ?", a.id, f.b.from, f.b.to),
      meetings_booked: g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status IN ('booked','held') AND created_at >= ? AND created_at < ?", a.id, f.b.from, f.b.to),
      meetings_held: g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status = 'held' AND created_at >= ? AND created_at < ?", a.id, f.b.from, f.b.to),
      no_shows: g("SELECT COUNT(*) v FROM meetings WHERE credited_to = ? AND status = 'no_show' AND created_at >= ? AND created_at < ?", a.id, f.b.from, f.b.to),
      deals_closed: won, deals_lost: lost, close_rate: won + lost ? Math.round(won / (won + lost) * 100) : null,
      avg_deal_usd: won ? Math.round(value / won) : 0, revenue_usd: value,
      commission_earned: g("SELECT COALESCE(SUM(CASE WHEN status='paid' THEN paid_amount_usd ELSE amount_usd END),0) v FROM commission_entries WHERE user_id = ? AND status IN ('payable','paid') AND created_at >= ? AND created_at < ?", a.id, f.b.from, f.b.to),
      overdue_items: g("SELECT COUNT(*) v FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE p.owner_id = ? AND f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost')", a.id, today)
        + g("SELECT COUNT(*) v FROM tasks WHERE assigned_to = ? AND status IN ('open','in_progress','blocked') AND due_date < ?", a.id, today),
    };
  }));
});

reportsRouter.get("/delivery", (_req, res) => {
  const mo = isoBounds(monthRange(pkDate()));
  res.json({
    in_delivery: db.prepare("SELECT p.id, p.company, o.name AS owner_name, p.deal_value_usd, p.expected_delivery_date, p.closed_won_at FROM prospects p LEFT JOIN users o ON o.id = p.owner_id WHERE after_close_status = 'in_delivery'").all(),
    delivered_this_month: db.prepare("SELECT p.id, p.company, o.name AS owner_name, p.deal_value_usd, p.delivered_at FROM prospects p LEFT JOIN users o ON o.id = p.owner_id WHERE after_close_status = 'project_delivered' AND delivered_at >= ? AND delivered_at <= ?").all(mo.from.slice(0, 10), mo.to.slice(0, 10)),
    active_retainers: db.prepare("SELECT p.id, p.company, o.name AS owner_name, p.deal_value_usd, p.closed_won_at, (SELECT COUNT(*) FROM payments pay WHERE pay.prospect_id = p.id AND pay.reversed_at IS NULL) AS payments_logged, (SELECT MAX(received_at) FROM payments pay WHERE pay.prospect_id = p.id AND pay.reversed_at IS NULL) AS last_payment FROM prospects p LEFT JOIN users o ON o.id = p.owner_id WHERE after_close_status = 'active_retainer'").all(),
    finished_retainers: db.prepare("SELECT p.id, p.company, o.name AS owner_name, p.retainer_finished_at FROM prospects p LEFT JOIN users o ON o.id = p.owner_id WHERE after_close_status = 'retainer_finished' ORDER BY retainer_finished_at DESC LIMIT 50").all(),
  });
});

reportsRouter.get("/lost", (req, res) => {
  const f = filters(req.query as any);
  res.json(db.prepare(`SELECT lost_reason, COUNT(*) AS count, COALESCE(SUM(deal_value_usd),0) AS value_usd FROM prospects p WHERE ${f.where} AND stage = 'closed_lost' AND closed_lost_at >= ? AND closed_lost_at < ? GROUP BY lost_reason ORDER BY count DESC`).all(...f.params, f.b.from, f.b.to));
});

reportsRouter.get("/campaigns", (req, res) => {
  const f = filters(req.query as any);
  res.json(db.prepare(`SELECT COALESCE(campaign_tag,'(none)') AS campaign, COUNT(*) AS leads, SUM(CASE WHEN EXISTS (SELECT 1 FROM meetings m WHERE m.prospect_id = p.id) THEN 1 ELSE 0 END) AS meetings, SUM(CASE WHEN closed_won_at IS NOT NULL THEN 1 ELSE 0 END) AS won, SUM(CASE WHEN stage='closed_lost' THEN 1 ELSE 0 END) AS lost FROM prospects p WHERE ${f.where} GROUP BY campaign ORDER BY leads DESC`).all(...f.params));
});

reportsRouter.get("/activity", (req, res) => {
  const f = filters(req.query as any);
  res.json({
    by_day: db.prepare("SELECT substr(datetime(occurred_at, '+5 hours'),1,10) AS day, u.name, COUNT(*) AS activities, SUM(is_outreach) AS outreach FROM activities a JOIN users u ON u.id = a.user_id WHERE occurred_at >= ? AND occurred_at < ? GROUP BY day, u.id ORDER BY day DESC, u.name").all(f.b.from, f.b.to),
    logins: db.prepare("SELECT substr(datetime(created_at, '+5 hours'),1,10) AS day, u.name, COUNT(*) AS logins FROM audit_log l JOIN users u ON u.id = l.user_id WHERE action = 'login' AND created_at >= ? AND created_at < ? GROUP BY day, u.id ORDER BY day DESC").all(f.b.from, f.b.to),
  });
});

/* ---- Export (CSV) ---- */
function csv(rows: any[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}
reportsRouter.get("/export/:what", (req, res) => {
  const what = req.params.what;
  let rows: any[] = [];
  if (what === "prospects") rows = db.prepare("SELECT p.id, p.company, p.contact_name, p.email, p.phone, p.website, p.country, p.source, p.service_interest, p.campaign_tag, o.name AS owner, pa.name AS partner, p.stage, p.next_follow_up, p.deal_value, p.deal_currency, p.deal_value_usd, p.engagement_model, p.payment_terms, p.lost_reason, p.after_close_status, p.created_at, p.updated_at FROM prospects p LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN users pa ON pa.id = p.partner_id ORDER BY p.id").all();
  else if (what === "commission") rows = db.prepare("SELECT c.id, u.name AS person, p.company, c.kind, c.model, c.rate, c.base_usd, c.cost_share_usd, c.amount_usd, c.status, c.paid_amount_usd, c.paid_at, c.description, c.created_at FROM commission_entries c JOIN users u ON u.id = c.user_id LEFT JOIN prospects p ON p.id = c.prospect_id ORDER BY c.id").all();
  else if (what === "payments") rows = db.prepare("SELECT pay.id, p.company, pay.sequence, pay.label, pay.amount, pay.currency, pay.amount_usd, pay.fx_rate_used, pay.fx_fallback, pay.received_at, pay.reversed_at, pay.note FROM payments pay JOIN prospects p ON p.id = pay.prospect_id ORDER BY pay.id").all();
  else if (what === "activities") rows = db.prepare("SELECT a.id, u.name AS person, p.company, a.type, a.detail, a.occurred_at FROM activities a JOIN users u ON u.id = a.user_id LEFT JOIN prospects p ON p.id = a.prospect_id ORDER BY a.id DESC LIMIT 20000").all();
  else if (what === "tasks") rows = db.prepare("SELECT t.id, t.title, a.name AS assigned_to, b.name AS assigned_by, p.company, t.due_date, t.priority, t.status, t.completion_note, t.blocked_reason, t.completed_at FROM tasks t JOIN users a ON a.id = t.assigned_to JOIN users b ON b.id = t.assigned_by LEFT JOIN prospects p ON p.id = t.prospect_id ORDER BY t.id").all();
  else throw bad("Unknown export");
  audit(req.user.id, "export", null, what);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="tdm-${what}-${pkDate()}.csv"`);
  res.send(csv(rows));
});

/* ---- Import (rows parsed client-side from a sheet) ---- */
const importRow = z.object({
  company: z.string().min(1), contact_name: z.string().min(1).default("Unknown"), email: z.string().optional().nullable(), phone: z.string().optional().nullable(), website: z.string().optional().nullable(), country: z.string().optional().nullable(),
  source: z.string().optional().nullable(), service_interest: z.string().optional().nullable(), campaign_tag: z.string().optional().nullable(), owner_email: z.string().optional().nullable(),
});
reportsRouter.post("/import", (req, res) => {
  const body = z.object({ rows: z.array(importRow), default_source: z.string().default("cold_email"), default_service: z.string().default("other"), force_ids: z.array(z.number()).optional() }).parse(req.body);
  const result = { imported: 0, duplicates: [] as any[], errors: [] as any[] };
  const tx = db.transaction(() => {
    body.rows.forEach((row, i) => {
      const email = row.email?.trim().toLowerCase() || null;
      const dups = findDuplicates({ email, phone: row.phone, website: row.website });
      if (dups.length && !body.force_ids?.includes(i)) { result.duplicates.push({ row: i, company: row.company, existing: dups[0] }); return; }
      const source = (SOURCES as readonly string[]).includes(row.source ?? "") ? row.source! : body.default_source;
      const service = (SERVICES as readonly string[]).includes(row.service_interest ?? "") ? row.service_interest! : body.default_service;
      let ownerId: number | null = null;
      if (row.owner_email) { const u = db.prepare("SELECT id FROM users WHERE email = ? AND active = 1").get(row.owner_email) as any; ownerId = u?.id ?? null; }
      const r = db.prepare(`INSERT INTO prospects (company, contact_name, email, phone, phone_norm, website, domain, country, source, service_interest, campaign_tag, owner_id, stage, next_follow_up, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new_lead', ?, ?, ?)`)
        .run(row.company, row.contact_name || "Unknown", email, row.phone ?? null, normalisePhone(row.phone), row.website ?? null, normaliseDomain(row.website, email), row.country ?? null, source, service, row.campaign_tag ?? null, ownerId, ownerId ? addDays(pkDate(), 1) : null, req.user.id, req.user.id);
      logActivity({ prospectId: Number(r.lastInsertRowid), userId: req.user.id, type: "imported", detail: ownerId ? `Imported and assigned to user ${ownerId}` : "Imported to Unassigned pool" });
      if (ownerId) notify(ownerId, "assigned", `New lead assigned: ${row.company}`, undefined, Number(r.lastInsertRowid));
      result.imported++;
    });
  });
  tx();
  audit(req.user.id, "import", null, "sheet", { imported: result.imported, duplicates: result.duplicates.length });
  res.json(result);
});

/* ---- Reassignment screen ---- */
reportsRouter.post("/reassign", (req, res) => {
  const body = z.object({ from_user_id: z.number(), to_user_id: z.number(), deactivate: z.boolean().default(false) }).parse(req.body);
  if (body.from_user_id === body.to_user_id) throw bad("Pick a different person");
  const tx = db.transaction(() => {
    const open = db.prepare("SELECT id, company FROM prospects WHERE owner_id = ? AND stage NOT IN ('closed_won','closed_lost')").all(body.from_user_id) as any[];
    for (const p of open) {
      db.prepare("UPDATE prospects SET owner_id = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(body.to_user_id, req.user.id, p.id);
      logActivity({ prospectId: p.id, userId: req.user.id, type: "reassigned", detail: `Bulk reassignment ${body.from_user_id} → ${body.to_user_id} by ${req.user.name}` });
    }
    db.prepare("UPDATE commission_entries SET frozen = 1, updated_at = datetime('now') WHERE user_id = ? AND status = 'pending'").run(body.from_user_id);
    db.prepare("UPDATE tasks SET assigned_to = ?, updated_at = datetime('now') WHERE assigned_to = ? AND status IN ('open','in_progress','blocked')").run(body.to_user_id, body.from_user_id);
    if (body.deactivate && req.user.role === "owner") db.prepare("UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?").run(body.from_user_id);
    audit(req.user.id, "reassign", body.from_user_id, "bulk", { ...body, moved: open.length });
    notify(body.to_user_id, "assigned", `${open.length} prospects reassigned to you`, undefined);
    res.json({ moved: open.length });
  });
  tx();
});
reportsRouter.get("/frozen", (_req, res) => {
  res.json(db.prepare("SELECT c.*, u.name AS user_name, p.company, p.owner_id AS current_owner_id, o.name AS current_owner_name FROM commission_entries c JOIN users u ON u.id = c.user_id LEFT JOIN prospects p ON p.id = c.prospect_id LEFT JOIN users o ON o.id = p.owner_id WHERE c.frozen = 1").all());
});
