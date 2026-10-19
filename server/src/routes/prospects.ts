import { Router } from "express";
import { z } from "zod";
import { db, getSetting } from "../db.js";
import { isManagement } from "../auth.js";
import { bad, conflict, forbidden, notFound } from "../errors.js";
import { audit, logActivity, notify } from "../log.js";
import { toUsd } from "../fx.js";
import { addDays, pkDate } from "../time.js";
import { createPendingEntries, recomputeProfitSplit, isRetainerType } from "../commission.js";

export const prospectsRouter = Router();

export const STAGES = ["new_lead", "contacted", "replied", "meeting_booked", "meeting_held", "proposal_sent", "negotiation", "closed_won", "closed_lost"] as const;
export const SOURCES = ["cold_email", "linkedin", "upwork", "fiverr", "referral", "inbound", "instagram", "other"] as const;
export const SERVICES = ["web_shopify", "seo_aeo_geo", "performance_marketing", "social_media", "marketplace", "video", "staff_augmentation", "other"] as const;
export const ENGAGEMENTS = ["one_off_project", "monthly_retainer", "dedicated_resource"] as const;
export const LOST_REASONS = ["price", "no_response", "went_elsewhere", "bad_fit", "timing"] as const;

export function normaliseDomain(website?: string | null, email?: string | null): string | null {
  const src = website?.trim() || (email?.includes("@") ? email.split("@")[1] : "");
  if (!src) return null;
  let d = src.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const free = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "live.com", "proton.me", "protonmail.com"]);
  return d && !free.has(d) ? d : null;
}
export function normalisePhone(p?: string | null) {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null; // compare on last 10 digits
}

/** Visibility: agents see their own and partnered prospects only. */
export function canSee(user: { id: number; role: string }, p: { owner_id: number | null; partner_id: number | null }) {
  return isManagement(user as any) || p.owner_id === user.id || p.partner_id === user.id;
}
function visibleWhere(user: { id: number; role: string }) {
  return isManagement(user as any) ? { sql: "1=1", params: [] as unknown[] } : { sql: "(owner_id = ? OR partner_id = ?)", params: [user.id, user.id] };
}

export function findDuplicates(input: { email?: string | null; phone?: string | null; website?: string | null }, excludeId?: number) {
  const email = input.email?.trim().toLowerCase() || null;
  const phone = normalisePhone(input.phone);
  const domain = normaliseDomain(input.website, input.email);
  const rows = db.prepare(
    `SELECT p.id, p.company, p.contact_name, p.owner_id, u.name AS owner_name, p.created_at, p.email, p.phone, p.domain
     FROM prospects p LEFT JOIN users u ON u.id = p.owner_id
     WHERE (p.email IS NOT NULL AND lower(p.email) = ?) OR (? IS NOT NULL AND p.phone_norm = ?) OR (? IS NOT NULL AND p.domain = ?)`
  ).all(email, phone, phone, domain, domain) as any[];
  return rows.filter(r => r.id !== excludeId).map(r => ({ id: r.id, company: r.company, owner_id: r.owner_id, owner_name: r.owner_name ?? "Unassigned", created_at: r.created_at, matched_on: [email && r.email?.toLowerCase() === email ? "email" : null, phone && normalisePhone(r.phone) === phone ? "phone" : null, domain && r.domain === domain ? "website" : null].filter(Boolean) }));
}

const prospectBody = z.object({
  client_uuid: z.string().optional(),
  client_created_at: z.string().optional(),
  company: z.string().min(1), contact_name: z.string().min(1),
  email: z.string().email().optional().nullable().or(z.literal("")), phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(), country: z.string().optional().nullable(),
  source: z.enum(SOURCES), service_interest: z.enum(SERVICES), campaign_tag: z.string().optional().nullable(),
  next_follow_up: z.string().optional().nullable(),
  partner_id: z.number().optional().nullable(),
  owner_id: z.number().optional().nullable(),   // management only
  notes: z.string().optional(),
});

