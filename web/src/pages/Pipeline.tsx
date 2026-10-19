import { useEffect, useState } from "react";
import { get, post, offlineWrite, ApiError, usd, label, fmtDate, todayPk, addDays, type User } from "../lib/api";
import { Modal, Field, Select, Err, Empty, Stage, useAsync, nav } from "../lib/ui";

const CURRENCIES = ["USD", "PKR", "AED", "GBP", "EUR", "SAR"];
export { CURRENCIES };

export function AddProspectModal({ user, onClose, onCreated }: { user: User; onClose: () => void; onCreated: (id?: number) => void }) {
  const meta = useAsync(() => get("/prospects/meta"), []);
  const users = useAsync(() => get("/users"), []);
  const mgmt = user.role !== "agent";
  const [f, setF] = useState<any>({ company: "", contact_name: "", email: "", phone: "", website: "", country: "", source: "cold_email", service_interest: "web_shopify", campaign_tag: "", next_follow_up: addDays(todayPk(), 1), notes: "", partner_id: "", owner_id: String(user.id) });
  const [dup, setDup] = useState<any>(null);
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s: any) => ({ ...s, [k]: v }));
  async function checkDup() {
    if (!navigator.onLine) return;
    if (!f.email && !f.phone && !f.website) { setDup(null); return; }
    try { const r = await post("/prospects/check-duplicate", { email: f.email || null, phone: f.phone || null, website: f.website || null }); setDup(r.matches[0] ?? null); } catch { /* ignore */ }
  }
  async function requestJoin(id: number) { setErr(null); try { await post(`/prospects/${id}/partner-request`, {}); setRequested(true); } catch (e) { setErr(e); } }
  async function save() {
    setBusy(true); setErr(null);
    try {
      const body: any = { company: f.company, contact_name: f.contact_name, email: f.email || null, phone: f.phone || null, website: f.website || null, country: f.country || null, source: f.source, service_interest: f.service_interest, campaign_tag: f.campaign_tag || null, next_follow_up: f.next_follow_up || null, notes: f.notes || undefined, partner_id: f.partner_id ? Number(f.partner_id) : null };
      if (mgmt) body.owner_id = f.owner_id ? Number(f.owner_id) : null;
      const r: any = await offlineWrite("POST", "/prospects", body);
      onCreated(r?.id); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.duplicate) setDup(e.data.duplicate); else setErr(e);
    } finally { setBusy(false); }
  }
  const others = (users.data ?? []).filter((u: any) => u.active !== 0 && u.id !== Number(mgmt ? f.owner_id : user.id));
  return (
    <Modal title="Add prospect" onClose={onClose}>
      {dup && (
        <div className="card warn" style={{ marginBottom: 10 }}>
          <div className="b">Already in the CRM</div>
          <div className="small">{dup.company} · owned by <b>{dup.owner_name}</b> · added {fmtDate(dup.created_at)}{dup.matched_on?.length ? ` · matched on ${dup.matched_on.join(", ")}` : ""}</div>
          <div className="small muted">First entry wins ownership. You can ask to join as partner (15% each on close).</div>
          {requested ? <div className="info">Request sent to the owner, Abdul and Adnan.</div> : dup.owner_id !== user.id ? <button className="btn sm" style={{ marginTop: 6 }} onClick={() => requestJoin(dup.id)}>Request to join as partner</button> : <div className="info">This is already your prospect.</div>}
        </div>
      )}
      <div className="form-grid">
        <Field label="Company *"><input value={f.company} onChange={e => set("company", e.target.value)} /></Field>
        <Field label="Contact name *"><input value={f.contact_name} onChange={e => set("contact_name", e.target.value)} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={e => set("email", e.target.value)} onBlur={checkDup} /></Field>
        <Field label="Phone (with country code)"><input value={f.phone} onChange={e => set("phone", e.target.value)} onBlur={checkDup} placeholder="+92 300 1234567" /></Field>
        <Field label="Website"><input value={f.website} onChange={e => set("website", e.target.value)} onBlur={checkDup} /></Field>
        <Field label="Country"><input value={f.country} onChange={e => set("country", e.target.value)} /></Field>
        <Field label="Source *"><Select value={f.source} onChange={v => set("source", v)} options={meta.data?.sources ?? ["cold_email"]} labelFn={label} /></Field>
        <Field label="Service interest *"><Select value={f.service_interest} onChange={v => set("service_interest", v)} options={meta.data?.services ?? ["web_shopify"]} labelFn={label} /></Field>
        <Field label="Campaign tag" hint="Email sequence or ad set name"><input value={f.campaign_tag} onChange={e => set("campaign_tag", e.target.value)} /></Field>
        <Field label="Next follow-up *"><input type="date" value={f.next_follow_up} onChange={e => set("next_follow_up", e.target.value)} /></Field>
        {mgmt && <Field label="Owner (agent)"><Select value={f.owner_id} onChange={v => set("owner_id", v)} options={(users.data ?? []).filter((u: any) => u.active !== 0).map((u: any) => ({ value: String(u.id), label: u.name }))} allowEmpty="Unassigned pool" /></Field>}
        <Field label="Is anyone else involved in this deal?" hint="They become partner; the 30% share splits 15% each"><Select value={f.partner_id} onChange={v => set("partner_id", v)} options={others.map((u: any) => ({ value: String(u.id), label: u.name }))} allowEmpty="No, just me" /></Field>
      </div>
      <Field label="Notes"><textarea value={f.notes} onChange={e => set("notes", e.target.value)} /></Field>
      <Err e={err} />
      <button className="btn" disabled={busy || !!dup || !f.company || !f.contact_name} onClick={save}>{busy ? "Saving…" : "Save prospect"}</button>
      {!navigator.onLine && <div className="small muted" style={{ marginTop: 6 }}>Offline: this will be saved on the device and checked for duplicates when it syncs.</div>}
    </Modal>
  );
}

