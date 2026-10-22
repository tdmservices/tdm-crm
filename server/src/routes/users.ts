import { Router } from "express";
import { z } from "zod";
import { db, getSetting, setSetting } from "../db.js";
import { requireRole, hashPassword } from "../auth.js";
import { audit } from "../log.js";
import { notFound } from "../errors.js";
import { refreshRates, rateFor, SUPPORTED } from "../fx.js";

export const usersRouter = Router();

/** Everyone may list names (needed for partner picker and leaderboards). */
usersRouter.get("/", (req, res) => {
  const rows = db.prepare("SELECT id, name, role, active FROM users ORDER BY name").all() as any[];
  if (req.user.role === "agent") return res.json(rows.filter(r => r.active));
  res.json(db.prepare("SELECT id, name, email, role, commission_model, commission_rate, active, last_login_at, created_at FROM users ORDER BY name").all());
});

usersRouter.post("/", requireRole("owner"), (req, res) => {
  const body = z.object({
    name: z.string().min(1), email: z.string().email(), password: z.string().min(8),
    role: z.enum(["owner", "manager", "agent"]),
    commission_model: z.enum(["profit_split", "revenue_share"]).default("revenue_share"),
    commission_rate: z.number().min(0).max(1).default(0.30),
  }).parse(req.body);
  const r = db.prepare("INSERT INTO users (name, email, password_hash, role, commission_model, commission_rate) VALUES (?, ?, ?, ?, ?, ?)")
    .run(body.name, body.email, hashPassword(body.password), body.role, body.commission_model, body.commission_rate);
  audit(req.user.id, "user", Number(r.lastInsertRowid), "create", { ...body, password: undefined });
  res.status(201).json({ id: r.lastInsertRowid });
});

usersRouter.patch("/:id", requireRole("owner"), (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({
    name: z.string().min(1).optional(), email: z.string().email().optional(), password: z.string().min(8).optional(),
    role: z.enum(["owner", "manager", "agent"]).optional(),
    commission_model: z.enum(["profit_split", "revenue_share"]).optional(),
    commission_rate: z.number().min(0).max(1).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!u) throw notFound();
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === "password") { sets.push("password_hash = ?"); vals.push(hashPassword(v as string)); }
    else if (k === "active") { sets.push("active = ?"); vals.push(v ? 1 : 0); }
    else { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }
  audit(req.user.id, "user", id, "update", { ...body, password: body.password ? "[changed]" : undefined });
  res.json({ ok: true });
});

/** Own notification preferences and phone (for WhatsApp alerts). */
usersRouter.patch("/me/preferences", (req, res) => {
  const b = z.object({ notify_email: z.boolean().optional(), notify_whatsapp: z.boolean().optional(), notify_push: z.boolean().optional(), phone: z.string().optional().nullable() }).parse(req.body);
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) if (v !== undefined) { sets.push(`${k} = ?`); vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v); }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, req.user.id);
  res.json(db.prepare("SELECT notify_email, notify_whatsapp, notify_push, phone FROM users WHERE id = ?").get(req.user.id));
});
usersRouter.get("/me/preferences", (req, res) => {
  res.json({ ...(db.prepare("SELECT notify_email, notify_whatsapp, notify_push, phone FROM users WHERE id = ?").get(req.user.id) as object), vapid_public: getSetting("vapid_public") ?? null, push_count: (db.prepare("SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?").get(req.user.id) as any).c });
});
usersRouter.post("/me/push", (req, res) => {
  const b = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body);
  db.prepare("INSERT INTO push_subscriptions (user_id, kind, endpoint, keys_json) VALUES (?, 'webpush', ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json").run(req.user.id, b.endpoint, JSON.stringify(b.keys));
  res.json({ ok: true });
});
usersRouter.delete("/me/push", (req, res) => {
  const b = z.object({ endpoint: z.string() }).parse(req.body);
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(b.endpoint, req.user.id);
  res.json({ ok: true });
});

/* ---- Settings ---- */
export const settingsRouter = Router();
const SECRET_KEYS = ["smtp_pass", "whatsapp_token", "calendly_signing_key", "meta_page_token", "meta_app_secret", "google_lead_key", "chatflow_key", "imap_pass", "vapid_private"];
settingsRouter.get("/", requireRole("owner", "manager"), (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const out = Object.fromEntries(rows.map(r => [r.key, req.user.role === "owner" || !SECRET_KEYS.includes(r.key) ? r.value : (r.value ? "••••••" : "")]));
  res.json(out);
});
/** Branding visible to everyone (agency name, logo, display currency). */
settingsRouter.get("/branding", (_req, res) => {
  res.json({ agency_name: getSetting("agency_name"), agency_logo_url: getSetting("agency_logo_url"), display_currency: getSetting("display_currency") });
});
settingsRouter.put("/", requireRole("owner"), (req, res) => {
  const body = z.record(z.string(), z.string()).parse(req.body);
  for (const [k, v] of Object.entries(body)) { if (v === "••••••") continue; setSetting(k, v); }
  audit(req.user.id, "settings", null, "update", Object.fromEntries(Object.keys(body).map(k => [k, SECRET_KEYS.includes(k) ? "[secret]" : body[k]])));
  res.json({ ok: true });
});
settingsRouter.get("/rates", (_req, res) => {
  const out: Record<string, unknown> = {};
  for (const c of SUPPORTED) { try { out[c] = rateFor(c); } catch { out[c] = null; } }
  res.json({ rates: out, currencies: SUPPORTED, daily_min_activities: Number(getSetting("daily_min_activities")) });
});
settingsRouter.post("/rates/refresh", requireRole("owner", "manager"), async (_req, res) => {
  res.json(await refreshRates());
});