prospectsRouter.get("/meta", (_req, res) => {
  res.json({ stages: STAGES, sources: SOURCES, services: SERVICES, engagements: ENGAGEMENTS, lost_reasons: LOST_REASONS });
});

prospectsRouter.post("/check-duplicate", (req, res) => {
  const body = z.object({ email: z.string().optional().nullable(), phone: z.string().optional().nullable(), website: z.string().optional().nullable() }).parse(req.body);
  res.json({ matches: findDuplicates(body) });
});

prospectsRouter.get("/", (req, res) => {
  const v = visibleWhere(req.user);
  const q = req.query as Record<string, string>;
  const where = [v.sql]; const params = [...v.params];
  if (q.stage) { where.push("stage = ?"); params.push(q.stage); }
  if (q.owner_id && isManagement(req.user)) { where.push("owner_id = ?"); params.push(Number(q.owner_id)); }
  if (q.unassigned === "1" && isManagement(req.user)) where.push("owner_id IS NULL");
  else if (!isManagement(req.user)) where.push("owner_id IS NOT NULL");
  if (q.search) { where.push("(company LIKE ? OR contact_name LIKE ? OR email LIKE ?)"); const s = `%${q.search}%`; params.push(s, s, s); }
  if (q.after_close) { where.push("after_close_status = ?"); params.push(q.after_close); }
  const rows = db.prepare(
    `SELECT p.*, o.name AS owner_name, pa.name AS partner_name,
       (SELECT MIN(due_date) FROM follow_ups f WHERE f.prospect_id = p.id AND f.done_at IS NULL) AS next_due,
       (SELECT COUNT(*) FROM meetings m WHERE m.prospect_id = p.id) AS meeting_count
     FROM prospects p LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN users pa ON pa.id = p.partner_id
     WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC LIMIT 1000`
  ).all(...params);
  res.json(rows);
});

