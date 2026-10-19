import { useState } from "react";
import { get, post, patch, offlineWrite, usd, usd2, label, fmtDate, fmtDateTime, todayPk, addDays, type User } from "../lib/api";
import { Modal, Field, Select, Err, Stage, useAsync, Link, nav } from "../lib/ui";
import { LogActionModal, TaskDoneModal } from "./Today";
import { NewTaskModal } from "./Tasks";
import { CURRENCIES } from "./Pipeline";

const statusChip = (s: string) => <span className={`chip ${s === "paid" || s === "held" || s === "payable" && false ? "ok" : s === "payable" ? "warn" : s === "reversed" || s === "no_show" ? "red" : "grey"}`}>{label(s)}</span>;

export function ProspectPage({ id, user }: { id: number; user: User }) {
  const mgmt = user.role !== "agent";
  const d = useAsync(() => get(`/prospects/${id}`), [id]);
  const meta = useAsync(() => get("/prospects/meta"), []);
  const users = useAsync(() => get("/users"), []);
  const [modal, setModal] = useState<string | null>(null);
  const [taskModal, setTaskModal] = useState<{ task: any; mode: "done" | "blocked" } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (d.loading && !d.data) return <div className="center">Loading…</div>;
  if (d.error && !d.data) return <Err e={d.error} />;
  const { prospect: p, notes, activities, follow_ups, meetings, tasks, payments, commission, partner_requests } = d.data;
  const isOwner = p.owner_id === user.id;
  const closed = ["closed_won", "closed_lost"].includes(p.stage);
  const digits = (p.phone ?? "").replace(/\D/g, "");
  async function tap(type: string) { try { await offlineWrite("POST", `/prospects/${id}/activities`, { type, clear_due: false }); d.reload(); } catch (e) { setErr(e); } }
  async function act(fn: () => Promise<unknown>) { setErr(null); try { await fn(); d.reload(); } catch (e) { setErr(e); } }
  const openFollowUps = follow_ups.filter((f: any) => !f.done_at);
  const pendingReqs = partner_requests.filter((r: any) => r.status === "pending");
  const agents = (users.data ?? []).filter((u: any) => u.active !== 0);
  return (
    <div>
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div>
          <a onClick={() => history.back()} className="small">← Back</a>
          <h1 style={{ marginBottom: 2 }}>{p.company}</h1>
          <div className="muted">{p.contact_name}{p.country ? ` · ${p.country}` : ""}</div>
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <Stage s={p.stage} />
            {p.stage === "closed_won" && !p.closed_won_at && <span className="chip warn">Awaiting approval</span>}
            {p.after_close_status && <span className="chip ok">{label(p.after_close_status)}</span>}
            {p.is_cold ? <span className="chip warn">Cold · no reply 14 days</span> : null}
            <span className="chip grey">{p.owner_name ?? "Unassigned"}</span>
            {p.partner_name && <span className="chip">Partner: {p.partner_name}</span>}
            {p.deal_value_usd != null && <span className="b">{usd(p.deal_value_usd)}{p.deal_currency !== "USD" ? <span className="muted small"> ({p.deal_value} {p.deal_currency})</span> : null}</span>}
          </div>
        </div>
      </div>
      <Err e={err} />
      <div className="row" style={{ margin: "12px 0" }}>
        {digits && <a className="btn sm ok" href={`https://wa.me/${digits}`} target="_blank" rel="noreferrer" onClick={() => tap("whatsapp_tap")}>WhatsApp</a>}
        {p.phone && <a className="btn sm muted" href={`tel:${p.phone}`} onClick={() => tap("call_tap")}>Call</a>}
        {p.email && <a className="btn sm muted" href={`mailto:${p.email}`} onClick={() => tap("email_tap")}>Email</a>}
        {!closed && <button className="btn sm" onClick={() => setModal("log")}>Log action</button>}
        {!(p.stage === "closed_won" && p.closed_won_at) && <button className="btn sm ghost" onClick={() => setModal("stage")}>Change stage</button>}
        <button className="btn sm ghost" onClick={() => setModal("edit")}>Edit details</button>
      </div>

      {mgmt && p.stage === "closed_won" && !p.closed_won_at && (
        <div className="card warn">
          <h3>Closed won approval</h3>
          <div>{p.owner_name} marked this won for <b>{usd(p.deal_value_usd)}</b> · {label(p.engagement_model)} · terms: {p.payment_terms}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ok" onClick={() => act(() => post(`/prospects/${id}/approve`, { approve: true }))}>Approve</button>
            <button className="btn danger" onClick={() => setModal("decline")}>Decline</button>
          </div>
        </div>
      )}
      {pendingReqs.length > 0 && (isOwner || mgmt) && (
        <div className="card warn">
          <h3>Partner requests</h3>
          <ul className="list">{pendingReqs.map((r: any) => <li key={r.id}><div className="main"><div className="title">{r.requester_name} asked to join as partner</div><div className="sub">{fmtDateTime(r.created_at)} · 30% share would split 15% each</div></div><div className="row"><button className="btn sm ok" onClick={() => act(() => post(`/prospects/${id}/partner-request/${r.id}`, { accept: true }))}>Accept</button><button className="btn sm muted" onClick={() => act(() => post(`/prospects/${id}/partner-request/${r.id}`, { accept: false }))}>Decline</button></div></li>)}</ul>
        </div>
      )}
      {p.closed_won_at && (
        <div className="card">
          <h3>After close</h3>
          <div className="row between">
            <div>Status: <b>{label(p.after_close_status)}</b>{p.expected_delivery_date && p.after_close_status === "in_delivery" ? <span className="muted"> · expected {fmtDate(p.expected_delivery_date)}</span> : null}{p.delivered_at ? <span className="muted"> · delivered {fmtDate(p.delivered_at)}</span> : null}{p.retainer_finished_at ? <span className="muted"> · finished {fmtDate(p.retainer_finished_at)}</span> : null}</div>
            {p.after_close_status === "in_delivery" && <button className="btn sm" onClick={() => setModal("delivered")}>Mark delivered</button>}
            {p.after_close_status === "active_retainer" && <button className="btn sm" onClick={() => setModal("finished")}>Mark retainer finished</button>}
          </div>
        </div>
      )}

      <div className="grid" style={{ alignItems: "start" }}>
        <div>
          <div className="card">
            <h3>Details</h3>
            <table><tbody>
              <tr><td className="muted">Email</td><td>{p.email ?? "—"}</td></tr>
              <tr><td className="muted">Phone</td><td>{p.phone ?? "—"}</td></tr>
              <tr><td className="muted">Website</td><td>{p.website ? <a href={p.website.startsWith("http") ? p.website : `https://${p.website}`} target="_blank" rel="noreferrer">{p.website}</a> : "—"}</td></tr>
              <tr><td className="muted">Source</td><td>{label(p.source)}{p.campaign_tag ? ` · ${p.campaign_tag}` : ""}</td></tr>
              <tr><td className="muted">Service</td><td>{label(p.service_interest)}</td></tr>
              <tr><td className="muted">Engagement</td><td>{label(p.engagement_model)}</td></tr>
              <tr><td className="muted">Payment terms</td><td>{p.payment_terms ?? "—"}</td></tr>
              {p.lost_reason && <tr><td className="muted">Lost reason</td><td>{label(p.lost_reason)}</td></tr>}
              <tr><td className="muted">Next follow-up</td><td>{p.next_follow_up ? <span className={p.next_follow_up < todayPk() && !closed ? "chip red" : ""}>{fmtDate(p.next_follow_up)}</span> : closed ? "—" : <span className="chip red">Not set</span>}</td></tr>
              <tr><td className="muted">Last activity</td><td>{fmtDateTime(p.last_activity_at)}</td></tr>
              {(p.estimated_cost_usd != null || p.actual_cost_usd != null) && <tr><td className="muted">Project cost</td><td>{p.actual_cost_usd != null ? `${usd(p.actual_cost_usd)} actual` : `${usd(p.estimated_cost_usd)} estimated`}</td></tr>}
              <tr><td className="muted">Added</td><td>{fmtDateTime(p.created_at)}</td></tr>
            </tbody></table>
            {mgmt && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm muted" onClick={() => setModal("assign")}>Reassign owner</button>
                <button className="btn sm muted" onClick={() => setModal("partner")}>{p.partner_id ? "Change partner" : "Add partner"}</button>
              </div>
            )}
          </div>
          {!closed && (
            <div className="card">
              <h3>Follow-ups</h3>
              {openFollowUps.length === 0 ? <div className="chip red">No follow-up scheduled. Log an action to set one.</div> : <ul className="list">{openFollowUps.map((f: any) => <li key={f.id}><div className="main"><div className="title">{fmtDate(f.due_date)}</div><div className="sub">{label(f.kind)}</div></div>{f.due_date < todayPk() && <span className="chip red">Overdue</span>}</li>)}</ul>}
            </div>
          )}
          <div className="card">
            <div className="row between"><h3>Meetings</h3>{mgmt && <button className="btn sm" onClick={() => setModal("meeting")}>Log meeting</button>}</div>
            {!mgmt && <div className="small muted" style={{ marginBottom: 6 }}>Meetings are logged by Abdul from Calendly and credited to you.</div>}
            {meetings.length === 0 ? <div className="muted">No meetings yet.</div> : <ul className="list">{meetings.map((m: any) => <li key={m.id}><div className="main"><div className="title">{fmtDateTime(m.scheduled_at)} {statusChip(m.status)}</div><div className="sub">Credited to {m.credited_name}{m.link ? <> · <a href={m.link} target="_blank" rel="noreferrer">link</a></> : null}{m.prep_notes ? ` · ${m.prep_notes}` : ""}</div></div>{mgmt && m.status === "booked" && <div className="row" style={{ flexWrap: "nowrap" }}><button className="btn sm ok" onClick={() => act(() => patch(`/meetings/${m.id}`, { status: "held" }))}>Held</button><button className="btn sm danger" onClick={() => act(() => patch(`/meetings/${m.id}`, { status: "no_show" }))}>No-show</button></div>}</li>)}</ul>}
          </div>
          <div className="card">
            <div className="row between"><h3>Tasks</h3>{mgmt && <button className="btn sm" onClick={() => setModal("task")}>New task</button>}</div>
            {tasks.length === 0 ? <div className="muted">No tasks linked.</div> : <ul className="list">{tasks.map((t: any) => <li key={t.id}><div className="main"><div className="title">{t.title}</div><div className="sub">{t.assigned_to_name} · due {fmtDate(t.due_date)} · {label(t.status)}</div></div>{t.status !== "done" && (t.assigned_to === user.id || mgmt) && <button className="btn sm ok" onClick={() => setTaskModal({ task: t, mode: "done" })}>Done</button>}</li>)}</ul>}
          </div>
        </div>
        <div>
          {p.closed_won_at && (
            <div className="card">
              <div className="row between"><h3>Payments</h3>{mgmt && p.after_close_status !== "retainer_finished" && <button className="btn sm" onClick={() => setModal("payment")}>Record payment</button>}</div>
              {payments.length === 0 ? <div className="muted">No payment recorded yet. Commission stays Pending until the client pays.</div> : <ul className="list">{payments.map((pay: any) => <li key={pay.id}><div className="main"><div className="title">{pay.label ?? `Payment ${pay.sequence}`} · {usd2(pay.amount_usd)}{pay.currency !== "USD" ? <span className="muted small"> ({pay.amount} {pay.currency})</span> : null} {pay.reversed_at && <span className="chip red">Reversed</span>}{pay.fx_fallback ? <span className="chip warn" title="Rate service unavailable that day; last fetched rate used. Final.">Fallback rate</span> : null}</div><div className="sub">Received {fmtDate(pay.received_at)}{pay.note ? ` · ${pay.note}` : ""}</div></div>{mgmt && !pay.reversed_at && <button className="btn sm danger" onClick={() => setModal(`reverse:${pay.id}`)}>Reverse</button>}</li>)}</ul>}
            </div>
          )}
          {commission.length > 0 && (
            <div className="card">
              <h3>Commission</h3>
              <ul className="list">{commission.map((c: any) => <li key={c.id}><div className="main"><div className="title">{mgmt && c.user_name ? `${c.user_name} · ` : ""}{label(c.kind)} · <span style={{ color: c.amount_usd < 0 ? "var(--danger)" : undefined }}>{usd2(c.amount_usd)}</span> {statusChip(c.status)}</div><div className="sub">{c.description}{c.model ? ` · ${label(c.model)}${c.rate ? ` ${Math.round(c.rate * 100)}%` : ""}` : ""}{c.base_usd != null ? ` · on ${usd2(c.base_usd)}` : ""}{c.cost_share_usd != null ? ` · cost share ${usd2(c.cost_share_usd)}` : ""}</div></div></li>)}</ul>
            </div>
          )}
          <div className="card">
            <div className="row between"><h3>Notes</h3><button className="btn sm" onClick={() => setModal("note")}>Add note</button></div>
            {notes.length === 0 ? <div className="muted">No notes.</div> : <ul className="list">{notes.map((n: any) => <li key={n.id}><div className="main"><div>{n.body}</div><div className="sub">{n.user_name} · {fmtDateTime(n.created_at)}</div></div></li>)}</ul>}
          </div>
          <div className="card">
            <h3>Activity log</h3>
            <ul className="list">{activities.map((a: any) => <li key={a.id}><div className="main"><div className="title" style={{ fontWeight: 500 }}>{label(a.type)}{a.detail ? <span className="muted"> · {a.detail.length > 140 ? a.detail.slice(0, 140) + "…" : a.detail}</span> : null}</div><div className="sub">{a.user_name} · {fmtDateTime(a.occurred_at)}</div></div></li>)}</ul>
          </div>
        </div>
      </div>

      {modal === "log" && <LogActionModal prospect={{ id, company: p.company, is_cold: p.is_cold }} onClose={() => setModal(null)} onDone={d.reload} />}
      {modal === "stage" && <StageModal p={p} user={user} stages={meta.data?.stages ?? []} lostReasons={meta.data?.lost_reasons ?? []} engagements={meta.data?.engagements ?? []} onClose={() => setModal(null)} onDone={d.reload} />}
      {modal === "edit" && <EditModal p={p} mgmt={mgmt} meta={meta.data} onClose={() => setModal(null)} onDone={d.reload} />}
      {modal === "note" && <TextModal title="Add note" label="Note" onClose={() => setModal(null)} onSave={async v => { await offlineWrite("POST", `/prospects/${id}/notes`, { body: v }); d.reload(); }} />}
      {modal === "decline" && <TextModal title="Decline Closed won" label="Reason (goes back to Negotiation)" onClose={() => setModal(null)} onSave={async v => { await post(`/prospects/${id}/approve`, { approve: false, note: v }); d.reload(); }} danger />}
      {modal?.startsWith("reverse:") && <TextModal title="Reverse payment (clawback)" label="Reason" hint="Commission already paid on it is deducted from the next payout." onClose={() => setModal(null)} onSave={async v => { await post(`/payments/${modal.split(":")[1]}/reverse`, { reason: v }); d.reload(); }} danger />}
      {(modal === "delivered" || modal === "finished") && <DateModal title={modal === "delivered" ? "Mark project delivered" : "Mark retainer finished"} onClose={() => setModal(null)} onSave={async v => { await post(`/prospects/${id}/after-close`, { status: modal === "delivered" ? "project_delivered" : "retainer_finished", date: v }); d.reload(); }} />}
      {modal === "meeting" && <MeetingModal prospectId={id} meetings={meetings} onClose={() => setModal(null)} onDone={d.reload} />}
      {modal === "payment" && <PaymentModal p={p} onClose={() => setModal(null)} onDone={d.reload} />}
      {modal === "task" && <NewTaskModal users={agents} prospectId={id} onClose={() => setModal(null)} onDone={d.reload} />}
      {modal === "assign" && <PickUserModal title="Reassign owner" users={agents.filter((u: any) => u.id !== p.owner_id)} onClose={() => setModal(null)} onPick={async uid => { await post(`/prospects/${id}/assign`, { owner_id: uid }); d.reload(); }} />}
      {modal === "partner" && <PickUserModal title="Partner on this deal" hint="Applies to payments received from now. Removing clears the partner." users={agents.filter((u: any) => u.id !== p.owner_id)} allowNone onClose={() => setModal(null)} onPick={async uid => { await post(`/prospects/${id}/partner`, { partner_id: uid }); d.reload(); }} />}
      {taskModal && <TaskDoneModal task={taskModal.task} mode={taskModal.mode} onClose={() => setTaskModal(null)} onDone={d.reload} />}
    </div>
  );
}

