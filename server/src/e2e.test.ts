process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

let server: Server; let base = "";
const tokens: Record<string, string> = {};
async function api(as: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

test("setup", async () => {
  const { app } = await import("./index.js");
  const { db } = await import("./db.js");
  const { hashPassword } = await import("./auth.js");
  for (const [n, e, r, m, rate] of [["Abdul", "abdul@t.co", "owner", "revenue_share", 0.3], ["Adnan", "adnan@t.co", "manager", "revenue_share", 0.3], ["Haider", "haider@t.co", "agent", "revenue_share", 0.3], ["Hassaan", "hassaan@t.co", "agent", "profit_split", 0.5], ["Noman", "noman@t.co", "agent", "revenue_share", 0.3]] as const)
    db.prepare("INSERT INTO users (name, email, password_hash, role, commission_model, commission_rate) VALUES (?, ?, ?, ?, ?, ?)").run(n, e, hashPassword("pw"), r, m, rate);
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const u of ["abdul", "adnan", "haider", "hassaan", "noman"]) {
    const r = await api("", "POST", "/api/auth/login", { email: `${u}@t.co`, password: "pw" });
    assert.equal(r.status, 200, JSON.stringify(r.json)); tokens[u] = r.json.token;
  }
});

let A = 0;
test("agent adds prospect, first outreach creates auto follow-ups", async () => {
  const r = await api("haider", "POST", "/api/prospects", { company: "Acme", contact_name: "Jo", email: "jo@acme.com", phone: "+92 300 1234567", website: "https://www.acme.com/", source: "cold_email", service_interest: "web_shopify" });
  assert.equal(r.status, 201); A = r.json.id;
  const act = await api("haider", "POST", `/api/prospects/${A}/activities`, { type: "emailed" });
  assert.equal(act.status, 201);
  const d = await api("haider", "GET", `/api/prospects/${A}`);
  assert.equal(d.json.prospect.stage, "contacted");
  assert.equal(d.json.follow_ups.filter((f: any) => !f.done_at).length, 3);
});

test("duplicate detection blocks second record and partner flow works", async () => {
  const dup = await api("hassaan", "POST", "/api/prospects", { company: "ACME Ltd", contact_name: "Someone", email: "other@acme.com", source: "linkedin", service_interest: "seo_aeo_geo" });
  assert.equal(dup.status, 409); assert.equal(dup.json.duplicate.owner_name, "Haider"); assert.ok(!("deal_value" in dup.json.duplicate));
  const vis = await api("hassaan", "GET", `/api/prospects/${A}`); assert.equal(vis.status, 403);
  const req = await api("hassaan", "POST", `/api/prospects/${A}/partner-request`, {}); assert.equal(req.status, 201);
  const d = await api("abdul", "GET", `/api/prospects/${A}`);
  const pr = d.json.partner_requests[0];
  const ok = await api("adnan", "POST", `/api/prospects/${A}/partner-request/${pr.id}`, { accept: true }); assert.equal(ok.status, 200);
  const vis2 = await api("hassaan", "GET", `/api/prospects/${A}`); assert.equal(vis2.status, 200);
  const list = await api("noman", "GET", "/api/prospects"); assert.equal(list.json.length, 0);
});

test("agents cannot log meetings; Abdul logs and credits owner; leaderboard counts", async () => {
  const no = await api("haider", "POST", "/api/meetings", { prospect_id: A, scheduled_at: "2026-10-20T10:00:00Z" }); assert.equal(no.status, 403);
  const m = await api("abdul", "POST", "/api/meetings", { prospect_id: A, scheduled_at: "2026-10-20T10:00:00Z", link: "https://meet" }); assert.equal(m.status, 201);
  const d = await api("haider", "GET", `/api/prospects/${A}`); assert.equal(d.json.prospect.stage, "meeting_booked");
  const lb = await api("haider", "GET", "/api/leaderboard?period=month");
  assert.equal(lb.json.meetings.find((x: any) => x.name === "Haider").total, 1);
  const ns = await api("abdul", "PATCH", `/api/meetings/${m.json.id}`, { status: "no_show" }); assert.equal(ns.status, 200);
  const lb2 = await api("haider", "GET", "/api/leaderboard?period=month");
  assert.equal(lb2.json.meetings.find((x: any) => x.name === "Haider").total, 0);
  const d2 = await api("haider", "GET", `/api/prospects/${A}`); assert.equal(d2.json.prospect.stage, "replied");
  const m2 = await api("abdul", "POST", "/api/meetings", { prospect_id: A, scheduled_at: "2026-10-22T10:00:00Z", rebooked_from: m.json.id }); assert.equal(m2.status, 201);
  await api("abdul", "PATCH", `/api/meetings/${m2.json.id}`, { status: "held" });
  const lb3 = await api("haider", "GET", "/api/leaderboard?period=month");
  assert.equal(lb3.json.meetings.find((x: any) => x.name === "Haider").total, 1);
});

