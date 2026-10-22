/** Phase 3 inbound integrations. No login; each endpoint is protected by its own secret from Settings.
 *  Calendly → meetings, Meta Lead Ads and Google Ads lead forms → Unassigned pool, ChatFlow → WhatsApp conversation log. */
import { Router } from "express";
import crypto from "node:crypto";
import { db, getSetting } from "../db.js";
import { HttpError } from "../errors.js";
import { logActivity, notify, notifyManagement } from "../log.js";
import { findDuplicates, normaliseDomain, normalisePhone } from "./prospects.js";
import { addDays, pkDate } from "../time.js";

export const webhooksRouter = Router();

function record(source: string, externalId: string | null, payload: unknown, outcome: string) {
  db.prepare("INSERT OR IGNORE INTO inbound_events (source, external_id, payload, outcome) VALUES (?, ?, ?, ?)").run(source, externalId, JSON.stringify(payload).slice(0, 20000), outcome);
}
function seen(source: string, externalId: string) { return !!db.prepare("SELECT 1 FROM inbound_events WHERE source = ? AND external_id = ?").get(source, externalId); }
function systemUser() { return (db.prepare("SELECT id FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1").get() as any)?.id as number; }

/** Create a lead in the Unassigned pool unless it duplicates an existing prospect. */
export function createInboundLead(src: string, lead: { company?: string; contact_name?: string; email?: string; phone?: string; website?: string; country?: string; source: string; service?: string; campaign?: string; note?: string }) {
  const email = lead.email?.trim().toLowerCase() || null;
  const dups = findDuplicates({ email, phone: lead.phone, website: lead.website });
  const uid = systemUser();
  if (dups.length) {
    const d = dups[0];
    db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(d.id, uid, `New ${src} enquiry matched this prospect${lead.campaign ? ` (campaign ${lead.campaign})` : ""}.${lead.note ? "\n" + lead.note : ""}`);
    logActivity({ prospectId: d.id, userId: uid, type: "inbound_enquiry", detail: `${src} lead matched existing record` });
    if (d.owner_id) notify(d.owner_id, "inbound", `New enquiry from ${d.company}`, `Came in via ${src}. Follow up today.`, d.id);
    return { id: d.id, duplicate: true };
  }
  const r = db.prepare(`INSERT INTO prospects (company, contact_name, email, phone, phone_norm, website, domain, country, source, service_interest, campaign_tag, owner_id, stage, next_follow_up, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'new_lead', ?, ?, ?)`)
    .run(lead.company || lead.contact_name || "Unknown", lead.contact_name || "Unknown", email, lead.phone ?? null, normalisePhone(lead.phone), lead.website ?? null, normaliseDomain(lead.website, email), lead.country ?? null, lead.source, lead.service ?? "other", lead.campaign ?? null, addDays(pkDate(), 1), uid, uid);
  const id = Number(r.lastInsertRowid);
  logActivity({ prospectId: id, userId: uid, type: "imported", detail: `Lead from ${src} → Unassigned pool` });
  if (lead.note) db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(id, uid, lead.note);
  notifyManagement("inbound", `New ${src} lead: ${lead.company || lead.contact_name}`, "In the Unassigned pool. Assign it to an agent.", id);
  return { id, duplicate: false };
}