prospectsRouter.post("/", (req, res) => {
  const body = prospectBody.parse(req.body);
  if (body.client_uuid) {
    const existing = db.prepare("SELECT id FROM prospects WHERE client_uuid = ?").get(body.client_uuid) as any;
    if (existing) return res.status(200).json({ id: existing.id, deduped: true });
  }
  const email = body.email ? body.email.trim().toLowerCase() : null;
  const dups = findDuplicates({ email, phone: body.phone, website: body.website });
  if (dups.length) {
    // Offline race: if the incoming record was created earlier on the device than the existing one, ownership flips.
    const d = dups[0];
    const existing = db.prepare("SELECT * FROM prospects WHERE id = ?").get(d.id) as any;
    const incomingTs = body.client_created_at ?? null;
    const existingTs = existing.client_created_at ?? existing.created_at;
    if (incomingTs && incomingTs < existingTs && existing.owner_id && existing.owner_id !== req.user.id && !isManagement(req.user)) {
      // earlier original timestamp wins: swap owner, previous owner becomes a pending join request
      const prevOwner = existing.owner_id;
      db.prepare("UPDATE prospects SET owner_id = ?, client_created_at = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, incomingTs, req.user.id, existing.id);
      db.prepare("INSERT INTO partner_requests (prospect_id, requester_id) VALUES (?, ?)").run(existing.id, prevOwner);
      logActivity({ prospectId: existing.id, userId: req.user.id, type: "ownership_resolved", detail: `Offline conflict: earlier original timestamp (${incomingTs}) wins ownership; previous owner added as join request` });
      for (const m of db.prepare("SELECT id FROM users WHERE role IN ('owner','manager') AND active = 1").all() as any[]) notify(m.id, "offline_conflict", `Ownership conflict resolved on ${existing.company}`, "Earlier device timestamp won. Review in the activity log.", existing.id);
      return res.status(200).json({ id: existing.id, resolved_conflict: true });
    }
    throw conflict("A prospect with this email, phone or website already exists", { duplicate: d, can_request_partner: d.owner_id !== req.user.id });
  }
  const ownerId = isManagement(req.user) && body.owner_id !== undefined ? body.owner_id : req.user.id;
  const partnerId = body.partner_id && body.partner_id !== ownerId ? body.partner_id : null;
  const r = db.prepare(
    `INSERT INTO prospects (client_uuid, client_created_at, company, contact_name, email, phone, phone_norm, website, domain, country, source, service_interest, campaign_tag, owner_id, partner_id, partner_since, stage, next_follow_up, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new_lead', ?, ?, ?)`
  ).run(body.client_uuid ?? null, body.client_created_at ?? null, body.company, body.contact_name, email, body.phone ?? null, normalisePhone(body.phone), body.website ?? null,
    normaliseDomain(body.website, email), body.country ?? null, body.source, body.service_interest, body.campaign_tag ?? null, ownerId, partnerId, partnerId ? new Date().toISOString() : null,
    body.next_follow_up ?? addDays(pkDate(), 1), req.user.id, req.user.id);
  const id = Number(r.lastInsertRowid);
  logActivity({ prospectId: id, userId: req.user.id, type: "created", detail: `Added by ${req.user.name}`, occurredAt: body.client_created_at });
  if (partnerId) logActivity({ prospectId: id, userId: req.user.id, type: "partner_added", detail: `Partner added at creation (user ${partnerId})` });
  if (body.notes) db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(id, req.user.id, body.notes);
  res.status(201).json({ id });
});

function loadProspect(id: number) {
  const p = db.prepare("SELECT p.*, o.name AS owner_name, pa.name AS partner_name FROM prospects p LEFT JOIN users o ON o.id = p.owner_id LEFT JOIN users pa ON pa.id = p.partner_id WHERE p.id = ?").get(id) as any;
  if (!p) throw notFound("Prospect not found");
  return p;
}

prospectsRouter.get("/:id", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const id = p.id;
  const mgmt = isManagement(req.user);
  res.json({
    prospect: p,
    notes: db.prepare("SELECT n.*, u.name AS user_name FROM notes n JOIN users u ON u.id = n.user_id WHERE prospect_id = ? ORDER BY created_at DESC").all(id),
    activities: db.prepare("SELECT a.*, u.name AS user_name FROM activities a JOIN users u ON u.id = a.user_id WHERE prospect_id = ? ORDER BY occurred_at DESC LIMIT 200").all(id),
    follow_ups: db.prepare("SELECT * FROM follow_ups WHERE prospect_id = ? ORDER BY done_at IS NOT NULL, due_date").all(id),
    meetings: db.prepare("SELECT m.*, u.name AS credited_name FROM meetings m JOIN users u ON u.id = m.credited_to WHERE prospect_id = ? ORDER BY scheduled_at DESC").all(id),
    tasks: db.prepare("SELECT t.*, a.name AS assigned_to_name FROM tasks t JOIN users a ON a.id = t.assigned_to WHERE prospect_id = ? ORDER BY due_date").all(id),
    payments: db.prepare("SELECT * FROM payments WHERE prospect_id = ? ORDER BY sequence").all(id),
    commission: mgmt
      ? db.prepare("SELECT c.*, u.name AS user_name FROM commission_entries c JOIN users u ON u.id = c.user_id WHERE prospect_id = ? ORDER BY created_at").all(id)
      : db.prepare("SELECT c.* FROM commission_entries c WHERE prospect_id = ? AND user_id = ? ORDER BY created_at").all(id, req.user.id),
    partner_requests: db.prepare("SELECT r.*, u.name AS requester_name FROM partner_requests r JOIN users u ON u.id = r.requester_id WHERE prospect_id = ? ORDER BY created_at DESC").all(id),
  });
});