test("proposal, close with approval, shared 15/15 commission, payment, payout, clawback", async () => {
  let r = await api("haider", "POST", `/api/prospects/${A}/stage`, { stage: "proposal_sent" }); assert.equal(r.status, 400); // needs value
  r = await api("haider", "POST", `/api/prospects/${A}/stage`, { stage: "proposal_sent", deal_value: 1000, deal_currency: "USD", engagement_model: "one_off_project" }); assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await api("haider", "POST", `/api/prospects/${A}/stage`, { stage: "negotiation" }); assert.equal(r.status, 200);
  r = await api("haider", "POST", `/api/prospects/${A}/stage`, { stage: "closed_won", payment_terms: "50% upfront, 50% on delivery" }); assert.equal(r.status, 200); assert.equal(r.json.pending_approval, true);
  let d = await api("abdul", "GET", `/api/prospects/${A}`); assert.equal(d.json.prospect.closed_won_at, null);
  r = await api("abdul", "POST", `/api/prospects/${A}/approve`, { approve: true }); assert.equal(r.status, 200);
  d = await api("abdul", "GET", `/api/prospects/${A}`);
  assert.ok(d.json.prospect.closed_won_at); assert.equal(d.json.prospect.after_close_status, "in_delivery");
  const pend = d.json.commission.filter((c: any) => c.status === "pending");
  assert.equal(pend.length, 2); assert.deepEqual(pend.map((c: any) => c.amount_usd).sort(), [150, 150]);
  // agents cannot record payments
  r = await api("haider", "POST", "/api/payments", { prospect_id: A, amount: 500, currency: "USD", received_at: "2026-10-19" }); assert.equal(r.status, 403);
  r = await api("abdul", "POST", "/api/payments", { prospect_id: A, amount: 500, currency: "USD", received_at: "2026-10-19", label: "Upfront" }); assert.equal(r.status, 201);
  const mine = await api("haider", "GET", "/api/commission/mine");
  assert.equal(mine.json.totals.payable, 75); assert.equal(mine.json.totals.pending, 75);
  const hs = await api("hassaan", "GET", "/api/commission/mine"); assert.equal(hs.json.totals.payable, 75);
  const lb = await api("haider", "GET", "/api/leaderboard"); assert.equal(lb.json.commission.find((x: any) => x.name === "Haider").total, 75);
  // Adnan cannot pay, Abdul can
  r = await api("adnan", "POST", "/api/commission/payouts/3/pay", {}); assert.equal(r.status, 403);
  r = await api("abdul", "POST", "/api/commission/payouts/3/pay", {}); assert.equal(r.status, 200); assert.equal(r.json.paid, 75);
  // clawback
  const payId = d.json.payments.length ? d.json.payments[0].id : (await api("abdul", "GET", `/api/prospects/${A}`)).json.payments[0].id;
  r = await api("abdul", "POST", `/api/payments/${payId}/reverse`, { reason: "Client refunded" }); assert.equal(r.status, 200);
  const mine2 = await api("haider", "GET", "/api/commission/mine");
  assert.equal(mine2.json.totals.payable, -75);
  const hs2 = await api("hassaan", "GET", "/api/commission/mine"); assert.equal(hs2.json.totals.payable, 0);
  assert.ok(hs2.json.entries.some((e: any) => e.status === "reversed"));
  // carry forward: paying Haider now with only a negative balance carries it
  r = await api("abdul", "POST", "/api/commission/payouts/3/pay", {}); assert.equal(r.json.carried, -75);
  const mine3 = await api("haider", "GET", "/api/commission/mine"); assert.equal(mine3.json.totals.payable, -75);
});

