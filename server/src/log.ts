import { db } from "./db.js";

export const OUTREACH_TYPES = new Set(["emailed", "called", "messaged", "met", "no_answer", "whatsapp_tap", "call_tap", "email_tap"]);

export function logActivity(opts: { prospectId: number | null; userId: number; type: string; detail?: string; occurredAt?: string }) {
  const isOutreach = OUTREACH_TYPES.has(opts.type) ? 1 : 0;
  const occurred = opts.occurredAt ?? new Date().toISOString();
  db.prepare("INSERT INTO activities (prospect_id, user_id, type, detail, is_outreach, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(opts.prospectId, opts.userId, opts.type, opts.detail ?? null, isOutreach, occurred);
  if (opts.prospectId) {
    db.prepare("UPDATE prospects SET last_activity_at = MAX(COALESCE(last_activity_at,''), ?) WHERE id = ?").run(occurred, opts.prospectId);
  }
}

export function audit(userId: number | null, entity: string, entityId: number | null, action: string, detail?: unknown) {
  db.prepare("INSERT INTO audit_log (user_id, entity, entity_id, action, detail) VALUES (?, ?, ?, ?, ?)")
    .run(userId, entity, entityId, action, detail === undefined ? null : JSON.stringify(detail));
}

export function notify(userId: number, type: string, title: string, body?: string, prospectId?: number | null) {
  db.prepare("INSERT INTO notifications (user_id, type, title, body, prospect_id) VALUES (?, ?, ?, ?, ?)")
    .run(userId, type, title, body ?? null, prospectId ?? null);
}
