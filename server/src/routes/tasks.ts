import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { isManagement } from "../auth.js";
import { bad, forbidden, notFound } from "../errors.js";
import { logActivity, notify } from "../log.js";
import { addDays } from "../time.js";

export const tasksRouter = Router();

tasksRouter.get("/", (req, res) => {
  const q = req.query as Record<string, string>;
  const where: string[] = []; const params: unknown[] = [];
  if (!isManagement(req.user)) { where.push("t.assigned_to = ?"); params.push(req.user.id); }
  else if (q.assigned_to) { where.push("t.assigned_to = ?"); params.push(Number(q.assigned_to)); }
  if (q.status) { where.push("t.status = ?"); params.push(q.status); } else if (q.open === "1") where.push("t.status IN ('open','in_progress','blocked')");
  res.json(db.prepare(`SELECT t.*, a.name AS assigned_to_name, b.name AS assigned_by_name, p.company FROM tasks t JOIN users a ON a.id = t.assigned_to JOIN users b ON b.id = t.assigned_by LEFT JOIN prospects p ON p.id = t.prospect_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.status = 'done', t.due_date, t.priority = 'low'`).all(...params));
});

tasksRouter.post("/", (req, res) => {
  if (!isManagement(req.user)) throw forbidden("Only Abdul or Adnan assign tasks");
  const body = z.object({ title: z.string().min(1), description: z.string().optional(), assigned_to: z.number(), prospect_id: z.number().optional().nullable(), due_date: z.string(), priority: z.enum(["high", "normal", "low"]).default("normal"), recurrence: z.enum(["daily", "weekly", "monthly"]).optional().nullable() }).parse(req.body);
  const r = db.prepare("INSERT INTO tasks (title, description, assigned_to, assigned_by, prospect_id, due_date, priority, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(body.title, body.description ?? null, body.assigned_to, req.user.id, body.prospect_id ?? null, body.due_date, body.priority, body.recurrence ?? null);
  notify(body.assigned_to, "task_assigned", `Task: ${body.title}`, `Due ${body.due_date}`, body.prospect_id ?? null);
  res.status(201).json({ id: r.lastInsertRowid });
});

tasksRouter.patch("/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(req.params.id)) as any;
  if (!t) throw notFound();
  if (!(isManagement(req.user) || t.assigned_to === req.user.id)) throw forbidden();
  const body = z.object({
    status: z.enum(["open", "in_progress", "done", "blocked"]).optional(), completion_note: z.string().optional(), blocked_reason: z.string().optional(),
    title: z.string().optional(), description: z.string().optional(), due_date: z.string().optional(), priority: z.enum(["high", "normal", "low"]).optional(), assigned_to: z.number().optional(), client_created_at: z.string().optional(),
  }).parse(req.body);
  if (body.status === "done" && !body.completion_note?.trim()) throw bad("Write what was done before marking done");
  if (body.status === "blocked" && !body.blocked_reason?.trim()) throw bad("A blocked task needs a reason");
  const mgmtOnly = ["title", "description", "due_date", "priority", "assigned_to"];
  const sets: string[] = ["updated_at = datetime('now')"]; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || k === "client_created_at") continue;
    if (mgmtOnly.includes(k) && !isManagement(req.user)) throw forbidden("Only Abdul or Adnan can edit task details");
    sets.push(`${k} = ?`); vals.push(v);
  }
  const tx = db.transaction(() => {
    if (body.status === "done") { sets.push("completed_at = COALESCE(?, datetime('now'))"); vals.push(body.client_created_at ?? null); }
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, t.id);
    if (body.status === "done") {
      logActivity({ prospectId: t.prospect_id, userId: req.user.id, type: "task_done", detail: `${t.title}: ${body.completion_note}`, occurredAt: body.client_created_at });
      if (t.recurrence) {
        const next = t.recurrence === "daily" ? addDays(t.due_date, 1) : t.recurrence === "weekly" ? addDays(t.due_date, 7) : addDays(t.due_date, 30);
        db.prepare("INSERT INTO tasks (title, description, assigned_to, assigned_by, prospect_id, due_date, priority, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(t.title, t.description, t.assigned_to, t.assigned_by, t.prospect_id, next, t.priority, t.recurrence);
      }
    }
    if (body.status === "blocked") notify(t.assigned_by, "task_blocked", `Task blocked: ${t.title}`, body.blocked_reason, t.prospect_id);
  });
  tx();
  res.json({ ok: true });
});