test("profit split: cost apportioned per payment, awaiting cost holds Payable, true-up corrects paid", async () => {
  let r = await api("hassaan", "POST", "/api/prospects", { company: "Beta", contact_name: "B", email: "b@beta.io", source: "upwork", service_interest: "video" }); const B = r.json.id;
  await api("hassaan", "POST", `/api/prospects/${B}/stage`, { stage: "proposal_sent", deal_value: 2000, deal_currency: "USD", engagement_model: "one_off_project" });
  r = await api("adnan", "POST", `/api/prospects/${B}/stage`, { stage: "closed_won", payment_terms: "50/50" }); assert.equal(r.status, 200);
  let d = await api("abdul", "GET", `/api/prospects/${B}`); assert.ok(d.json.prospect.closed_won_at);
  r = await api("abdul", "POST", "/api/payments", { prospect_id: B, amount: 1000, currency: "USD", received_at: "2026-10-19" }); assert.equal(r.status, 201);
  let mine = await api("hassaan", "GET", "/api/commission/mine");
  const waiting = mine.json.entries.find((e: any) => e.payment_id && e.prospect_id === B);
  assert.equal(waiting.status, "pending"); assert.match(waiting.description, /awaiting project cost/);
  r = await api("hassaan", "PATCH", `/api/prospects/${B}`, { estimated_cost_usd: 800 }); assert.equal(r.status, 403);
  r = await api("abdul", "PATCH", `/api/prospects/${B}`, { estimated_cost_usd: 800 }); assert.equal(r.status, 200);
  mine = await api("hassaan", "GET", "/api/commission/mine");
  const e = mine.json.entries.find((x: any) => x.id === waiting.id);
  assert.equal(e.status, "payable"); assert.equal(e.cost_share_usd, 400); assert.equal(e.amount_usd, 300);
  r = await api("abdul", "POST", "/api/commission/payouts/4/pay", {}); assert.equal(r.json.paid, 300);
  // actual cost higher: 1200 → share 600 → (1000-600)/2 = 200 → true-up -100
  await api("abdul", "PATCH", `/api/prospects/${B}`, { actual_cost_usd: 1200 });
  mine = await api("hassaan", "GET", "/api/commission/mine");
  const tu = mine.json.entries.find((x: any) => x.kind === "true_up"); assert.equal(tu.amount_usd, -100); assert.equal(tu.status, "payable");
  // delivered
  r = await api("hassaan", "POST", `/api/prospects/${B}/after-close`, { status: "project_delivered", date: "2026-11-01" }); assert.equal(r.status, 200);
});

test("retainer: 30% first month then 10%, shared retainer 5/5, finished stops", async () => {
  let r = await api("noman", "POST", "/api/prospects", { company: "Gamma", contact_name: "G", email: "g@gamma.co", source: "referral", service_interest: "social_media", partner_id: 3 }); const C = r.json.id;
  await api("noman", "POST", `/api/prospects/${C}/stage`, { stage: "proposal_sent", deal_value: 100000, deal_currency: "PKR", engagement_model: "monthly_retainer" });
  let d = await api("noman", "GET", `/api/prospects/${C}`); assert.ok(d.json.prospect.deal_value_usd > 0); assert.equal(d.json.prospect.partner_name, "Haider");
  r = await api("abdul", "POST", `/api/prospects/${C}/stage`, { stage: "closed_won", payment_terms: "monthly" }); assert.equal(r.status, 200);
  d = await api("abdul", "GET", `/api/prospects/${C}`); assert.equal(d.json.prospect.after_close_status, "active_retainer");
  await api("abdul", "POST", "/api/payments", { prospect_id: C, amount: 1000, currency: "USD", received_at: "2026-10-19", label: "October" });
  await api("abdul", "POST", "/api/payments", { prospect_id: C, amount: 1000, currency: "USD", received_at: "2026-11-19", label: "November" });
  d = await api("abdul", "GET", `/api/prospects/${C}`);
  const pay = d.json.commission.filter((c: any) => c.payment_id);
  const noman = pay.filter((c: any) => c.user_name === "Noman").map((c: any) => c.amount_usd);
  assert.deepEqual(noman, [150, 50]); // 15% then 5% (shared)
  r = await api("noman", "POST", `/api/prospects/${C}/after-close`, { status: "retainer_finished", date: "2026-12-01" }); assert.equal(r.status, 200);
  r = await api("abdul", "POST", "/api/payments", { prospect_id: C, amount: 1000, currency: "USD", received_at: "2026-12-19" }); assert.equal(r.status, 400);
});