const editable = z.object({
  company: z.string().min(1).optional(), contact_name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional().or(z.literal("")), phone: z.string().nullable().optional(), website: z.string().nullable().optional(), country: z.string().nullable().optional(),
  source: z.enum(SOURCES).optional(), service_interest: z.enum(SERVICES).optional(), campaign_tag: z.string().nullable().optional(),
  next_follow_up: z.string().nullable().optional(),
  deal_value: z.number().nullable().optional(), deal_currency: z.string().optional(), engagement_model: z.enum(ENGAGEMENTS).nullable().optional(),
  payment_terms: z.string().nullable().optional(), expected_delivery_date: z.string().nullable().optional(),
  estimated_cost_usd: z.number().nullable().optional(), actual_cost_usd: z.number().nullable().optional(),
});

prospectsRouter.patch("/:id", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const body = editable.parse(req.body);
  if ((body.estimated_cost_usd !== undefined || body.actual_cost_usd !== undefined) && !isManagement(req.user)) throw forbidden("Only Abdul or Adnan can enter project cost");
  const changes: Record<string, unknown> = {};
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || k === "deal_currency") continue;
    const val = k === "email" ? (v ? String(v).toLowerCase() : null) : v;
    if (p[k] !== val) { changes[k] = { from: p[k], to: val }; sets.push(`${k} = ?`); vals.push(val); }
  }
  if (body.deal_value !== undefined && body.deal_value !== null) {
    const cur = (body.deal_currency ?? p.deal_currency ?? "USD").toUpperCase();
    const c = toUsd(body.deal_value, cur);
    sets.push("deal_currency = ?", "deal_value_usd = ?", "fx_rate_used = ?", "fx_fallback = ?"); vals.push(cur, c.amount_usd, c.rate, c.fallback ? 1 : 0);
    changes.deal_value_usd = c.amount_usd;
  }
  if (body.website !== undefined || body.email !== undefined) {
    sets.push("domain = ?"); vals.push(normaliseDomain(body.website ?? p.website, (body.email as string) ?? p.email));
  }
  if (body.phone !== undefined) { sets.push("phone_norm = ?"); vals.push(normalisePhone(body.phone)); }
  if (body.next_follow_up !== undefined && body.next_follow_up) {
    // manual follow-up date supersedes open auto follow-ups
    db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL AND kind LIKE 'auto_%'").run(p.id);
    db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, body.next_follow_up);
    db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL AND kind = 'manual' AND due_date < ?").run(p.id, body.next_follow_up);
  }
  if (sets.length) {
    sets.push("updated_by = ?", "updated_at = datetime('now')"); vals.push(req.user.id);
    db.prepare(`UPDATE prospects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, p.id);
    logActivity({ prospectId: p.id, userId: req.user.id, type: "field_edit", detail: JSON.stringify(changes) });
  }
  if (body.estimated_cost_usd !== undefined || body.actual_cost_usd !== undefined) recomputeProfitSplit(p.id);
  res.json({ ok: true });
});

/* ---- Stage changes ---- */
const stageBody = z.object({
  stage: z.enum(STAGES),
  next_follow_up: z.string().optional().nullable(),
  deal_value: z.number().optional(), deal_currency: z.string().optional(), engagement_model: z.enum(ENGAGEMENTS).optional(),
  payment_terms: z.string().optional(), expected_delivery_date: z.string().optional().nullable(),
  lost_reason: z.enum(LOST_REASONS).optional(),
  note: z.string().optional(),
});

prospectsRouter.post("/:id/stage", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const body = stageBody.parse(req.body);
  const from = p.stage as string;
  const to = body.stage;
  if (to === from) throw bad("Already in that stage");
  if (["meeting_booked", "meeting_held"].includes(to) && !isManagement(req.user)) throw forbidden("Meetings are logged by Abdul from Calendly");
  if (from === "closed_won" && p.closed_won_at) throw bad("A won deal cannot change stage");
  const sets: string[] = ["stage = ?", "updated_by = ?", "updated_at = datetime('now')"]; const vals: unknown[] = [to, req.user.id];
  const today = pkDate();
  const tx = db.transaction(() => {
    if (to === "contacted" && !p.contacted_at) {
      sets.push("contacted_at = datetime('now')");
      if (body.next_follow_up) {
        db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, body.next_follow_up);
      } else {
        for (const [k, d] of [["auto_d3", 3], ["auto_d7", 7], ["auto_d14", 14]] as const) db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, ?)").run(p.id, addDays(today, d), k);
        sets.push("next_follow_up = ?"); vals.push(addDays(today, 3));
      }
    }
    if (to === "replied") { sets.push("is_cold = 0"); db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL AND kind LIKE 'auto_%'").run(p.id); }
    if (to === "proposal_sent") {
      const value = body.deal_value ?? p.deal_value; const cur = (body.deal_currency ?? p.deal_currency ?? "USD").toUpperCase();
      if (value == null) throw bad("Deal value is required at Proposal sent");
      const eng = body.engagement_model ?? p.engagement_model; if (!eng) throw bad("Engagement model is required at Proposal sent");
      const c = toUsd(value, cur);
      sets.push("deal_value = ?", "deal_currency = ?", "deal_value_usd = ?", "fx_rate_used = ?", "fx_fallback = ?", "engagement_model = ?", "proposal_sent_at = datetime('now')");
      vals.push(value, cur, c.amount_usd, c.rate, c.fallback ? 1 : 0, eng);
      db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'proposal_chase')").run(p.id, addDays(today, Number(getSetting("proposal_chase_days") ?? 5)));
    }
    if (to === "closed_won") {
      const terms = body.payment_terms ?? p.payment_terms; if (!terms) throw bad("Payment terms are required at Closed won");
      if (p.deal_value_usd == null) throw bad("Deal value must be entered before closing");
      sets.push("payment_terms = ?", "closed_won_requested_at = datetime('now')"); vals.push(terms);
      if (body.expected_delivery_date !== undefined) { sets.push("expected_delivery_date = ?"); vals.push(body.expected_delivery_date); }
      if (isManagement(req.user)) {
        approveWon(p, req.user.id, sets, vals);
      } else {
        for (const m of db.prepare("SELECT id FROM users WHERE role IN ('owner','manager') AND active = 1").all() as any[]) notify(m.id, "approval_needed", `Closed won approval: ${p.company}`, `${req.user.name} marked ${p.company} as won ($${p.deal_value_usd}). Approve or decline.`, p.id);
      }
      db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL").run(p.id);
      sets.push("next_follow_up = NULL");
    }
    if (to === "closed_lost") {
      if (!body.lost_reason) throw bad("Pick a lost reason");
      sets.push("lost_reason = ?", "closed_lost_at = datetime('now')", "next_follow_up = NULL", "is_cold = 0"); vals.push(body.lost_reason);
      db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL").run(p.id);
    }
    if (!["closed_won", "closed_lost"].includes(to) && body.next_follow_up) {
      sets.push("next_follow_up = ?"); vals.push(body.next_follow_up);
      db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, body.next_follow_up);
    }
    db.prepare(`UPDATE prospects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, p.id);
    logActivity({ prospectId: p.id, userId: req.user.id, type: "stage_change", detail: `${from} → ${to}${body.note ? `: ${body.note}` : ""}` });
    if (body.note) db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(p.id, req.user.id, body.note);
  });
  tx();
  if (to === "closed_won" && isManagement(req.user)) {
    createPendingEntries(p.id);
    notify(p.owner_id, "deal_approved", `Deal approved: ${p.company}`, "Commission entry created (Pending until the client pays).", p.id);
    if (p.partner_id) notify(p.partner_id, "deal_approved", `Deal approved: ${p.company}`, "Commission entry created (Pending until the client pays).", p.id);
  }
  res.json({ ok: true, pending_approval: to === "closed_won" && !isManagement(req.user) });
});