/* ---- Calendly: subscribe https://<host>/api/webhooks/calendly to invitee.created and invitee.canceled ---- */
webhooksRouter.post("/calendly", (req, res) => {
  const key = getSetting("calendly_signing_key");
  if (key) {
    const sig = String(req.headers["calendly-webhook-signature"] ?? "");
    const t = /t=(\d+)/.exec(sig)?.[1], v1 = /v1=([a-f0-9]+)/.exec(sig)?.[1];
    const expected = t ? crypto.createHmac("sha256", key).update(`${t}.${JSON.stringify(req.body)}`).digest("hex") : "";
    if (!v1 || v1 !== expected) throw new HttpError(401, "Bad Calendly signature");
  }
  const ev = req.body?.event as string; const payload = req.body?.payload ?? {};
  const inviteeEmail = String(payload.email ?? "").toLowerCase();
  const uri = String(payload.uri ?? payload.scheduled_event?.uri ?? "");
  const start = payload.scheduled_event?.start_time as string | undefined;
  if (!uri || seen("calendly", `${ev}:${uri}`)) return res.json({ ok: true, skipped: true });
  const uid = systemUser();
  if (ev === "invitee.created" && start) {
    let p = db.prepare("SELECT * FROM prospects WHERE lower(email) = ?").get(inviteeEmail) as any;
    if (!p) { const r = createInboundLead("Calendly", { contact_name: payload.name, email: inviteeEmail, source: "inbound", note: "Booked a call via Calendly before being in the CRM." }); p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(r.id); }
    if (!p.owner_id) { record("calendly", `${ev}:${uri}`, req.body, "lead unassigned; meeting pending assignment"); notifyManagement("meeting_unassigned", `Calendly booking needs an owner: ${p.company}`, "Assign the lead, then log the meeting from the booking.", p.id); return res.json({ ok: true, pending: true }); }
    const link = payload.scheduled_event?.location?.join_url ?? null;
    db.prepare("INSERT INTO meetings (prospect_id, credited_to, booked_by, scheduled_at, link, external_id, invitee_email) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.id, p.owner_id, uid, start, link, uri, inviteeEmail);
    if (!["meeting_booked", "meeting_held", "proposal_sent", "negotiation", "closed_won", "closed_lost"].includes(p.stage)) db.prepare("UPDATE prospects SET stage = 'meeting_booked', is_cold = 0, updated_at = datetime('now') WHERE id = ?").run(p.id);
    db.prepare("UPDATE follow_ups SET done_at = datetime('now') WHERE prospect_id = ? AND done_at IS NULL AND kind LIKE 'auto_%'").run(p.id);
    logActivity({ prospectId: p.id, userId: uid, type: "meeting_booked", detail: `Calendly booking ${start}` });
    notify(p.owner_id, "meeting_booked", `Meeting booked (Calendly): ${p.company}`, start, p.id);
    record("calendly", `${ev}:${uri}`, req.body, `meeting on prospect ${p.id}`);
  } else if (ev === "invitee.canceled") {
    const m = db.prepare("SELECT * FROM meetings WHERE external_id = ? AND status = 'booked'").get(uri) as any;
    if (m) {
      db.prepare("UPDATE meetings SET status = 'no_show', updated_at = datetime('now') WHERE id = ?").run(m.id);
      const nf = addDays(pkDate(), 1);
      db.prepare("INSERT INTO follow_ups (prospect_id, due_date, kind) VALUES (?, ?, 'manual')").run(m.prospect_id, nf);
      db.prepare("UPDATE prospects SET next_follow_up = ?, stage = CASE WHEN stage = 'meeting_booked' THEN 'replied' ELSE stage END WHERE id = ?").run(nf, m.prospect_id);
      logActivity({ prospectId: m.prospect_id, userId: uid, type: "meeting_no_show", detail: "Calendly booking cancelled by invitee" });
      notify(m.credited_to, "meeting_result", "Meeting cancelled by prospect", `Follow up on ${nf}`, m.prospect_id);
    }
    record("calendly", `${ev}:${uri}`, req.body, m ? "cancelled" : "no meeting found");
  }
  res.json({ ok: true });
});

/* ---- Meta Lead Ads: set the callback URL to /api/webhooks/meta, subscribe the page to leadgen ---- */
webhooksRouter.get("/meta", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === getSetting("meta_verify_token")) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
webhooksRouter.post("/meta", async (req, res) => {
  const secret = getSetting("meta_app_secret");
  if (secret) {
    const sig = String(req.headers["x-hub-signature-256"] ?? "").replace("sha256=", "");
    const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(req.body)).digest("hex");
    if (sig !== expected) throw new HttpError(401, "Bad Meta signature");
  }
  res.json({ ok: true });
  const token = getSetting("meta_page_token");
  for (const entry of req.body?.entry ?? []) for (const ch of entry.changes ?? []) {
    const leadId = String(ch.value?.leadgen_id ?? ""); if (!leadId || seen("meta", leadId)) continue;
    let fields: Record<string, string> = {}; let campaign = ch.value?.ad_id ? `ad ${ch.value.ad_id}` : undefined;
    if (token) {
      try {
        const r = await fetch(`https://graph.facebook.com/v19.0/${leadId}?fields=field_data,ad_name,adset_name,campaign_name&access_token=${token}`);
        const j: any = await r.json();
        for (const f of j.field_data ?? []) fields[String(f.name).toLowerCase()] = (f.values ?? []).join(", ");
        campaign = j.adset_name ?? j.campaign_name ?? j.ad_name ?? campaign;
      } catch { /* fall through with what we have */ }
    }
    const out = createInboundLead("Meta ads", { company: fields.company_name ?? fields.company, contact_name: fields.full_name ?? `${fields.first_name ?? ""} ${fields.last_name ?? ""}`.trim(), email: fields.email, phone: fields.phone_number ?? fields.phone, country: fields.country, source: "instagram", campaign, note: Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n") });
    record("meta", leadId, ch.value, `prospect ${out.id}${out.duplicate ? " (duplicate)" : ""}`);
  }
});

/* ---- Google Ads lead form extension: webhook URL /api/webhooks/google, key = google_lead_key ---- */
webhooksRouter.post("/google", (req, res) => {
  if (!getSetting("google_lead_key") || req.body?.google_key !== getSetting("google_lead_key")) throw new HttpError(401, "Bad Google key");
  const leadId = String(req.body.lead_id ?? ""); if (leadId && seen("google", leadId)) return res.json({ ok: true, skipped: true });
  const f: Record<string, string> = {};
  for (const c of req.body.user_column_data ?? []) f[String(c.column_id ?? c.column_name).toLowerCase()] = c.string_value;
  const out = createInboundLead("Google ads", { company: f.company_name, contact_name: f.full_name ?? "Unknown", email: f.email, phone: f.phone_number, country: f.country, source: "other", campaign: req.body.campaign_id ? `campaign ${req.body.campaign_id}` : undefined, note: Object.entries(f).map(([k, v]) => `${k}: ${v}`).join("\n") });
  record("google", leadId || null, req.body, `prospect ${out.id}`);
  res.json({ ok: true });
});

/* ---- WhatsApp Cloud API webhook: callback URL /api/webhooks/whatsapp, verify token = whatsapp_verify_token ---- */
webhooksRouter.get("/whatsapp", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && getSetting("whatsapp_verify_token") && req.query["hub.verify_token"] === getSetting("whatsapp_verify_token")) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
webhooksRouter.post("/whatsapp", (req, res) => {
  const secret = getSetting("meta_app_secret");
  if (secret) {
    const sig = String(req.headers["x-hub-signature-256"] ?? "").replace("sha256=", "");
    const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(req.body)).digest("hex");
    if (sig !== expected) throw new HttpError(401, "Bad Meta signature");
  }
  res.json({ ok: true });
  const uid = systemUser();
  for (const entry of req.body?.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {};
    const names: Record<string, string> = {};
    for (const c of v.contacts ?? []) names[String(c.wa_id)] = c.profile?.name ?? "";
    for (const m of v.messages ?? []) {
      const id = String(m.id ?? ""); if (!id || seen("whatsapp", id)) continue;
      const from = String(m.from ?? ""); const text = m.text?.body ?? (m.type ? `[${m.type} message]` : "");
      const ts = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : undefined;
      const norm = normalisePhone("+" + from);
      const p = norm ? db.prepare("SELECT * FROM prospects WHERE phone_norm = ?").get(norm) as any : null;
      if (!p) {
        const staff = norm ? db.prepare("SELECT id FROM users WHERE phone IS NOT NULL AND phone != '' AND substr(replace(replace(replace(phone,' ',''),'-',''),'+',''), -10) = ?").get(norm) as any : null;
        if (staff) { record("whatsapp", id, m, "message from staff number, ignored"); continue; }   // a team member texting the alert number
        const out = createInboundLead("WhatsApp", { contact_name: names[from] || `+${from}`, phone: "+" + from, source: "inbound", note: text });
        record("whatsapp", id, m, `new lead ${out.id}`); continue;
      }
      const owner = p.owner_id ?? uid;
      db.prepare("INSERT INTO notes (prospect_id, user_id, body, created_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))").run(p.id, owner, `WhatsApp from prospect: ${text}`, ts ?? null);
      if (p.stage === "contacted") { db.prepare("UPDATE prospects SET stage = 'replied', is_cold = 0, updated_at = datetime('now') WHERE id = ?").run(p.id); logActivity({ prospectId: p.id, userId: owner, type: "stage_change", detail: "contacted → replied (WhatsApp reply)" }); }
      if (p.owner_id) notify(p.owner_id, "whatsapp_reply", `WhatsApp reply: ${p.company}`, text.slice(0, 120), p.id);
      record("whatsapp", id, m, `prospect ${p.id}`);
    }
    for (const st of v.statuses ?? []) {
      if (st.status === "failed") {
        const err = (st.errors ?? []).map((e: any) => `${e.code} ${e.title ?? ""} ${e.message ?? ""}`).join("; ");
        db.prepare("INSERT INTO settings (key, value) VALUES ('whatsapp_last_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${new Date().toISOString()} delivery to ${st.recipient_id} failed: ${err || "unknown"}`);
      }
    }
  }
});

/* ---- ChatFlow (WhatsApp conversations): POST {key, phone, direction: 'in'|'out', text, agent_email?, timestamp?, id?} ---- */
webhooksRouter.post("/chatflow", (req, res) => {
  if (!getSetting("chatflow_key") || req.body?.key !== getSetting("chatflow_key")) throw new HttpError(401, "Bad ChatFlow key");
  const { phone, direction, text, agent_email, timestamp, id } = req.body ?? {};
  if (id && seen("chatflow", String(id))) return res.json({ ok: true, skipped: true });
  const norm = normalisePhone(phone);
  const p = norm ? db.prepare("SELECT * FROM prospects WHERE phone_norm = ?").get(norm) as any : null;
  if (!p) { const out = createInboundLead("WhatsApp", { contact_name: String(req.body.name ?? phone), phone, source: "inbound", note: text }); record("chatflow", id ? String(id) : null, req.body, `new lead ${out.id}`); return res.json({ ok: true, created: out.id }); }
  const agent = agent_email ? (db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(String(agent_email).toLowerCase()) as any)?.id : null;
  const uid = agent ?? p.owner_id ?? systemUser();
  if (direction === "out") logActivity({ prospectId: p.id, userId: uid, type: "messaged", detail: `WhatsApp: ${String(text ?? "").slice(0, 200)}`, occurredAt: timestamp });
  else {
    db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(p.id, uid, `WhatsApp from prospect: ${text ?? ""}`);
    if (p.stage === "contacted") { db.prepare("UPDATE prospects SET stage = 'replied', is_cold = 0 WHERE id = ?").run(p.id); logActivity({ prospectId: p.id, userId: uid, type: "stage_change", detail: "contacted → replied (WhatsApp reply)" }); }
    if (p.owner_id) notify(p.owner_id, "whatsapp_reply", `WhatsApp reply: ${p.company}`, String(text ?? "").slice(0, 120), p.id);
  }
  record("chatflow", id ? String(id) : null, req.body, `prospect ${p.id}`);
  res.json({ ok: true });
});