function StageModal({ p, user, stages, lostReasons, engagements, onClose, onDone }: { p: any; user: User; stages: string[]; lostReasons: string[]; engagements: string[]; onClose: () => void; onDone: () => void }) {
  const mgmt = user.role !== "agent";
  const options = stages.filter(s => s !== p.stage && (mgmt || !["meeting_booked", "meeting_held"].includes(s)));
  const [stage, setStage] = useState(options[0] ?? "");
  const [f, setF] = useState<any>({ deal_value: p.deal_value ?? "", deal_currency: p.deal_currency ?? "USD", engagement_model: p.engagement_model ?? "", payment_terms: p.payment_terms ?? "", expected_delivery_date: "", lost_reason: "no_response", note: "", next_follow_up: addDays(todayPk(), 3) });
  const set = (k: string, v: string) => setF((s: any) => ({ ...s, [k]: v }));
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [result, setResult] = useState<any>(null);
  const needsValue = ["proposal_sent", "negotiation", "closed_won"].includes(stage) && (p.deal_value == null || stage === "proposal_sent");
  async function save() {
    setBusy(true); setErr(null);
    try {
      const body: any = { stage, note: f.note || undefined };
      if (!["closed_won", "closed_lost"].includes(stage)) body.next_follow_up = f.next_follow_up || null;
      if (needsValue || stage === "proposal_sent") { body.deal_value = Number(f.deal_value); body.deal_currency = f.deal_currency; body.engagement_model = f.engagement_model || undefined; }
      if (stage === "closed_won") { body.payment_terms = f.payment_terms; if (f.expected_delivery_date) body.expected_delivery_date = f.expected_delivery_date; if (f.deal_value && p.deal_value == null) { body.deal_value = Number(f.deal_value); body.deal_currency = f.deal_currency; } }
      if (stage === "closed_lost") body.lost_reason = f.lost_reason;
      const r = await post(`/prospects/${p.id}/stage`, body);
      setResult(r); onDone(); if (!r.pending_approval) onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  if (result?.pending_approval) return <Modal title="Sent for approval" onClose={onClose}><div className="info">Marked Closed won. Abdul or Adnan will approve it; commission is created on approval.</div><button className="btn" onClick={onClose}>OK</button></Modal>;
  return (
    <Modal title="Change stage" onClose={onClose}>
      <Field label="New stage"><Select value={stage} onChange={setStage} options={options} labelFn={label} /></Field>
      {!mgmt && <div className="small muted" style={{ marginBottom: 8 }}>Meetings are logged by Abdul from Calendly, so Meeting booked and Meeting held are not listed here.</div>}
      {(stage === "proposal_sent" || (needsValue && stage !== "closed_lost")) && (
        <div className="form-grid">
          <Field label="Deal value *"><input type="number" min="0" step="0.01" value={f.deal_value} onChange={e => set("deal_value", e.target.value)} /></Field>
          <Field label="Currency *" hint="Converted to USD at today's rate"><Select value={f.deal_currency} onChange={v => set("deal_currency", v)} options={CURRENCIES} /></Field>
          <Field label="Engagement model *"><Select value={f.engagement_model} onChange={v => set("engagement_model", v)} options={engagements} labelFn={label} allowEmpty="Pick one" /></Field>
        </div>
      )}
      {stage === "closed_won" && (
        <>
          <Field label="Payment terms *" hint="e.g. 50% upfront, 50% on delivery; or monthly"><input value={f.payment_terms} onChange={e => set("payment_terms", e.target.value)} /></Field>
          {!["monthly_retainer", "dedicated_resource"].includes(f.engagement_model || p.engagement_model) && <Field label="Expected delivery date"><input type="date" value={f.expected_delivery_date} onChange={e => set("expected_delivery_date", e.target.value)} /></Field>}
          {!mgmt && <div className="info">Abdul or Adnan must approve. Until then the deal shows as awaiting approval.</div>}
        </>
      )}
      {stage === "closed_lost" && <Field label="Lost reason *"><Select value={f.lost_reason} onChange={v => set("lost_reason", v)} options={lostReasons} labelFn={label} /></Field>}
      {!["closed_won", "closed_lost"].includes(stage) && <Field label="Next follow-up *"><input type="date" value={f.next_follow_up} onChange={e => set("next_follow_up", e.target.value)} /></Field>}
      <Field label="Note (optional)"><input value={f.note} onChange={e => set("note", e.target.value)} /></Field>
      <Err e={err} />
      <button className="btn" disabled={busy || !stage} onClick={save}>Move to {label(stage)}</button>
    </Modal>
  );
}

function EditModal({ p, mgmt, meta, onClose, onDone }: { p: any; mgmt: boolean; meta: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ company: p.company, contact_name: p.contact_name, email: p.email ?? "", phone: p.phone ?? "", website: p.website ?? "", country: p.country ?? "", source: p.source, service_interest: p.service_interest, campaign_tag: p.campaign_tag ?? "", next_follow_up: p.next_follow_up ?? "", deal_value: p.deal_value ?? "", deal_currency: p.deal_currency ?? "USD", engagement_model: p.engagement_model ?? "", payment_terms: p.payment_terms ?? "", expected_delivery_date: p.expected_delivery_date ?? "", estimated_cost_usd: p.estimated_cost_usd ?? "", actual_cost_usd: p.actual_cost_usd ?? "" });
  const set = (k: string, v: string) => setF((s: any) => ({ ...s, [k]: v }));
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const closed = ["closed_won", "closed_lost"].includes(p.stage);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const body: any = { company: f.company, contact_name: f.contact_name, email: f.email || null, phone: f.phone || null, website: f.website || null, country: f.country || null, source: f.source, service_interest: f.service_interest, campaign_tag: f.campaign_tag || null, payment_terms: f.payment_terms || null, expected_delivery_date: f.expected_delivery_date || null, engagement_model: f.engagement_model || null };
      if (!closed && f.next_follow_up) body.next_follow_up = f.next_follow_up;
      if (f.deal_value !== "" && f.deal_value != null) { body.deal_value = Number(f.deal_value); body.deal_currency = f.deal_currency; }
      if (mgmt) { body.estimated_cost_usd = f.estimated_cost_usd === "" ? null : Number(f.estimated_cost_usd); body.actual_cost_usd = f.actual_cost_usd === "" ? null : Number(f.actual_cost_usd); }
      await patch(`/prospects/${p.id}`, body); onDone(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title="Edit details" onClose={onClose}>
      <div className="form-grid">
        <Field label="Company"><input value={f.company} onChange={e => set("company", e.target.value)} /></Field>
        <Field label="Contact name"><input value={f.contact_name} onChange={e => set("contact_name", e.target.value)} /></Field>
        <Field label="Email"><input value={f.email} onChange={e => set("email", e.target.value)} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={e => set("phone", e.target.value)} /></Field>
        <Field label="Website"><input value={f.website} onChange={e => set("website", e.target.value)} /></Field>
        <Field label="Country"><input value={f.country} onChange={e => set("country", e.target.value)} /></Field>
        <Field label="Source"><Select value={f.source} onChange={v => set("source", v)} options={meta?.sources ?? [f.source]} labelFn={label} /></Field>
        <Field label="Service interest"><Select value={f.service_interest} onChange={v => set("service_interest", v)} options={meta?.services ?? [f.service_interest]} labelFn={label} /></Field>
        <Field label="Campaign tag"><input value={f.campaign_tag} onChange={e => set("campaign_tag", e.target.value)} /></Field>
        {!closed && <Field label="Next follow-up"><input type="date" value={f.next_follow_up} onChange={e => set("next_follow_up", e.target.value)} /></Field>}
        <Field label="Deal value"><input type="number" step="0.01" value={f.deal_value} onChange={e => set("deal_value", e.target.value)} /></Field>
        <Field label="Currency"><Select value={f.deal_currency} onChange={v => set("deal_currency", v)} options={CURRENCIES} /></Field>
        <Field label="Engagement model"><Select value={f.engagement_model} onChange={v => set("engagement_model", v)} options={meta?.engagements ?? []} labelFn={label} allowEmpty="—" /></Field>
        <Field label="Payment terms"><input value={f.payment_terms} onChange={e => set("payment_terms", e.target.value)} /></Field>
        <Field label="Expected delivery date"><input type="date" value={f.expected_delivery_date} onChange={e => set("expected_delivery_date", e.target.value)} /></Field>
        {mgmt && <Field label="Estimated project cost (USD)" hint="Profit split model: entered at Closed won, revisable until delivered"><input type="number" step="0.01" value={f.estimated_cost_usd} onChange={e => set("estimated_cost_usd", e.target.value)} /></Field>}
        {mgmt && <Field label="Actual project cost (USD)" hint="Final payment carries a true-up to this figure"><input type="number" step="0.01" value={f.actual_cost_usd} onChange={e => set("actual_cost_usd", e.target.value)} /></Field>}
      </div>
      {mgmt && <div className="small muted" style={{ marginBottom: 8 }}>The agent sees the cost and the resulting split on each payment, so there are no disputes.</div>}
      <Err e={err} />
      <button className="btn" disabled={busy} onClick={save}>Save</button>
    </Modal>
  );
}

function TextModal({ title, label: lbl, hint, danger, onClose, onSave }: { title: string; label: string; hint?: string; danger?: boolean; onClose: () => void; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(""); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose}><Field label={lbl} hint={hint}><textarea value={v} onChange={e => setV(e.target.value)} autoFocus /></Field><Err e={err} /><button className={`btn ${danger ? "danger" : ""}`} disabled={busy || !v.trim()} onClick={async () => { setBusy(true); setErr(null); try { await onSave(v); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>Save</button></Modal>;
}
function DateModal({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(todayPk()); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose}><Field label="Date"><input type="date" value={v} onChange={e => setV(e.target.value)} /></Field><Err e={err} /><button className="btn" disabled={busy || !v} onClick={async () => { setBusy(true); setErr(null); try { await onSave(v); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>Save</button></Modal>;
}
function PickUserModal({ title, hint, users, allowNone, onClose, onPick }: { title: string; hint?: string; users: any[]; allowNone?: boolean; onClose: () => void; onPick: (id: number | null) => Promise<void> }) {
  const [v, setV] = useState(""); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose}><Field label="Person" hint={hint}><Select value={v} onChange={setV} options={users.map(u => ({ value: String(u.id), label: `${u.name} (${u.role})` }))} allowEmpty={allowNone ? "None (remove)" : "Pick…"} /></Field><Err e={err} /><button className="btn" disabled={busy || (!v && !allowNone)} onClick={async () => { setBusy(true); setErr(null); try { await onPick(v ? Number(v) : null); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>Save</button></Modal>;
}
export function MeetingModal({ prospectId, meetings, onClose, onDone }: { prospectId: number; meetings: any[]; onClose: () => void; onDone: () => void }) {
  const [when, setWhen] = useState(""); const [link, setLink] = useState(""); const [prep, setPrep] = useState(""); const [rebook, setRebook] = useState("");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const noShows = meetings.filter(m => m.status === "no_show");
  async function save() {
    setBusy(true); setErr(null);
    try {
      // datetime-local is entered in Pakistan time; convert to UTC ISO
      const iso = new Date(new Date(when).getTime() - (new Date().getTimezoneOffset() * 60000) - 5 * 3600 * 1000).toISOString();
      await post("/meetings", { prospect_id: prospectId, scheduled_at: iso, timezone: "Asia/Karachi", link: link || null, prep_notes: prep || null, rebooked_from: rebook ? Number(rebook) : undefined }); onDone(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title="Log meeting from Calendly" onClose={onClose}>
      <Field label="Date and time (Pakistan time) *"><input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
      <Field label="Meeting link"><input value={link} onChange={e => setLink(e.target.value)} /></Field>
      <Field label="Prep notes"><input value={prep} onChange={e => setPrep(e.target.value)} /></Field>
      {noShows.length > 0 && <Field label="Rebooking a no-show?" hint="A rebooked no-show counts once on the leaderboard"><Select value={rebook} onChange={setRebook} options={noShows.map(m => ({ value: String(m.id), label: fmtDateTime(m.scheduled_at) }))} allowEmpty="No, new meeting" /></Field>}
      <div className="small muted" style={{ marginBottom: 8 }}>Credited to the prospect's owner. Moves the stage to Meeting booked.</div>
      <Err e={err} />
      <button className="btn" disabled={busy || !when} onClick={save}>Log meeting</button>
    </Modal>
  );
}
function PaymentModal({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const retainer = ["monthly_retainer", "dedicated_resource"].includes(p.engagement_model);
  const [f, setF] = useState<any>({ amount: "", currency: p.deal_currency ?? "USD", received_at: todayPk(), label: "", note: "" });
  const set = (k: string, v: string) => setF((s: any) => ({ ...s, [k]: v }));
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [res, setRes] = useState<any>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { const r = await post("/payments", { prospect_id: p.id, amount: Number(f.amount), currency: f.currency, received_at: f.received_at, label: f.label || undefined, note: f.note || undefined }); setRes(r); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  if (res) return <Modal title="Payment recorded" onClose={onClose}><div className="info">{usd2(res.amount_usd)} recorded{res.fx_fallback ? " using the last fetched rate (rate service unavailable). This is final." : ""}. Commission moved to Payable and the agent was notified.</div><button className="btn" onClick={onClose}>Done</button></Modal>;
  return (
    <Modal title="Record client payment" onClose={onClose}>
      <div className="form-grid">
        <Field label="Amount *"><input type="number" min="0" step="0.01" value={f.amount} onChange={e => set("amount", e.target.value)} autoFocus /></Field>
        <Field label="Currency *" hint="Converted to USD at the rate for the received date"><Select value={f.currency} onChange={v => set("currency", v)} options={CURRENCIES} /></Field>
        <Field label="Date received *"><input type="date" value={f.received_at} onChange={e => set("received_at", e.target.value)} /></Field>
        <Field label={retainer ? "Month (e.g. October)" : "Milestone (e.g. Upfront)"}><input value={f.label} onChange={e => set("label", e.target.value)} /></Field>
      </div>
      <Field label="Note (if the amount differs from what was expected)"><input value={f.note} onChange={e => set("note", e.target.value)} /></Field>
      {retainer && <div className="small muted" style={{ marginBottom: 8 }}>First payment on a retainer pays 30% commission, every later payment 10%.</div>}
      <Err e={err} />
      <button className="btn" disabled={busy || !f.amount || !f.received_at} onClick={save}>Record payment</button>
    </Modal>
  );
}
void nav; void Link;
