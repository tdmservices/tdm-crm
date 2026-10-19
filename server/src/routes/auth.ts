import { Router } from "express";
import { z } from "zod";
import { db, getSetting } from "../db.js";
import { checkPassword, signToken, requireAuth, hashPassword } from "../auth.js";
import { HttpError } from "../errors.js";
import { audit } from "../log.js";

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1), app_version: z.string().optional() }).parse(req.body);
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(body.email) as any;
  if (!u || !checkPassword(body.password, u.password_hash)) throw new HttpError(401, "Wrong email or password");
  if (!u.active) throw new HttpError(401, "This account has been deactivated");
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
  audit(u.id, "user", u.id, "login", { app_version: body.app_version });
  const { password_hash, ...user } = u;
  res.json({ token: signToken(user), user, min_app_version: getSetting("min_app_version"), apk_download_url: getSetting("apk_download_url") });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user, min_app_version: getSetting("min_app_version"), apk_download_url: getSetting("apk_download_url") });
});

authRouter.post("/change-password", requireAuth, (req, res) => {
  const body = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
  const u = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id) as any;
  if (!checkPassword(body.current, u.password_hash)) throw new HttpError(400, "Current password is wrong");
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(body.next), req.user.id);
  res.json({ ok: true });
});

/** Version gate for the sideloaded APK. */
authRouter.get("/version", (_req, res) => {
  res.json({ min_app_version: getSetting("min_app_version"), apk_download_url: getSetting("apk_download_url") });
});