test("tasks need completion note; targets award bonus; today view and team overview load", async () => {
  let r = await api("haider", "POST", "/api/tasks", { title: "x", assigned_to: 3, due_date: "2026-10-19" }); assert.equal(r.status, 403);
  r = await api("adnan", "POST", "/api/tasks", { title: "Send deck", assigned_to: 3, due_date: "2026-10-18", priority: "high" }); assert.equal(r.status, 201);
  const tid = r.json.id;
  r = await api("haider", "PATCH", `/api/tasks/${tid}`, { status: "done" }); assert.equal(r.status, 400);
  r = await api("haider", "PATCH", `/api/tasks/${tid}`, { status: "done", completion_note: "Sent v2 deck" }); assert.equal(r.status, 200);
  r = await api("abdul", "POST", "/api/targets", { name: "Meetings", scope: "team", metric: "meetings_booked", number: 1, period: "month", bonus_usd: 50 }); assert.equal(r.status, 201);
  const today = await api("haider", "GET", "/api/today"); assert.equal(today.status, 200);
  assert.ok(today.json.targets.cards.some((c: any) => c.won));
  const mine = await api("haider", "GET", "/api/commission/mine"); assert.ok(mine.json.entries.some((e: any) => e.kind === "bonus" && e.amount_usd === 50));
  const lb = await api("haider", "GET", "/api/leaderboard");
  // bonus excluded from commission board
  const hRow = lb.json.commission.find((x: any) => x.name === "Haider");
  const expected = mine.json.entries.filter((e: any) => e.kind !== "bonus" && ["payable", "paid"].includes(e.status)).reduce((s: number, e: any) => s + (e.status === "paid" ? e.paid_amount_usd : e.amount_usd), 0);
  assert.equal(Math.round(hRow.total * 100) / 100, Math.round(expected * 100) / 100);
  const team = await api("abdul", "GET", "/api/today/team"); assert.equal(team.status, 200); assert.equal(team.json.people.length, 3);
  const noTeam = await api("haider", "GET", "/api/today/team"); assert.equal(noTeam.status, 403);
  r = await api("haider", "POST", "/api/today/eod", { note: "Emailed 30, booked 1" }); assert.equal(r.status, 200);
  const rep = await api("abdul", "GET", "/api/reports/team"); assert.equal(rep.status, 200);
  const csv = await api("abdul", "GET", "/api/reports/export/commission"); assert.equal(csv.status, 200); assert.match(csv.json, /person,company/);
});

test("import flags duplicates and lands in unassigned pool; reassignment freezes pending", async () => {
  let r = await api("adnan", "POST", "/api/reports/import", { rows: [{ company: "Acme", contact_name: "Jo", email: "jo@acme.com" }, { company: "Delta", contact_name: "D", email: "d@delta.com", owner_email: "noman@t.co" }, { company: "Echo", contact_name: "E", email: "e@echo.com" }] });
  assert.equal(r.status, 200); assert.equal(r.json.imported, 2); assert.equal(r.json.duplicates.length, 1); assert.equal(r.json.duplicates[0].existing.owner_name, "Haider");
  const pool = await api("abdul", "GET", "/api/prospects?unassigned=1"); assert.equal(pool.json.length, 1);
  r = await api("abdul", "POST", `/api/prospects/${pool.json[0].id}/assign`, { owner_id: 5 }); assert.equal(r.status, 200);
  r = await api("abdul", "POST", "/api/reports/reassign", { from_user_id: 5, to_user_id: 3 }); assert.equal(r.status, 200); assert.ok(r.json.moved >= 2);
  server.close();
});