export function PipelinePage({ user, query }: { user: User; query: URLSearchParams }) {
  const mgmt = user.role !== "agent";
  const [stage, setStage] = useState(query.get("stage") ?? "");
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState(query.get("owner_id") ?? "");
  const [unassigned, setUnassigned] = useState(query.get("unassigned") === "1");
  const [add, setAdd] = useState(false);
  const [assigning, setAssigning] = useState<number | null>(null);
  const meta = useAsync(() => get("/prospects/meta"), []);
  const users = useAsync(() => mgmt ? get("/users") : Promise.resolve([]), []);
  const qs = new URLSearchParams(); if (stage) qs.set("stage", stage); if (search) qs.set("search", search); if (owner) qs.set("owner_id", owner); if (unassigned) qs.set("unassigned", "1");
  const list = useAsync(() => get(`/prospects?${qs}`), [stage, search, owner, unassigned]);
  useEffect(() => { setStage(query.get("stage") ?? ""); setUnassigned(query.get("unassigned") === "1"); }, [query.toString()]);
  const today = todayPk();
  async function assign(id: number, ownerId: string) { if (!ownerId) return; await post(`/prospects/${id}/assign`, { owner_id: Number(ownerId) }); setAssigning(null); list.reload(); }
  const agents = (users.data ?? []).filter((u: any) => u.active !== 0);
  return (
    <div>
      <div className="row between"><h1>{unassigned ? "Unassigned leads" : "Pipeline"}</h1><span className="muted small">{list.data?.length ?? 0} prospects</span></div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input placeholder="Search company, contact, email" value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        {mgmt && <select value={owner} onChange={e => setOwner(e.target.value)} style={{ width: "auto" }}><option value="">All agents</option>{agents.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        {mgmt && <button className={`btn sm ${unassigned ? "" : "muted"}`} onClick={() => setUnassigned(u => !u)}>Unassigned</button>}
      </div>
      <div className="tabs"><button className={stage === "" ? "active" : ""} onClick={() => setStage("")}>All</button>{(meta.data?.stages ?? []).map((s: string) => <button key={s} className={stage === s ? "active" : ""} onClick={() => setStage(s)}>{label(s)}</button>)}</div>
      <Err e={list.error} />
      <div className="card">
        {list.loading && !list.data ? <div className="center">Loading…</div> : !list.data?.length ? <Empty text={unassigned ? "No unassigned leads." : "No prospects here yet. Tap + to add one."} /> : (
          <ul className="list">{list.data.map((p: any) => (
            <li key={p.id} style={{ cursor: "pointer" }} onClick={() => nav(`/prospects/${p.id}`)}>
              <div className="main">
                <div className="title">{p.company} <span className="muted" style={{ fontWeight: 400 }}>· {p.contact_name}</span></div>
                <div className="sub row" style={{ gap: 6 }}>
                  <Stage s={p.stage} />
                  {p.is_cold ? <span className="chip warn">Cold</span> : null}
                  {mgmt && <span className="chip grey">{p.owner_name ?? "Unassigned"}</span>}
                  {p.partner_name && <span className="chip">+ {p.partner_name}</span>}
                  {p.next_due && !["closed_won", "closed_lost"].includes(p.stage) && <span className={p.next_due < today ? "chip red" : "chip grey"}>Follow-up {fmtDate(p.next_due)}</span>}
                  {!p.next_due && !["closed_won", "closed_lost"].includes(p.stage) && p.owner_id && <span className="chip red">No date</span>}
                  {p.meeting_count > 0 && <span className="chip grey">{p.meeting_count} mtg</span>}
                  {p.deal_value_usd != null && <span className="b">{usd(p.deal_value_usd)}</span>}
                </div>
              </div>
              {mgmt && !p.owner_id && (assigning === p.id
                ? <select autoFocus onClick={e => e.stopPropagation()} onChange={e => assign(p.id, e.target.value)} style={{ width: 140 }}><option value="">Assign to…</option>{agents.filter((u: any) => u.role === "agent").map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                : <button className="btn sm" onClick={e => { e.stopPropagation(); setAssigning(p.id); }}>Assign</button>)}
            </li>
          ))}</ul>
        )}
      </div>
      <button className="fab" onClick={() => setAdd(true)} aria-label="Add prospect">+</button>
      {add && <AddProspectModal user={user} onClose={() => setAdd(false)} onCreated={id => { list.reload(); if (id) nav(`/prospects/${id}`); }} />}
    </div>
  );
}
