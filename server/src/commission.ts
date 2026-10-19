/**
 * Commission engine.
 *
 * Models (per user, set by Owner):
 *   profit_split   one-off projects: (payment - cost share) * 50%.  Cost share = payment's proportion of deal value * estimated/actual cost.
 *   revenue_share  one-off projects: rate (default 30%) of payment, no cost deduction.
 *   retainer_share monthly retainer + dedicated resource (all people): 30% of first payment, 10% of each later payment.
 *   Shared deals: 30% revenue share split 15/15 (retainer: 30% then 10%, split equally). Profit split never applies to shared deals.
 *
 * Every entry freezes its USD amount at creation. Rate/model changes apply to deals closed after the change,
 * which this engine honours by snapshotting model+rate onto the prospect's pending entries at Closed won.
 */
import { db } from "./db.js";
import { round2 } from "./fx.js";
import { notify } from "./log.js";

type Prospect = {
  id: number; company: string; owner_id: number; partner_id: number | null; partner_since: string | null;
  engagement_model: string | null; deal_value_usd: number | null; estimated_cost_usd: number | null; actual_cost_usd: number | null;
  retainer_finished_at: string | null;
};
type User = { id: number; commission_model: "profit_split" | "revenue_share"; commission_rate: number };

const RETAINER_FIRST = 0.30;
const RETAINER_LATER = 0.10;
const SHARED_RATE = 0.30;

export function isRetainerType(engagement: string | null) {
  return engagement === "monthly_retainer" || engagement === "dedicated_resource";
}

/** Projected commission at Closed won (status pending). One entry per person on the deal. */
export function createPendingEntries(prospectId: number) {
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(prospectId) as Prospect;
  const dealUsd = p.deal_value_usd ?? 0;
  const people = participants(p);
  const ins = db.prepare(
    "INSERT INTO commission_entries (user_id, prospect_id, kind, model, rate, base_usd, cost_share_usd, amount_usd, status, description) VALUES (?, ?, 'sales', ?, ?, ?, ?, ?, 'pending', ?)"
  );
  for (const person of people) {
    const calc = computeFor(p, person, dealUsd, 1, people.length, dealUsd);
    ins.run(person.id, p.id, calc.model, calc.rate, dealUsd, calc.cost_share, calc.amount, `Projected on ${p.company}`);
  }
}

function participants(p: Prospect): User[] {
  const get = db.prepare("SELECT id, commission_model, commission_rate FROM users WHERE id = ?");
  const list: User[] = [];
  if (p.owner_id) list.push(get.get(p.owner_id) as User);
  if (p.partner_id) list.push(get.get(p.partner_id) as User);
  return list.filter(Boolean);
}

/**
 * Compute commission for one person on one payment.
 * sequence: 1 for the first payment on the deal (retainer first month rule).
 * nPeople: 1 or 2.
 */
export function computeFor(p: Prospect, user: User, paymentUsd: number, sequence: number, nPeople: number, dealUsd: number) {
  const retainer = isRetainerType(p.engagement_model);
  if (retainer) {
    const rate = sequence === 1 ? RETAINER_FIRST : RETAINER_LATER;
    const share = nPeople > 1 ? rate / nPeople : rate;
    return { model: nPeople > 1 ? "shared_retainer" : "retainer_share", rate: share, cost_share: null as number | null, amount: round2(paymentUsd * share) };
  }
  if (nPeople > 1) {
    const share = SHARED_RATE / nPeople;
    return { model: "shared_revenue", rate: share, cost_share: null, amount: round2(paymentUsd * share) };
  }
  if (user.commission_model === "profit_split") {
    const cost = p.actual_cost_usd ?? p.estimated_cost_usd ?? 0;
    const proportion = dealUsd > 0 ? paymentUsd / dealUsd : 1;
    const costShare = round2(cost * proportion);
    const amount = round2(Math.max(0, paymentUsd - costShare) * 0.5);
    return { model: "profit_split", rate: 0.5, cost_share: costShare, amount };
  }
  const rate = user.commission_rate ?? 0.30;
  return { model: "revenue_share", rate, cost_share: null, amount: round2(paymentUsd * rate) };
}

