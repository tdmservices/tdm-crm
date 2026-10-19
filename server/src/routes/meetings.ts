import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { isManagement } from "../auth.js";
import { bad, forbidden, notFound } from "../errors.js";
import { logActivity, notify } from "../log.js";
import { addDays, pkDate } from "../time.js";
import { canSee } from "./prospects.js";

export const meetingsRouter = Router();

/** Abdul/Adnan log meetings from Calendly. Credited to the prospect's owner. */
meetingsRouter.post("/", (req, res) => {
  if (!isManagement(req.user)) throw forbidden("Meetings are logged by Abdul from Calendly");
  const body = z.object({ prospect_id: z.number(), scheduled_at: z.string(), timezone: z.string().default("Asia/Karachi"), link: z.string().optional().nullable(), prep_notes: z.string().optional().nullable(), rebooked_from: z.number().optional() }).parse(req.body);
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(body.prospect_id) as any;
  if (!p) throw notFound("Prospect not found");
  if (!p.owner_id) throw bad("Assign the lead to an agent before logging a meeting");
  const tx = db.transaction(() => {
    const r = db.prepare("INSERT INTO meetings (prospect_id, credited_to, booked_by, scheduled_at, timezone, link, prep_notes, rebooked_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.owner_id, req.user.id, body.scheduled_at, body.timezone, body.link ?? null, body.prep_notes ?? null, body.rebooked_from ?? null);
    if (body.rebooked_from) db.prepare("UPDATE meetings SET status = 'rebooked', updated_at = datetime('now') WHERE id = ?").run(body.rebooked_from);
    if (!["meeting_booked", "meeting_held", "proposal_sent", "negotiation", "closed_won", "closed_lost"].includes(p.stage)) {
      db.prepare("UPDATE prospects SET stage = 'meeting_booked', is_cold = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, p.id);
      logActivity({ prospectId: p.id, userId: req.user.id, type: "stage_change", detail: `${p.stage} → meeting_booked` });
    }
    db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL AND kind LIKE 'auto_%'").run(p.id);
    logActivity({ prospectId: p.id, userId: req.user.id, type: "meeting_booked", detail: `Meeting ${body.scheduled_at} credited to owner` });
    notify(p.owner_id, "meeting_booked", `Meeting booked: ${p.company}`, body.scheduled_at, p.id);
    res.status(201).json({ id: r.lastInsertRowid });
  });
  tx();
});

meetingsRouter.patch("/:id", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const m = db.prepare("SELECT * FROM meetings WHERE id = ?").get(Number(req.params.id)) as any;
  if (!m) throw notFound();
  const body = z.object({ status: z.enum(["held", "no_show"]).optional(), scheduled_at: z.string().optional(), link: z.string().nullable().optional(), prep_notes: z.string().nullable().optional(), next_follow_up: z.string().optional() }).parse(req.body);
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(m.prospect_id) as any;
  const tx = db.transaction(() => {
    const sets: string[] = ["updated_at = datetime('now')"]; const vals: unknown[] = [];
    for (const k of ["status", "scheduled_at", "link", "prep_notes"] as const) if (body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(body[k]); }
    db.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`).run(...vals, m.id);
    if (body.status === "held") {
      if (p.stage === "meeting_booked") db.prepare("UPDATE prospects SET stage = 'meeting_held', updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, p.id);
      logActivity({ prospectId: p.id, userId: req.user.id, type: "meeting_held", detail: `Meeting ${m.scheduled_at} held` });
      notify(m.credited_to, "meeting_result", `Meeting held: ${p.company}`, undefined, p.id);
    }
    if (body.status === "no_show") {
      const nf = body.next_follow_up ?? addDays(pkDate(), 2);
      const openMeetings = (db.prepare("SELECT COUNT(*) c FROM meetings WHERE prospect_id = ? AND status IN ('booked','held') AND id != ?").get(p.id, m.id) as any).c;
      if (p.stage === "meeting_booked" && openMeetings === 0) db.prepare("UPDATE prospects SET stage = 'replied', updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, p.id);
      db.prepare("UPDATE prospects SET next_follow_up = ? WHERE id = ?").run(nf, p.id);
      db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(p.id, nf);
      logActivity({ prospectId: p.id, userId: req.user.id, type: "meeting_no_show", detail: `No-show for ${m.scheduled_at}; follow up ${nf}` });
      notify(m.credited_to, "meeting_result", `No-show: ${p.company}`, `Follow up on ${nf}`, p.id);
    }
  });
  tx();
  res.json({ ok: true });
});

meetingsRouter.get("/", (req, res) => {
  const q = req.query as Record<string, string>;
  const where: string[] = []; const params: unknown[] = [];
  if (!isManagement(req.user)) { where.push("m.credited_to = ?"); params.push(req.user.id); }
  if (q.from) { where.push("m.scheduled_at >= ?"); params.push(q.from); }
  if (q.to) { where.push("m.scheduled_at < ?"); params.push(q.to); }
  if (q.status) { where.push("m.status = ?"); params.push(q.status); }
  const rows = db.prepare(`SELECT m.*, p.company, p.contact_name, u.name AS credited_name FROM meetings m JOIN prospects p ON p.id = m.prospect_id JOIN users u ON u.id = m.credited_to ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.scheduled_at`).all(...params) as any[];
  res.json(rows.filter(r => canSee(req.user, { owner_id: null, partner_id: null }) || true));
});