function approveWon(p: any, approverId: number, sets: string[], vals: unknown[]) {
  const after = isRetainerType(p.engagement_model) ? "active_retainer" : "in_delivery";
  sets.push("closed_won_at = datetime('now')", "approved_by = ?", "after_close_status = ?"); vals.push(approverId, after);
}

/** Owner/Manager approves or declines a Closed won request. */
prospectsRouter.post("/:id/approve", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const p = loadProspect(Number(req.params.id));
  const body = z.object({ approve: z.boolean(), note: z.string().optional() }).parse(req.body);
  if (p.stage !== "closed_won" || p.closed_won_at) throw bad("Nothing to approve");
  const tx = db.transaction(() => {
    if (body.approve) {
      const sets: string[] = ["updated_by = ?", "updated_at = datetime('now')"]; const vals: unknown[] = [req.user.id];
      approveWon(p, req.user.id, sets, vals);
      db.prepare(`UPDATE prospects SET ${sets.join(", ")} WHERE id = ?`).run(...vals, p.id);
      createPendingEntries(p.id);
      logActivity({ prospectId: p.id, userId: req.user.id, type: "approved", detail: `Closed won approved${body.note ? `: ${body.note}` : ""}` });
      notify(p.owner_id, "deal_approved", `Deal approved: ${p.company}`, `Commission entry created (Pending until the client pays).`, p.id);
      if (p.partner_id) notify(p.partner_id, "deal_approved", `Deal approved: ${p.company}`, `Commission entry created (Pending until the client pays).`, p.id);
      for (const o of db.prepare("SELECT id FROM users WHERE role = 'owner' AND active = 1").all() as any[]) if (o.id !== req.user.id) notify(o.id, "deal_closed", `Deal closed: ${p.company}`, `$${p.deal_value_usd} approved by ${req.user.name}`, p.id);
    } else {
      db.prepare("UPDATE prospects SET stage = 'negotiation', closed_won_requested_at = NULL, next_follow_up = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(addDays(pkDate(), 1), req.user.id, p.id);
      db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, addDays(pkDate(), 1));
      logActivity({ prospectId: p.id, userId: req.user.id, type: "approval_declined", detail: body.note ?? "Declined, back to Negotiation" });
      if (body.note) db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(p.id, req.user.id, body.note);
      notify(p.owner_id, "deal_declined", `Closed won declined: ${p.company}`, body.note ?? "Back to Negotiation", p.id);
    }
  });
  tx();
  // Management closing directly: create pending entries too
  res.json({ ok: true });
});