/** On a recorded payment: create Payable entries for everyone on the deal (partners only if added before the payment date). */
export function onPaymentRecorded(paymentId: number) {
  const pay = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId) as { id: number; prospect_id: number; sequence: number; amount_usd: number; received_at: string; label: string | null };
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(pay.prospect_id) as Prospect;
  let people = participants(p);
  if (p.partner_id && p.partner_since && p.partner_since.slice(0, 10) > pay.received_at.slice(0, 10)) {
    people = people.filter(u => u.id !== p.partner_id);
  }
  const dealUsd = p.deal_value_usd ?? pay.amount_usd;
  const ins = db.prepare(
    "INSERT INTO commission_entries (user_id, prospect_id, payment_id, kind, model, rate, base_usd, cost_share_usd, amount_usd, status, description) VALUES (?, ?, ?, 'sales', ?, ?, ?, ?, ?, 'payable', ?)"
  );
  for (const person of people) {
    const calc = computeFor(p, person, pay.amount_usd, pay.sequence, people.length, dealUsd);
    const needsCost = calc.model === "profit_split" && p.estimated_cost_usd == null && p.actual_cost_usd == null;
    const status = needsCost ? "pending" : "payable";
    const desc = `${pay.label ?? `Payment ${pay.sequence}`} on ${p.company}` + (needsCost ? " (awaiting project cost)" : "");
    db.prepare(
      "INSERT INTO commission_entries (user_id, prospect_id, payment_id, kind, model, rate, base_usd, cost_share_usd, amount_usd, status, description) VALUES (?, ?, ?, 'sales', ?, ?, ?, ?, ?, ?, ?)"
    ).run(person.id, p.id, pay.id, calc.model, calc.rate, pay.amount_usd, calc.cost_share, calc.amount, status, desc);
    notify(person.id, "payment_received", `Payment received: ${p.company}`, `$${pay.amount_usd.toFixed(2)} (${pay.label ?? `payment ${pay.sequence}`}). Commission $${calc.amount.toFixed(2)} ${status}.`, p.id);
  }
  void ins;
  // Reduce the projected pending entries proportionally so Pending reflects what is still unpaid.
  const paidSoFar = (db.prepare("SELECT COALESCE(SUM(amount_usd),0) AS s FROM payments WHERE prospect_id = ? AND reversed_at IS NULL").get(p.id) as { s: number }).s;
  const remaining = Math.max(0, dealUsd - paidSoFar);
  const projected = db.prepare("SELECT id, user_id FROM commission_entries WHERE prospect_id = ? AND payment_id IS NULL AND kind = 'sales' AND status = 'pending'").all(p.id) as { id: number; user_id: number }[];
  for (const e of projected) {
    const person = people.find(u => u.id === e.user_id) ?? (db.prepare("SELECT id, commission_model, commission_rate FROM users WHERE id = ?").get(e.user_id) as User);
    const calc = computeFor(p, person, remaining, 2, people.length, dealUsd);
    if (remaining <= 0 && !isRetainerType(p.engagement_model)) {
      db.prepare("UPDATE commission_entries SET amount_usd = 0, status = 'paid', paid_amount_usd = 0, paid_at = datetime('now'), description = 'Projection fully realised', updated_at = datetime('now') WHERE id = ?").run(e.id);
    } else {
      db.prepare("UPDATE commission_entries SET amount_usd = ?, base_usd = ?, updated_at = datetime('now') WHERE id = ?").run(calc.amount, remaining, e.id);
    }
  }
}

