import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), "data/tdm.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','agent')),
  commission_model TEXT NOT NULL DEFAULT 'revenue_share' CHECK (commission_model IN ('profit_split','revenue_share')),
  commission_rate REAL NOT NULL DEFAULT 0.30,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL,
  rate_date TEXT NOT NULL,            -- YYYY-MM-DD (Pakistan time)
  usd_per_unit REAL NOT NULL,         -- 1 unit of currency = usd_per_unit USD
  is_fallback INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (currency, rate_date)
);

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY,
  client_uuid TEXT UNIQUE,            -- offline dedupe
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  phone_norm TEXT,
  website TEXT,
  domain TEXT,
  country TEXT,
  source TEXT NOT NULL,
  service_interest TEXT NOT NULL,
  campaign_tag TEXT,
  owner_id INTEGER REFERENCES users(id),   -- NULL = unassigned pool
  partner_id INTEGER REFERENCES users(id),
  partner_since TEXT,
  stage TEXT NOT NULL DEFAULT 'new_lead',
  next_follow_up TEXT,
  last_activity_at TEXT,
  contacted_at TEXT,
  is_cold INTEGER NOT NULL DEFAULT 0,
  deal_value REAL,
  deal_currency TEXT,
  deal_value_usd REAL,
  fx_rate_used REAL,
  fx_fallback INTEGER NOT NULL DEFAULT 0,
  engagement_model TEXT,
  payment_terms TEXT,
  proposal_sent_at TEXT,
  closed_won_requested_at TEXT,
  closed_won_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  lost_reason TEXT,
  closed_lost_at TEXT,
  after_close_status TEXT,            -- in_delivery | project_delivered | active_retainer | retainer_finished
  expected_delivery_date TEXT,
  delivered_at TEXT,
  retainer_finished_at TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  client_created_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prospects_owner ON prospects(owner_id);
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email);
CREATE INDEX IF NOT EXISTS idx_prospects_phone ON prospects(phone_norm);
CREATE INDEX IF NOT EXISTS idx_prospects_domain ON prospects(domain);

CREATE TABLE IF NOT EXISTS partner_requests (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  credited_to INTEGER NOT NULL REFERENCES users(id),
  booked_by INTEGER NOT NULL REFERENCES users(id),
  scheduled_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  link TEXT,
  prep_notes TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','held','no_show','rebooked')),
  rebooked_from INTEGER REFERENCES meetings(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_credit ON meetings(credited_to, created_at);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER REFERENCES prospects(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                 -- emailed, called, messaged, met, no_answer, stage_change, field_edit, note, task_done, meeting_booked, ...
  detail TEXT,
  is_outreach INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_prospect ON activities(prospect_id, occurred_at);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  due_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',  -- manual | auto_d3 | auto_d7 | auto_d14 | proposal_chase
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followups_open ON follow_ups(prospect_id, done_at);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  prospect_id INTEGER REFERENCES prospects(id),
  due_date TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','blocked')),
  completion_note TEXT,
  blocked_reason TEXT,
  recurrence TEXT,                    -- daily | weekly | monthly | NULL
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  sequence INTEGER NOT NULL,          -- 1 = first payment on the deal
  label TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  fx_rate_used REAL NOT NULL,
  fx_fallback INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  note TEXT,
  reversed_at TEXT,
  reversed_by INTEGER REFERENCES users(id),
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commission_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  prospect_id INTEGER REFERENCES prospects(id),
  payment_id INTEGER REFERENCES payments(id),
  kind TEXT NOT NULL DEFAULT 'sales' CHECK (kind IN ('sales','bonus','clawback','true_up')),
  model TEXT,                         -- profit_split | revenue_share | retainer_share | shared_revenue | shared_retainer
  rate REAL,
  base_usd REAL,                      -- amount commission was computed on
  cost_share_usd REAL,
  amount_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','payable','paid','reversed')),
  description TEXT,
  frozen INTEGER NOT NULL DEFAULT 0,  -- reassignment freeze
  paid_at TEXT,
  paid_amount_usd REAL,
  paid_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commission_user ON commission_entries(user_id, status);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('user','team')),
  user_ids TEXT,                      -- JSON array when scope=user
  metric TEXT NOT NULL,               -- activities | meetings_booked | meetings_held | deals_closed | revenue_usd | leads_added
  number REAL NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('week','month','quarter','custom')),
  custom_start TEXT,
  custom_end TEXT,
  repeat INTEGER NOT NULL DEFAULT 1,
  bonus_usd REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS target_awards (
  id INTEGER PRIMARY KEY,
  target_id INTEGER NOT NULL REFERENCES targets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  achieved_value REAL NOT NULL,
  commission_entry_id INTEGER REFERENCES commission_entries(id),
  awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (target_id, user_id, period_start)
);

CREATE TABLE IF NOT EXISTS eod_reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  report_date TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, report_date)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  prospect_id INTEGER REFERENCES prospects(id),
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

db.exec(SCHEMA);

const defaultSettings: Record<string, string> = {
  clawback_days: "30",
  daily_min_activities: "30",
  min_app_version: "1.0.0",
  apk_download_url: "",
  pkr_display_currency: "PKR",
  fx_fallback_pkr: "0.0036",   // used only if no rate has ever been fetched
  fx_fallback_aed: "0.2723",
  fx_fallback_gbp: "1.27",
  fx_fallback_eur: "1.09",
  overdue_alert_days: "2",
  proposal_chase_days: "5",
};
const insSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(defaultSettings)) insSetting.run(k, v);

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
