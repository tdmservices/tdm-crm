/** Populates a seeded database with realistic demo data through the API, so the app is not empty on first run.
 *  Usage: npm run demo   (server must NOT be running on the same DB; this starts its own in-process instance) */
process.env.NODE_ENV = "test";
import type { Server } from "node:http";

async function main() {
  const { app } = await import("./index.js");
  const server: Server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const tok: Record<string, string> = {};
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + "/api" + path, { method, headers: { "Content-Type": "application/json", ...(tok[as] ? { Authorization: `Bearer ${tok[as]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${j.error ?? res.status}`);
    return j;
  };
  for (const u of ["abdul", "adnan", "haider", "hassaan", "noman"]) tok[u] = (await call("", "POST", "/auth/login", { email: `${u}@tdm.services`, password: "Password123!" })).token;
  const ids = (await call("abdul", "GET", "/users")) as any[];
  const id = (n: string) => ids.find(u => u.name === n).id;

  const add = (as: string, p: any) => call(as, "POST", "/prospects", { source: "cold_email", service_interest: "web_shopify", ...p });
  const act = (as: string, pid: number, type: string, next?: string) => call(as, "POST", `/prospects/${pid}/activities`, { type, next_follow_up: next });

  const a1 = (await add("haider", { company: "Northwind Traders", contact_name: "Sara Khan", email: "sara@northwind.com", phone: "+44 7700 900100", website: "northwind.com", country: "UK", campaign_tag: "shopify-q4" })).id;
  await act("haider", a1, "emailed");
  const a2 = (await add("haider", { company: "Blue Harbor Dental", contact_name: "Dr. Ali", email: "ali@blueharbor.ae", phone: "+971 50 123 4567", country: "UAE", source: "linkedin", service_interest: "performance_marketing" })).id;
  await act("haider", a2, "messaged"); await call("haider", "POST", `/prospects/${a2}/stage`, { stage: "replied", next_follow_up: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) });
  await call("abdul", "POST", "/meetings", { prospect_id: a2, scheduled_at: new Date(Date.now() + 86400000).toISOString(), link: "https://calendly.com/tdm/call" });
  const a3 = (await add("haider", { company: "Peak Fitness Co", contact_name: "Omar", email: "omar@peakfitness.co", source: "upwork", service_interest: "seo_aeo_geo" })).id;
  await act("haider", a3, "emailed"); await call("haider", "POST", `/prospects/${a3}/stage`, { stage: "replied" });
  const m3 = await call("abdul", "POST", "/meetings", { prospect_id: a3, scheduled_at: new Date(Date.now() - 86400000 * 3).toISOString() });
  await call("abdul", "PATCH", `/meetings/${m3.id}`, { status: "held" });
  await call("haider", "POST", `/prospects/${a3}/stage`, { stage: "proposal_sent", deal_value: 4500, deal_currency: "USD", engagement_model: "one_off_project" });

  const h1 = (await add("hassaan", { company: "Karachi Kitchen Supplies", contact_name: "Bilal", email: "bilal@kks.pk", phone: "+92 321 5551234", country: "Pakistan", source: "referral", service_interest: "web_shopify" })).id;
  await act("hassaan", h1, "called"); await call("hassaan", "POST", `/prospects/${h1}/stage`, { stage: "replied" });
  const mh = await call("abdul", "POST", "/meetings", { prospect_id: h1, scheduled_at: new Date(Date.now() - 86400000 * 10).toISOString() });
  await call("abdul", "PATCH", `/meetings/${mh.id}`, { status: "held" });
  await call("hassaan", "POST", `/prospects/${h1}/stage`, { stage: "proposal_sent", deal_value: 1500000, deal_currency: "PKR", engagement_model: "one_off_project" });
  await call("hassaan", "POST", `/prospects/${h1}/stage`, { stage: "negotiation" });
  await call("hassaan", "POST", `/prospects/${h1}/stage`, { stage: "closed_won", payment_terms: "50% upfront, 50% on delivery", expected_delivery_date: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10) });
  await call("adnan", "POST", `/prospects/${h1}/approve`, { approve: true });
  await call("abdul", "PATCH", `/prospects/${h1}`, { estimated_cost_usd: 2000 });
  await call("abdul", "POST", "/payments", { prospect_id: h1, amount: 750000, currency: "PKR", received_at: new Date().toISOString().slice(0, 10), label: "Upfront" });

  const n1 = (await add("noman", { company: "Sunrise Realty", contact_name: "Maya", email: "maya@sunriserealty.com", source: "instagram", service_interest: "social_media", partner_id: id("Haider") })).id;
  await act("noman", n1, "messaged"); await call("noman", "POST", `/prospects/${n1}/stage`, { stage: "replied" });
  const mn = await call("abdul", "POST", "/meetings", { prospect_id: n1, scheduled_at: new Date(Date.now() - 86400000 * 20).toISOString() });
  await call("abdul", "PATCH", `/meetings/${mn.id}`, { status: "held" });
  await call("noman", "POST", `/prospects/${n1}/stage`, { stage: "proposal_sent", deal_value: 1200, deal_currency: "USD", engagement_model: "monthly_retainer" });
  await call("abdul", "POST", `/prospects/${n1}/stage`, { stage: "closed_won", payment_terms: "Monthly, billed on the 1st" });
  await call("abdul", "POST", "/payments", { prospect_id: n1, amount: 1200, currency: "USD", received_at: new Date(Date.now() - 86400000 * 15).toISOString().slice(0, 10), label: "Month 1" });
  const n2 = (await add("noman", { company: "Oasis Hotels", contact_name: "Faisal", email: "faisal@oasishotels.sa", country: "Saudi Arabia", source: "cold_email", service_interest: "video" })).id;
  await act("noman", n2, "emailed", new Date(Date.now() - 86400000 * 3).toISOString().slice(0, 10)); // overdue follow-up
  const n3 = (await add("noman", { company: "Green Leaf Organics", contact_name: "Hina", email: "hina@greenleaf.pk", source: "fiverr", service_interest: "marketplace" })).id;
  await call("noman", "POST", `/prospects/${n3}/stage`, { stage: "closed_lost", lost_reason: "price" });

  await call("adnan", "POST", "/tasks", { title: "Send Q4 Shopify case study to Northwind", assigned_to: id("Haider"), prospect_id: a1, due_date: new Date().toISOString().slice(0, 10), priority: "high" });
  await call("adnan", "POST", "/tasks", { title: "Daily outreach: 30 emails", assigned_to: id("Noman"), due_date: new Date().toISOString().slice(0, 10), recurrence: "daily" });
  await call("abdul", "POST", "/targets", { name: "Meetings booked", scope: "team", metric: "meetings_booked", number: 8, period: "month", bonus_usd: 100 });
  await call("abdul", "POST", "/targets", { name: "Weekly outreach", scope: "team", metric: "activities", number: 150, period: "week", bonus_usd: 0 });
  await call("adnan", "POST", "/reports/import", { rows: [{ company: "Delta Logistics", contact_name: "Unknown", email: "info@deltalogistics.com" }, { company: "Pixel Studio", contact_name: "Unknown", email: "hello@pixelstudio.io" }] });
  await call("haider", "POST", "/today/eod", { note: "28 emails, 3 replies, Blue Harbor meeting booked for tomorrow" });
  server.close();
  console.log("Demo data loaded.");
}
main().catch(e => { console.error(e); process.exit(1); });
