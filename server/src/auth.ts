import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { HttpError, forbidden } from "./errors.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "tdm-dev-secret-change-me";

export type Role = "owner" | "manager" | "agent";
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  commission_model: "profit_split" | "revenue_share";
  commission_rate: number;
  active: number;
}

declare global {
  namespace Express {
    interface Request { user: AuthUser }
  }
}

export function signToken(user: AuthUser) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "30d" });
}
export function hashPassword(pw: string) { return bcrypt.hashSync(pw, 10); }
export function checkPassword(pw: string, hash: string) { return bcrypt.compareSync(pw, hash); }

export function loadUser(id: number): AuthUser | undefined {
  return db.prepare("SELECT id, name, email, role, commission_model, commission_rate, active FROM users WHERE id = ?").get(id) as AuthUser | undefined;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, "Login required"));
  try {
    const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
    const user = loadUser(Number(payload.sub));
    if (!user || !user.active) return next(new HttpError(401, "Account inactive"));
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, "Session expired, log in again"));
  }
}

export const isManagement = (u: AuthUser) => u.role === "owner" || u.role === "manager";
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
