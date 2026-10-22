process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

let server: Server; let base = "";
const TODAY = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
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
  r = await api("haider", "POST", "/api/payments", { prospect_id: A, amount: 500, currency: "USD", received_at: TODAY }); assert.equal(r.status, 403);
  r = await api("abdul", "POST", "/api/payments", { prospect_id: A, amount: 500, currency: "USD", received_at: TODAY, label: "Upfront" }); assert.equal(r.status, 201);
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
  await api("abdul", "POST", "/api/payments", { prospect_id: C, amount: 1000, currency: "USD", received_at: TODAY, label: "October" });
  await api("abdul", "POST", "/api/payments", { prospect_id: C, amount: 1000, currency: "USD", received_at: TODAY, label: "November" });
  d = await api("abdul", "GET", `/api/prospects/${C}`);
  const pay = d.json.commission.filter((c: any) => c.payment_id);
  const noman = pay.filter((c: any) => c.user_name === "Noman").map((c: any) => c.amount_usd);
  assert.deepEqual(noman, [150, 50]); // 15% then 5% (shared)
  r = await api("noman", "POST", `/api/prospects/${C}/after-close`, { status: "retainer_finished", date: "2026-12-01" }); assert.equal(r.status, 200);
  r = await api("abdul", "POST", "/api/payments", { prospect_id: C, amount: 1000, currency: "USD", received_at: TODAY }); assert.equal(r.status, 400);
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
});

test("phase 2: milestone schedule must add up, lines go received/overdue, invoice from a line", async () => {
  let r = await api("haider", "POST", "/api/prospects", { company: "Zeta Corp", contact_name: "Z", email: "z@zeta.com", source: "cold_email", service_interest: "web_shopify" }); const Z = r.json.id;
  await api("haider", "POST", `/api/prospects/${Z}/stage`, { stage: "proposal_sent", deal_value: 3000, deal_currency: "USD", engagement_model: "one_off_project" });
  r = await api("haider", "PUT", `/api/prospects/${Z}/schedule`, { structure: "milestones", milestones: [{ name: "Upfront", percentage: 50, expected_date: "2026-10-01" }, { name: "Final", percentage: 40, expected_date: "2026-12-01" }] });
  assert.equal(r.status, 400); assert.match(r.json.error, /add up/);
  r = await api("haider", "PUT", `/api/prospects/${Z}/schedule`, { structure: "milestones", milestones: [{ name: "Upfront", percentage: 50, expected_date: "2026-10-01" }, { name: "Final", percentage: 50, expected_date: "2026-12-01" }] });
  assert.equal(r.status, 200); assert.equal(r.json.schedule.length, 2); assert.equal(r.json.schedule[0].status, "overdue"); assert.equal(r.json.schedule[1].status, "expected");
  await api("abdul", "POST", `/api/prospects/${Z}/stage`, { stage: "closed_won", payment_terms: "50/50" });
  const line = r.json.schedule[0];
  r = await api("abdul", "POST", `/api/documents/from-schedule/${line.id}`, {}); assert.equal(r.status, 201);
  const docId = r.json.id;
  await api("abdul", "PATCH", `/api/documents/${docId}`, { status: "sent" });
  r = await api("abdul", "POST", "/api/payments", { prospect_id: Z, amount: 1500, currency: "USD", received_at: "2026-10-19", schedule_id: line.id }); assert.equal(r.status, 201);
  r = await api("abdul", "POST", "/api/payments", { prospect_id: Z, amount: 1500, currency: "USD", received_at: "2026-10-19", schedule_id: line.id }); assert.equal(r.status, 400); // already received
  const d = await api("haider", "GET", `/api/prospects/${Z}`);
  assert.equal(d.json.schedule[0].status, "received"); assert.equal(d.json.schedule[1].status, "expected");
  assert.equal(d.json.documents[0].status, "paid");
  const team = await api("abdul", "GET", "/api/today/team"); assert.ok(Array.isArray(team.json.overdue_payments));
  // portal link works without login
  r = await api("haider", "POST", `/api/prospects/${Z}/portal-link`, {}); assert.equal(r.status, 200);
  const portal = await api("", "GET", `/api/portal/${r.json.token}`); assert.equal(portal.status, 200); assert.equal(portal.json.deal.company, "Zeta Corp"); assert.equal(portal.json.schedule.length, 2); assert.equal(portal.json.documents.length, 1);
  const bad = await api("", "GET", "/api/portal/nope"); assert.equal(bad.status, 404);
});