/** When the project cost is entered/changed, entries that were waiting for it become payable; a true-up corrects earlier payouts. */
export function recomputeProfitSplit(prospectId: number) {
  const p = db.prepare("SELECT * FROM prospects WHERE id = ?").get(prospectId) as Prospect;
  const entries = db.prepare(
    "SELECT ce.*, u.commission_model, u.commission_rate FROM commission_entries ce JOIN users u ON u.id = ce.user_id WHERE ce.prospect_id = ? AND ce.kind = 'sales' AND ce.payment_id IS NOT NULL AND ce.model = 'profit_split'"
  ).all(prospectId) as any[];
  const dealUsd = p.deal_value_usd ?? 0;
  for (const e of entries) {
    const pay = db.prepare("SELECT sequence, amount_usd, reversed_at FROM payments WHERE id = ?").get(e.payment_id) as any;
    if (pay.reversed_at) continue;
    const calc = computeFor(p, { id: e.user_id, commission_model: e.commission_model, commission_rate: e.commission_rate }, pay.amount_usd, pay.sequence, 1, dealUsd);
    if (e.status === "pending") {
      db.prepare("UPDATE commission_entries SET amount_usd = ?, cost_share_usd = ?, status = 'payable', description = REPLACE(description, ' (awaiting project cost)', ''), updated_at = datetime('now') WHERE id = ?").run(calc.amount, calc.cost_share, e.id);
    } else if (e.status === "payable") {
      db.prepare("UPDATE commission_entries SET amount_usd = ?, cost_share_usd = ?, updated_at = datetime('now') WHERE id = ?").run(calc.amount, calc.cost_share, e.id);
    } else if (e.status === "paid") {
      const diff = round2(calc.amount - e.paid_amount_usd);
      if (Math.abs(diff) >= 0.01) {
        const already = db.prepare("SELECT COALESCE(SUM(amount_usd),0) AS s FROM commission_entries WHERE kind = 'true_up' AND payment_id = ? AND user_id = ?").get(e.payment_id, e.user_id) as { s: number };
        const delta = round2(diff - already.s);
        if (Math.abs(delta) >= 0.01) {
          db.prepare("INSERT INTO commission_entries (user_id, prospect_id, payment_id, kind, model, amount_usd, status, description) VALUES (?, ?, ?, 'true_up', 'profit_split', ?, 'payable', ?)")
            .run(e.user_id, prospectId, e.payment_id, delta, `Cost true-up on ${p.company}`);
        }
      }
    }
  }
}

/** Clawback: reverse a payment. Payable entries become reversed; paid entries create a negative clawback line. */
export function onPaymentReversed(paymentId: number) {
  const entries = db.prepare("SELECT * FROM commission_entries WHERE payment_id = ? AND kind IN ('sales','true_up')").all(paymentId) as any[];
  const pay = db.prepare("SELECT p.*, pr.company FROM payments p JOIN prospects pr ON pr.id = p.prospect_id WHERE p.id = ?").get(paymentId) as any;
  for (const e of entries) {
    if (e.status === "paid") {
      db.prepare("INSERT INTO commission_entries (user_id, prospect_id, payment_id, kind, model, amount_usd, status, description) VALUES (?, ?, ?, 'clawback', ?, ?, 'payable', ?)")
        .run(e.user_id, e.prospect_id, paymentId, e.model, -Math.abs(e.paid_amount_usd ?? e.amount_usd), `Clawback: ${pay.company} payment reversed`);
      notify(e.user_id, "clawback", `Clawback on ${pay.company}`, `A payment was reversed. $${Math.abs(e.paid_amount_usd ?? e.amount_usd).toFixed(2)} will be deducted from your next payout.`, e.prospect_id);
    } else if (e.status !== "reversed") {
      db.prepare("UPDATE commission_entries SET status = 'reversed', updated_at = datetime('now') WHERE id = ?").run(e.id);
    }
  }
}

/** Mark everything payable for a user as paid. Negative lines (clawbacks/true-ups) net against positives; any negative remainder carries forward. */
export function payUser(userId: number, paidBy: number, note?: string) {
  const rows = db.prepare("SELECT id, amount_usd FROM commission_entries WHERE user_id = ? AND status = 'payable' AND frozen = 0 ORDER BY created_at").all(userId) as { id: number; amount_usd: number }[];
  const total = round2(rows.reduce((s, r) => s + r.amount_usd, 0));
  if (rows.length === 0) return { paid: 0, carried: 0 };
  if (total <= 0) {
    // Nothing is due; consolidate negatives into one carry-forward line.
    const carry = total;
    const tx = db.transaction(() => {
      for (const r of rows) db.prepare("UPDATE commission_entries SET status = 'paid', paid_amount_usd = 0, paid_at = datetime('now'), paid_by = ?, updated_at = datetime('now') WHERE id = ?").run(paidBy, r.id);
      if (carry < 0) db.prepare("INSERT INTO commission_entries (user_id, kind, amount_usd, status, description) VALUES (?, 'clawback', ?, 'payable', 'Balance carried forward')").run(userId, carry);
    });
    tx();
    return { paid: 0, carried: carry };
  }
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare("UPDATE commission_entries SET status = 'paid', paid_amount_usd = amount_usd, paid_at = datetime('now'), paid_by = ?, updated_at = datetime('now') WHERE id = ?").run(paidBy, r.id);
    }
  });
  tx();
  notify(userId, "payout", "Payout made", `$${total.toFixed(2)} marked paid${note ? `: ${note}` : ""}.`);
  return { paid: total, carried: 0 };
}
