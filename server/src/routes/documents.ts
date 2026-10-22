/** Proposals and invoices generated from a deal (Later phase). Rendered as printable HTML by the web app. */
import { Router } from "express";
import { z } from "zod";
import { db, getSetting } from "../db.js";
import { isManagement } from "../auth.js";
import { forbidden, notFound } from "../errors.js";
import { logActivity } from "../log.js";
import { round2 } from "../fx.js";
import { pkDate, addDays } from "../time.js";

export const documentsRouter = Router();

function nextNumber(type: "proposal" | "invoice") {
  const prefix = getSetting(type === "invoice" ? "invoice_prefix" : "proposal_prefix") ?? (type === "invoice" ? "INV" : "PRO");
  const n = (db.prepare("SELECT COUNT(*) c FROM documents WHERE type = ?").get(type) as any).c + 1;
  return `${prefix}-${pkDate().slice(0, 4)}-${String(n).padStart(4, "0")}`;
}
const line = z.object({ description: z.string().min(1), qty: z.number().positive().default(1), unit_price: z.number().min(0) });

documentsRouter.get("/", (req, res) => {
  const q = req.query as Record<string, string>;
  const where: string[] = []; const params: unknown[] = [];
  if (q.prospect_id) { where.push("d.prospect_id = ?"); params.push(Number(q.prospect_id)); }
  if (!isManagement(req.user)) { where.push("(p.owner_id = ? OR p.partner_id = ?)"); params.push(req.user.id, req.user.id); }
  res.json(db.prepare(`SELECT d.*, p.company FROM documents d JOIN prospects p ON p.id = d.prospect_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.created_at DESC LIMIT 200`).all(...params));
});