test("phase 2: retainer monthly schedule generates lines; owner earns no commission", async () => {
  let r = await api("abdul", "POST", "/api/prospects", { company: "Owner Deal Ltd", contact_name: "O", email: "o@ownerdeal.com", source: "referral", service_interest: "seo_aeo_geo", owner_id: 1 }); const O = r.json.id;
  await api("abdul", "POST", `/api/prospects/${O}/stage`, { stage: "proposal_sent", deal_value: 500, deal_currency: "USD", engagement_model: "monthly_retainer" });
  r = await api("abdul", "PUT", `/api/prospects/${O}/schedule`, { structure: "monthly", retainer: { monthly_amount: 500, billing_day: 5, start_month: "2026-11", min_months: 6 } });
  assert.equal(r.status, 200); assert.equal(r.json.schedule.length, 6); assert.equal(r.json.schedule[0].expected_date, "2026-11-05"); assert.equal(r.json.schedule[0].kind, "month");
  await api("abdul", "POST", `/api/prospects/${O}/stage`, { stage: "closed_won", payment_terms: "monthly" });
  await api("abdul", "POST", "/api/payments", { prospect_id: O, amount: 500, currency: "USD", received_at: "2026-11-05", schedule_id: r.json.schedule[0].id });
  const d = await api("abdul", "GET", `/api/prospects/${O}`);
  assert.equal(d.json.commission.length, 0); // owner keeps everything
  const payouts = await api("abdul", "GET", "/api/commission/payouts"); assert.ok(!payouts.json.people.some((p: any) => p.name === "Abdul"));
  // owner as partner on an agent's deal: agent paid as if alone (30%, not 15%)
  r = await api("noman", "POST", "/api/prospects", { company: "Solo Plus Owner", contact_name: "S", email: "s@solo.com", source: "linkedin", service_interest: "video", partner_id: 1 }); const S = r.json.id;
  await api("noman", "POST", `/api/prospects/${S}/stage`, { stage: "proposal_sent", deal_value: 1000, deal_currency: "USD", engagement_model: "one_off_project" });
  await api("abdul", "POST", `/api/prospects/${S}/stage`, { stage: "closed_won", payment_terms: "full" });
  await api("abdul", "POST", "/api/payments", { prospect_id: S, amount: 1000, currency: "USD", received_at: TODAY });
  const ds = await api("abdul", "GET", `/api/prospects/${S}`);
  const payable = ds.json.commission.filter((c: any) => c.payment_id);
  assert.equal(payable.length, 1); assert.equal(payable[0].user_name, "Noman"); assert.equal(payable[0].amount_usd, 300);
});

test("phase 3: custom leaderboard, notification prefs, webhooks for Calendly, Google and ChatFlow", async () => {
  let r = await api("abdul", "POST", "/api/leaderboard/custom", { name: "Leads added", metric: "leads_added" }); assert.equal(r.status, 201);
  r = await api("haider", "POST", "/api/leaderboard/custom", { name: "x", metric: "leads_added" }); assert.equal(r.status, 403);
  const lb = await api("haider", "GET", "/api/leaderboard?period=all"); assert.equal(lb.json.custom.length, 1); assert.ok(lb.json.custom[0].rows[0].total >= 1);
  r = await api("haider", "PATCH", "/api/users/me/preferences", { notify_whatsapp: true, phone: "+92 300 0000000" }); assert.equal(r.status, 200); assert.equal(r.json.notify_whatsapp, 1);
  // Calendly: unknown invitee → unassigned lead + management notified; known prospect → meeting credited to owner
  r = await api("", "POST", "/api/webhooks/calendly", { event: "invitee.created", payload: { email: "jo@acme.com", name: "Jo", uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", scheduled_event: { uri: "E1", start_time: "2026-10-25T09:00:00Z", location: { join_url: "https://meet/x" } } } });
  assert.equal(r.status, 200);
  const acme = await api("abdul", "GET", "/api/prospects?search=Acme");
  const dA = await api("abdul", "GET", `/api/prospects/${acme.json[0].id}`);
  assert.ok(dA.json.meetings.some((m: any) => m.external_id?.includes("I1") && m.status === "booked"));
  r = await api("", "POST", "/api/webhooks/calendly", { event: "invitee.canceled", payload: { email: "jo@acme.com", uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", scheduled_event: { uri: "E1" } } });
  const dA2 = await api("abdul", "GET", `/api/prospects/${acme.json[0].id}`);
  assert.ok(dA2.json.meetings.some((m: any) => m.external_id?.includes("I1") && m.status === "no_show"));
  r = await api("", "POST", "/api/webhooks/calendly", { event: "invitee.created", payload: { email: "new@stranger.io", name: "Stranger", uri: "https://api.calendly.com/x/I2", scheduled_event: { uri: "E2", start_time: "2026-10-26T09:00:00Z" } } });
  assert.equal(r.status, 200); assert.equal(r.json.pending, true);
  const pool = await api("abdul", "GET", "/api/prospects?unassigned=1"); assert.ok(pool.json.some((p: any) => p.email === "new@stranger.io"));
  // Google lead form: key required
  r = await api("", "POST", "/api/webhooks/google", { google_key: "wrong", lead_id: "g1" }); assert.equal(r.status, 401);
  await api("abdul", "PUT", "/api/settings", { google_lead_key: "k123", chatflow_key: "cf1" });
  r = await api("", "POST", "/api/webhooks/google", { google_key: "k123", lead_id: "g1", campaign_id: 77, user_column_data: [{ column_id: "FULL_NAME", string_value: "Gina Lead" }, { column_id: "EMAIL", string_value: "gina@leadco.com" }, { column_id: "PHONE_NUMBER", string_value: "+1 555 0100" }] });
  assert.equal(r.status, 200);
  const pool2 = await api("abdul", "GET", "/api/prospects?unassigned=1"); const gina = pool2.json.find((p: any) => p.email === "gina@leadco.com"); assert.ok(gina); assert.equal(gina.campaign_tag, "campaign 77");
  // ChatFlow inbound reply moves Contacted → Replied and logs a note
  r = await api("", "POST", "/api/webhooks/chatflow", { key: "cf1", phone: "+92 300 1234567", direction: "in", text: "Yes, send me the proposal", id: "m1" }); assert.equal(r.status, 200);
  const dAcme = await api("abdul", "GET", `/api/prospects/${acme.json[0].id}`); assert.ok(dAcme.json.notes.some((n: any) => n.body.includes("send me the proposal")));
  r = await api("", "POST", "/api/webhooks/chatflow", { key: "cf1", phone: "+92 300 1234567", direction: "in", text: "dup", id: "m1" }); assert.equal(r.json.skipped, true);
  // secrets masked for manager
  const st = await api("adnan", "GET", "/api/settings"); assert.equal(st.json.chatflow_key, "••••••");
  const st2 = await api("abdul", "GET", "/api/settings"); assert.equal(st2.json.chatflow_key, "cf1");
  server.close();
});