/** When management moves straight to Closed won the approval is implicit; create entries. */
prospectsRouter.post("/:id/finalise-won", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const p = loadProspect(Number(req.params.id));
  if (p.stage !== "closed_won" || !p.closed_won_at) throw bad("Deal is not approved");
  const n = (db.prepare("SELECT COUNT(*) c FROM commission_entries WHERE prospect_id = ? AND kind='sales'").get(p.id) as any).c;
  if (n === 0) createPendingEntries(p.id);
  res.json({ ok: true });
});

/* ---- After close ---- */
prospectsRouter.post("/:id/after-close", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const body = z.object({ status: z.enum(["project_delivered", "retainer_finished"]), date: z.string() }).parse(req.body);
  if (!p.closed_won_at) throw bad("Deal is not won yet");
  if (body.status === "project_delivered" && p.after_close_status !== "in_delivery") throw bad("Only a deal in delivery can be marked delivered");
  if (body.status === "retainer_finished" && p.after_close_status !== "active_retainer") throw bad("Only an active retainer can be finished");
  const col = body.status === "project_delivered" ? "delivered_at" : "retainer_finished_at";
  db.prepare(`UPDATE prospects SET after_close_status = ?, ${col} = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(body.status, body.date, req.user.id, p.id);
  if (body.status === "retainer_finished") {
    // projection no longer applies
    db.prepare("UPDATE commission_entries SET status = 'paid', amount_usd = 0, paid_amount_usd = 0, paid_at = datetime('now'), description = 'Retainer finished', updated_at = datetime('now') WHERE prospect_id = ? AND payment_id IS NULL AND status = 'pending'").run(p.id);
  }
  logActivity({ prospectId: p.id, userId: req.user.id, type: "after_close", detail: `${body.status} on ${body.date}` });
  res.json({ ok: true });
});

/* ---- Notes & activities ---- */
prospectsRouter.post("/:id/notes", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const body = z.object({ body: z.string().min(1), client_created_at: z.string().optional() }).parse(req.body);
  db.prepare("INSERT INTO notes (prospect_id, user_id, body, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))").run(p.id, req.user.id, body.body, body.client_created_at ?? null);
  logActivity({ prospectId: p.id, userId: req.user.id, type: "note", detail: body.body.slice(0, 120), occurredAt: body.client_created_at });
  res.status(201).json({ ok: true });
});

prospectsRouter.post("/:id/activities", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const body = z.object({
    type: z.enum(["emailed", "called", "messaged", "met", "no_answer", "whatsapp_tap", "call_tap", "email_tap"]),
    detail: z.string().optional(), next_follow_up: z.string().optional().nullable(), client_created_at: z.string().optional(),
    clear_due: z.boolean().optional(),
  }).parse(req.body);
  const tx = db.transaction(() => {
    logActivity({ prospectId: p.id, userId: req.user.id, type: body.type, detail: body.detail, occurredAt: body.client_created_at });
    if (body.clear_due !== false && !body.type.endsWith("_tap")) {
      db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL AND due_date <= ?").run(p.id, pkDate());
    }
    if (body.next_follow_up) {
      db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, body.next_follow_up);
      db.prepare("UPDATE prospects SET next_follow_up = ?, is_cold = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(body.next_follow_up, req.user.id, p.id);
    } else {
      const next = db.prepare("SELECT MIN(due_date) d FROM follow_ups WHERE prospect_id = ? AND done_at IS NULL").get(p.id) as any;
      db.prepare("UPDATE prospects SET next_follow_up = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(next?.d ?? null, req.user.id, p.id);
    }
    if (p.stage === "new_lead" && ["emailed", "called", "messaged"].includes(body.type)) {
      // first outreach auto-moves to Contacted with the automatic follow-up ladder
      db.prepare("UPDATE prospects SET stage = 'contacted', contacted_at = datetime('now') WHERE id = ?").run(p.id);
      if (!body.next_follow_up) {
        const today = pkDate();
        for (const [k, d] of [["auto_d3", 3], ["auto_d7", 7], ["auto_d14", 14]] as const) db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, ?)").run(p.id, addDays(today, d), k);
        db.prepare("UPDATE prospects SET next_follow_up = ? WHERE id = ?").run(addDays(today, 3), p.id);
      }
      logActivity({ prospectId: p.id, userId: req.user.id, type: "stage_change", detail: "new_lead → contacted (first outreach)" });
    }
  });
  tx();
  res.status(201).json({ ok: true });
});

/** Cold prospect decision: keep chasing (new date) or mark lost handled via /stage. */
prospectsRouter.post("/:id/keep-chasing", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (!canSee(req.user, p)) throw forbidden();
  const body = z.object({ next_follow_up: z.string() }).parse(req.body);
  db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, body.next_follow_up);
  db.prepare("UPDATE prospects SET is_cold = 0, next_follow_up = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(body.next_follow_up, req.user.id, p.id);
  logActivity({ prospectId: p.id, userId: req.user.id, type: "keep_chasing", detail: `Cold prospect kept, next follow-up ${body.next_follow_up}` });
  res.json({ ok: true });
});

/* ---- Partners ---- */
prospectsRouter.post("/:id/partner-request", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  if (p.owner_id === req.user.id || p.partner_id === req.user.id) throw bad("You are already on this deal");
  if (p.partner_id) throw bad("This deal already has a partner");
  const open = db.prepare("SELECT id FROM partner_requests WHERE prospect_id = ? AND requester_id = ? AND status = 'pending'").get(p.id, req.user.id);
  if (open) throw bad("Request already pending");
  db.prepare("INSERT INTO partner_requests (prospect_id, requester_id) VALUES (?, ?)").run(p.id, req.user.id);
  logActivity({ prospectId: p.id, userId: req.user.id, type: "partner_requested", detail: `${req.user.name} asked to join as partner` });
  const targets = [p.owner_id, ...(db.prepare("SELECT id FROM users WHERE role IN ('owner','manager') AND active = 1").all() as any[]).map(u => u.id)].filter(Boolean);
  for (const t of new Set(targets)) notify(t, "partner_request", `Partner request on ${p.company}`, `${req.user.name} asked to join as partner.`, p.id);
  res.status(201).json({ ok: true });
});

prospectsRouter.post("/:id/partner-request/:reqId", (req, res) => {
  const p = loadProspect(Number(req.params.id));
  const r = db.prepare("SELECT * FROM partner_requests WHERE id = ? AND prospect_id = ?").get(Number(req.params.reqId), p.id) as any;
  if (!r) throw notFound();
  if (!(isManagement(req.user) || p.owner_id === req.user.id)) throw forbidden();
  const body = z.object({ accept: z.boolean() }).parse(req.body);
  if (r.status !== "pending") throw bad("Already decided");
  const tx = db.transaction(() => {
    db.prepare("UPDATE partner_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(body.accept ? "accepted" : "declined", req.user.id, r.id);
    if (body.accept) {
      db.prepare("UPDATE prospects SET partner_id = ?, partner_since = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(r.requester_id, req.user.id, p.id);
      if (p.closed_won_at) { db.prepare("DELETE FROM commission_entries WHERE prospect_id = ? AND payment_id IS NULL AND kind='sales' AND status='pending'").run(p.id); createPendingEntries(p.id); }
    }
    logActivity({ prospectId: p.id, userId: req.user.id, type: body.accept ? "partner_approved" : "partner_declined", detail: `Request from user ${r.requester_id} ${body.accept ? "approved" : "declined"} by ${req.user.name}` });
    notify(r.requester_id, "partner_decision", `Partner request ${body.accept ? "approved" : "declined"}: ${p.company}`, undefined, p.id);
  });
  tx();
  res.json({ ok: true });
});

prospectsRouter.post("/:id/partner", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const p = loadProspect(Number(req.params.id));
  const body = z.object({ partner_id: z.number().nullable() }).parse(req.body);
  if (body.partner_id === p.owner_id) throw bad("Owner cannot be partner");
  const tx = db.transaction(() => {
    db.prepare("UPDATE prospects SET partner_id = ?, partner_since = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(body.partner_id, body.partner_id ? new Date().toISOString() : null, req.user.id, p.id);
    if (p.closed_won_at) { db.prepare("DELETE FROM commission_entries WHERE prospect_id = ? AND payment_id IS NULL AND kind='sales' AND status='pending'").run(p.id); createPendingEntries(p.id); }
    logActivity({ prospectId: p.id, userId: req.user.id, type: body.partner_id ? "partner_added" : "partner_removed", detail: `By ${req.user.name}; applies to payments received from now` });
  });
  tx();
  res.json({ ok: true });
});

/* ---- Assign / reassign ---- */
prospectsRouter.post("/:id/assign", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const p = loadProspect(Number(req.params.id));
  const body = z.object({ owner_id: z.number() }).parse(req.body);
  db.prepare("UPDATE prospects SET owner_id = ?, updated_by = ?, updated_at = datetime('now'), next_follow_up = COALESCE(next_follow_up, ?) WHERE id = ?").run(body.owner_id, req.user.id, addDays(pkDate(), 1), p.id);
  logActivity({ prospectId: p.id, userId: req.user.id, type: "reassigned", detail: `Owner ${p.owner_name ?? "Unassigned"} → user ${body.owner_id} by ${req.user.name}` });
  notify(body.owner_id, "assigned", `New lead assigned: ${p.company}`, undefined, p.id);
  res.json({ ok: true });
});
