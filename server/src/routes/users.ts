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

/* ---- Settings ---- */
export const settingsRouter = Router();
settingsRouter.get("/", requireRole("owner", "manager"), (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
settingsRouter.put("/", requireRole("owner"), (req, res) => {
  const body = z.record(z.string(), z.string()).parse(req.body);
  for (const [k, v] of Object.entries(body)) setSetting(k, v);
  audit(req.user.id, "settings", null, "update", body);
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