documentsRouter.post("/", (req, res) => {
  const b = z.object({ prospect_id: z.number(), type: z.enum(["proposal", "invoice"]), title: z.string().min(1), lines: z.array(line).min(1), currency: z.string().default("USD"), tax_rate: z.number().min(0).max(100).default(Number(getSetting("tax_rate") ?? 0)), notes: z.string().optional(), due_days: z.number().int().min(0).default(14), schedule_id: z.number().optional().nullable() }).parse(req.body);
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(b.prospect_id) as any;
  if (!p) throw notFound();
  if (!isManagement(req.user) && p.owner_id !== req.user.id && p.partner_id !== req.user.id) throw forbidden();
  if (b.type === "invoice" && !isManagement(req.user)) throw forbidden("Invoices are issued by Abdul or Adnan");
  const subtotal = round2(b.lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const total = round2(subtotal * (1 + b.tax_rate / 100));
  const r = db.prepare("INSERT INTO documents (prospect_id, type, number, title, lines_json, currency, subtotal, tax_rate, total, notes, issued_at, due_date, schedule_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)")
    .run(p.id, b.type, nextNumber(b.type), b.title, JSON.stringify(b.lines), b.currency.toUpperCase(), subtotal, b.tax_rate, total, b.notes ?? null, pkDate(), b.type === "invoice" ? addDays(pkDate(), b.due_days) : null, b.schedule_id ?? null, req.user.id);
  logActivity({ prospectId: p.id, userId: req.user.id, type: `${b.type}_created`, detail: `${b.title} ${total} ${b.currency.toUpperCase()}` });
  res.status(201).json({ id: r.lastInsertRowid });
});

/** Build an invoice straight from a scheduled payment line. */
documentsRouter.post("/from-schedule/:scheduleId", (req, res) => {
  if (!isManagement(req.user)) throw forbidden();
  const s = db.prepare("SELECT s.*, p.company FROM payment_schedule s JOIN prospects p ON p.id = s.prospect_id WHERE s.id = ?").get(Number(req.params.scheduleId)) as any;
  if (!s) throw notFound();
  const tax = Number(getSetting("tax_rate") ?? 0);
  const total = round2(s.amount * (1 + tax / 100));
  const r = db.prepare("INSERT INTO documents (prospect_id, type, number, title, lines_json, currency, subtotal, tax_rate, total, issued_at, due_date, schedule_id, status, created_by) VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)")
    .run(s.prospect_id, nextNumber("invoice"), `Invoice: ${s.name}`, JSON.stringify([{ description: s.name, qty: 1, unit_price: s.amount }]), s.currency, s.amount, tax, total, pkDate(), s.expected_date, s.id, req.user.id);
  logActivity({ prospectId: s.prospect_id, userId: req.user.id, type: "invoice_created", detail: `${s.name} ${s.amount} ${s.currency}` });
  res.status(201).json({ id: r.lastInsertRowid });
});

documentsRouter.get("/:id", (req, res) => {
  const d = db.prepare("SELECT d.*, p.company, p.contact_name, p.email, p.phone, p.country, p.website, u.name AS created_by_name FROM documents d JOIN prospects p ON p.id = d.prospect_id JOIN users u ON u.id = d.created_by WHERE d.id = ?").get(Number(req.params.id)) as any;
  if (!d) throw notFound();
  const p = db.prepare("SELECT owner_id, partner_id FROM prospects WHERE id = ?").get(d.prospect_id) as any;
  if (!isManagement(req.user) && p.owner_id !== req.user.id && p.partner_id !== req.user.id) throw forbidden();
  res.json({ ...d, lines: JSON.parse(d.lines_json), agency: { name: getSetting("agency_name"), logo: getSetting("agency_logo_url"), address: getSetting("agency_address"), bank: getSetting("agency_bank_details") } });
});

documentsRouter.patch("/:id", (req, res) => {
  const d = db.prepare("SELECT * FROM documents WHERE id = ?").get(Number(req.params.id)) as any;
  if (!d) throw notFound();
  const p = db.prepare("SELECT owner_id, partner_id FROM prospects WHERE id = ?").get(d.prospect_id) as any;
  if (!isManagement(req.user) && p.owner_id !== req.user.id && p.partner_id !== req.user.id) throw forbidden();
  const b = z.object({ status: z.enum(["draft", "sent", "accepted", "paid", "void"]).optional(), notes: z.string().optional() }).parse(req.body);
  if (b.status) db.prepare("UPDATE documents SET status = ? WHERE id = ?").run(b.status, d.id);
  if (b.notes !== undefined) db.prepare("UPDATE documents SET notes = ? WHERE id = ?").run(b.notes, d.id);
  if (b.status === "sent" && d.type === "proposal") {
    const pr = db.prepare("SELECT stage FROM prospects WHERE id = ?").get(d.prospect_id) as any;
    if (["meeting_held", "replied", "meeting_booked", "contacted"].includes(pr.stage)) logActivity({ prospectId: d.prospect_id, userId: req.user.id, type: "proposal_sent_doc", detail: `${d.number} sent; move the stage to Proposal sent` });
  }
  res.json({ ok: true });
});

/* ---- Client portal (no login): a per-deal link showing schedule, payments and documents ---- */
export const portalRouter = Router();
portalRouter.get("/:token", (req, res) => {
  const p = db.prepare("SELECT id, company, contact_name, deal_value, deal_currency, engagement_model, after_close_status, closed_won_at FROM prospects WHERE portal_token = ?").get(req.params.token) as any;
  if (!p) throw notFound("This link is not valid");
  const schedule = db.prepare("SELECT s.id, s.name, s.amount, s.currency, s.expected_date, s.payment_id, pay.received_at, pay.reversed_at FROM payment_schedule s LEFT JOIN payments pay ON pay.id = s.payment_id WHERE s.prospect_id = ? ORDER BY s.sort, s.expected_date").all(p.id) as any[];
  const today = pkDate();
  res.json({
    agency: { name: getSetting("agency_name"), logo: getSetting("agency_logo_url"), bank: getSetting("agency_bank_details") },
    deal: p,
    schedule: schedule.map(s => ({ ...s, status: s.payment_id && !s.reversed_at ? "received" : s.expected_date < today ? "overdue" : "expected" })),
    payments: db.prepare("SELECT label, amount, currency, received_at FROM payments WHERE prospect_id = ? AND reversed_at IS NULL ORDER BY received_at").all(p.id),
    documents: db.prepare("SELECT id, type, number, title, total, currency, issued_at, due_date, status FROM documents WHERE prospect_id = ? AND status != 'draft' AND status != 'void' ORDER BY issued_at DESC").all(p.id),
  });
});
portalRouter.get("/:token/documents/:id", (req, res) => {
  const p = db.prepare("SELECT id FROM prospects WHERE portal_token = ?").get(req.params.token) as any;
  if (!p) throw notFound();
  const d = db.prepare("SELECT d.*, p.company, p.contact_name, p.email, p.country FROM documents d JOIN prospects p ON p.id = d.prospect_id WHERE d.id = ? AND d.prospect_id = ? AND d.status NOT IN ('draft','void')").get(Number(req.params.id), p.id) as any;
  if (!d) throw notFound();
  res.json({ ...d, lines: JSON.parse(d.lines_json), agency: { name: getSetting("agency_name"), logo: getSetting("agency_logo_url"), address: getSetting("agency_address"), bank: getSetting("agency_bank_details") } });
});
