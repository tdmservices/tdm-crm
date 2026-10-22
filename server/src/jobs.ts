/** Scheduled housekeeping and reminders (Phase 3). Runs every 10 minutes; each job records its own last run so it fires once per day/hour. */
import { db, getSetting } from "./db.js";
import { notify, notifyManagement } from "./log.js";
import { pkDate, addDays, pkDayStartIso } from "./time.js";
import { awardTargets } from "./routes/targets.js";
import { rollRetainerMonths } from "./routes/schedule.js";
import { pollMailbox } from "./imap.js";

function ran(key: string, period: string): boolean {
  const row = db.prepare("SELECT last_run FROM job_log WHERE key = ?").get(key) as any;
  if (row && row.last_run === period) return true;
  db.prepare("INSERT INTO job_log (key, last_run) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_run = excluded.last_run").run(key, period);
  return false;
}
function pkHour() { return (new Date().getUTCHours() + 5) % 24; }

export function runJobs() {
  const today = pkDate(); const hour = pkHour();
  try { awardTargets(); } catch (e) { console.error("targets", e); }
  try { rollRetainerMonths(); } catch (e) { console.error("retainers", e); }

  // Overdue scheduled payments: once a day, to Abdul/Adnan and the deal owner
  if (!ran("overdue_payments", today)) {
    const rows = db.prepare("SELECT s.id, s.name, s.expected_date, s.amount, s.currency, p.id AS pid, p.company, p.owner_id FROM payment_schedule s JOIN prospects p ON p.id = s.prospect_id WHERE s.payment_id IS NULL AND s.expected_date < ? AND p.after_close_status IN ('in_delivery','active_retainer')").all(today) as any[];
    for (const r of rows) {
      notifyManagement("payment_overdue", `Payment overdue: ${r.company}`, `${r.name} of ${r.amount} ${r.currency} was expected ${r.expected_date}`, r.pid);
      if (r.owner_id) notify(r.owner_id, "payment_overdue", `Client payment overdue: ${r.company}`, `${r.name} expected ${r.expected_date}. Chase the client.`, r.pid);
    }
  }
  // Morning digest to each agent
  const morning = Number(getSetting("reminder_morning_hour") ?? 9);
  if (hour >= morning && !ran("morning_digest", today)) {
    for (const a of db.prepare("SELECT id FROM users WHERE active = 1 AND role = 'agent'").all() as any[]) {
      const overdue = (db.prepare("SELECT COUNT(*) c FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE p.owner_id = ? AND f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost')").get(a.id, today) as any).c;
      const due = (db.prepare("SELECT COUNT(*) c FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE p.owner_id = ? AND f.done_at IS NULL AND f.due_date = ?").get(a.id, today) as any).c;
      const tasks = (db.prepare("SELECT COUNT(*) c FROM tasks WHERE assigned_to = ? AND status IN ('open','in_progress') AND due_date <= ?").get(a.id, today) as any).c;
      const meetings = (db.prepare("SELECT COUNT(*) c FROM meetings WHERE credited_to = ? AND status = 'booked' AND scheduled_at >= ? AND scheduled_at < ?").get(a.id, pkDayStartIso(today), pkDayStartIso(addDays(today, 1))) as any).c;
      notify(a.id, "digest", "Your day", `${overdue} overdue, ${due} follow-ups due today, ${tasks} tasks, ${meetings} meetings.`);
    }
  }
  // End-of-day reminder to anyone who has not submitted
  const eod = Number(getSetting("reminder_eod_hour") ?? 18);
  if (hour >= eod && !ran("eod_reminder", today)) {
    for (const a of db.prepare("SELECT id FROM users WHERE active = 1 AND role = 'agent'").all() as any[]) {
      if (!db.prepare("SELECT 1 FROM eod_reports WHERE user_id = ? AND report_date = ?").get(a.id, today)) notify(a.id, "eod_reminder", "End of day report", "One line: what did you do today?");
    }
  }
  // Owner alerts: zero activity today (after 2pm), follow-ups overdue > 2 days, project overdue
  if (hour >= 14 && !ran("owner_alerts", today)) {
    const alertDays = Number(getSetting("overdue_alert_days") ?? 2);
    const tb = pkDayStartIso(today);
    const idle = db.prepare("SELECT u.name FROM users u WHERE u.active = 1 AND u.role = 'agent' AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id AND a.is_outreach = 1 AND a.occurred_at >= ?)").all(tb) as any[];
    if (idle.length) notifyManagement("zero_activity", `No activity today: ${idle.map(i => i.name).join(", ")}`);
    const stale = (db.prepare("SELECT COUNT(*) c FROM follow_ups f JOIN prospects p ON p.id = f.prospect_id WHERE f.done_at IS NULL AND f.due_date < ? AND p.stage NOT IN ('closed_won','closed_lost')").get(addDays(today, -alertDays)) as any).c;
    if (stale) notifyManagement("overdue_followups", `${stale} follow-ups overdue more than ${alertDays} days`);
    const late = db.prepare("SELECT company, id FROM prospects WHERE after_close_status = 'in_delivery' AND expected_delivery_date < ?").all(today) as any[];
    for (const l of late) notifyManagement("project_overdue", `Project overdue: ${l.company}`, undefined, l.id);
  }
  // Email capture every 10 minutes
  void pollMailbox().catch(e => console.error("imap", (e as Error).message));
}

export function startJobs() {
  setTimeout(() => runJobs(), 5000);
  setInterval(() => runJobs(), 10 * 60 * 1000);
}
