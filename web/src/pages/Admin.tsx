import { useState } from "react";
import { get, post, patch, api, label, fmtDateTime, type User } from "../lib/api";
import { useAsync, Err, Empty, Modal, Field, Select, Tabs, nav, Link } from "../lib/ui";
import { METRIC_LABEL } from "./Targets";

const TABS = [["users", "Users"], ["settings", "Settings"], ["integrations", "Integrations"], ["leaderboards", "Leaderboards"], ["import", "Import"], ["unassigned", "Unassigned"], ["reassign", "Reassign"]].map(([id, l]) => ({ id, label: l }));

export function AdminPage({ user, tab }: { user: User; tab: string }) {
  const owner = user.role === "owner";
  return (
    <div>
      <h1>Admin</h1>
      <Tabs tabs={TABS} value={tab} onChange={t => nav(`/admin?tab=${t}`)} />
      {tab === "users" && <Users owner={owner} meId={user.id} />}
      {tab === "settings" && <Settings owner={owner} />}
      {tab === "integrations" && <Integrations owner={owner} />}
      {tab === "leaderboards" && <Leaderboards owner={owner} />}
      {tab === "import" && <Import />}
      {tab === "unassigned" && <Unassigned />}
      {tab === "reassign" && <Reassign owner={owner} />}
    </div>
  );
}

/* ---------------- Users ---------------- */
function Users({ owner, meId }: { owner: boolean; meId: number }) {
  const q = useAsync(() => get("/users"), []);
  const [editing, setEditing] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="row between"><h2>Users</h2>{owner && <button className="btn" onClick={() => setAdding(true)}>Add user</button>}</div>
      {!owner && <div className="info">Only Abdul can create or edit users.</div>}
      <Err e={q.error} />
      <div className="card table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Model</th><th className="num">Rate</th><th>Active</th><th>Last login</th><th /></tr></thead>
        <tbody>{((q.data ?? []) as any[]).map(u => (
          <tr key={u.id} style={u.active ? undefined : { opacity: .5 }}>
            <td className="b">{u.name}</td><td className="small">{u.email}</td><td>{u.role}</td>{u.role !== "agent" ? <td colSpan={2} className="small muted">Partner, no commission</td> : <><td>{label(u.commission_model)}</td><td className="num">{u.commission_rate != null ? `${Math.round(u.commission_rate * 100)}%` : "—"}</td></>}
            <td>{u.active ? "✓" : "✗"}</td><td className="small">{fmtDateTime(u.last_login_at)}</td>
            <td className="row" style={{ flexWrap: "nowrap" }}>{owner && <button className="btn sm muted" onClick={() => setEditing(u)}>Edit</button>}{owner && u.id !== meId && <button className="btn sm danger" title="Only possible for an account with no records" onClick={async () => { if (!confirm(`Remove ${u.name}? Only works if this account has no prospects, activities or commission.`)) return; try { await api("DELETE", `/users/${u.id}`); q.reload(); } catch (e) { alert((e as Error).message); } }}>Remove</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {adding && <UserForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
      {editing && <UserForm user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
    </div>
  );
}

function UserForm({ user, onClose, onSaved }: { user?: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: user?.name ?? "", email: user?.email ?? "", password: "", role: user?.role ?? "agent", commission_model: user?.commission_model ?? "revenue_share", rate: user ? String(Math.round(user.commission_rate * 100)) : "30", active: user ? !!user.active : true });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function save() {
    setErr(null); setBusy(true);
    try {
      const body: any = { name: f.name, email: f.email, role: f.role, commission_model: f.commission_model, commission_rate: Number(f.rate) / 100 };
      if (f.password) body.password = f.password;
      if (user) { body.active = f.active; await patch(`/users/${user.id}`, body); }
      else await post("/users", body);
      onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title={user ? `Edit ${user.name}` : "Add user"} onClose={onClose}>
      <div className="form-grid">
        <Field label="Name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={user ? "New password (leave blank to keep)" : "Password"} hint="At least 8 characters"><input type="text" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} autoComplete="off" /></Field>
        <Field label="Role"><Select value={f.role} onChange={v => setF({ ...f, role: v })} options={["agent", "manager", "owner"]} labelFn={label} /></Field>
        {f.role !== "owner" && <Field label="Commission model"><Select value={f.commission_model} onChange={v => setF({ ...f, commission_model: v })} options={[{ value: "revenue_share", label: "Revenue share (% of payment)" }, { value: "profit_split", label: "Profit split (50/50 after cost)" }]} /></Field>}
        {f.role !== "owner" && <Field label="Rate (%)" hint={f.commission_model === "profit_split" ? "Ignored for profit split (always 50/50)" : "Share of each payment received"}><input type="number" value={f.rate} onChange={e => setF({ ...f, rate: e.target.value })} /></Field>}
      </div>
      {f.role !== "agent" && <div className="info">Partners in the business (Owner and Manager) earn no commission; the fields below apply to sales agents only.</div>}
      {user && <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" style={{ width: "auto" }} checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} /> Active (deactivated users cannot log in; their records stay and can be reassigned)</label>}
      <p className="small muted">Retainer and dedicated-resource deals always use 30% first month then 10%, whatever the model. Changes apply to deals closed after today.</p>
      <Err e={err} />
      <button className="btn" disabled={busy || !f.name || !f.email || (!user && f.password.length < 8)} onClick={save}>{user ? "Save" : "Create user"}</button>
    </Modal>
  );
}

/* ---------------- Settings ---------------- */
const SETTING_FIELDS: [string, string, string][] = [
  ["clawback_days", "Clawback window (days after payment)", "number"],
  ["daily_min_activities", "Daily minimum outreach activities per agent", "number"],
  ["proposal_chase_days", "Proposal chase after (days)", "number"],
  ["overdue_alert_days", "Overdue alert after (days)", "number"],
  ["min_app_version", "Minimum app version (APK gate)", "text"],
  ["apk_download_url", "APK download URL", "text"],
];
function Settings({ owner }: { owner: boolean }) {
  const q = useAsync(() => get("/settings"), []);
  const rates = useAsync(() => get("/settings/rates"), []);
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState("");
  const vals = f ?? (q.data as Record<string, string> | undefined) ?? {};
  async function save() { setErr(null); setMsg(""); try { await api("PUT", "/settings", vals); setMsg("Saved."); setF(null); q.reload(); } catch (e) { setErr(e); } }
  async function refresh() { setErr(null); setMsg(""); try { const r = await post("/settings/rates/refresh"); setMsg(r.ok ? `Rates fetched for ${r.date}.` : `Fetch failed: ${r.error}. Last known rates stay in use.`); rates.reload(); } catch (e) { setErr(e); } }
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
      <div className="card">
        <h2>Working rules</h2>
        {!owner && <div className="info">Read-only for managers.</div>}
        <Err e={err || q.error} />{msg && <div className="info">{msg}</div>}
        {SETTING_FIELDS.map(([k, l, t]) => <Field key={k} label={l}><input type={t} value={vals[k] ?? ""} disabled={!owner} onChange={e => setF({ ...vals, [k]: e.target.value })} /></Field>)}
        {owner && <button className="btn" disabled={!f} onClick={save}>Save settings</button>}
      </div>
      <div className="card">
        <div className="row between"><h2>Exchange rates</h2><button className="btn sm ghost" onClick={refresh}>Refresh now</button></div>
        <p className="small muted">Pulled daily from a rate service. USD is frozen on every entry when it is created; a fallback rate is final and only flagged for information.</p>
        <Err e={rates.error} />
        <table><thead><tr><th>Currency</th><th className="num">USD per unit</th><th>Rate date</th><th /></tr></thead>
          <tbody>{Object.entries((rates.data?.rates ?? {}) as Record<string, any>).map(([c, r]) => <tr key={c}><td className="b">{c}</td><td className="num">{r ? r.usd_per_unit.toFixed(6) : "—"}</td><td className="small">{r?.rate_date ?? "none"}</td><td>{r?.is_fallback && <span className="chip warn">fallback</span>}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}


/* ---------------- Integrations ---------------- */
const MASK = "••••••";
type IField = [string, string, "text" | "password" | "number" | "textarea"];
interface Group { id: string; title: string; note: string; fields: IField[]; urls?: [string, string][]; extra?: string }
const GROUPS: Group[] = [
  { id: "brand", title: "Branding", note: "Shown in the app header, on proposals and invoices, and on the client portal. Set this once per agency.", fields: [["agency_name", "Agency name", "text"], ["agency_logo_url", "Logo URL", "text"], ["display_currency", "Leaderboard display currency", "text"], ["agency_address", "Address (on documents)", "textarea"], ["agency_bank_details", "Bank details (on invoices)", "textarea"], ["invoice_prefix", "Invoice number prefix", "text"], ["proposal_prefix", "Proposal number prefix", "text"], ["tax_rate", "Default tax rate (%)", "number"]] },
  { id: "smtp", title: "Email alerts via SMTP", note: "Any mailbox with SMTP works (Google Workspace, Zoho, Outlook). Use an app password, not the account password. Alerts go to each person who has email alerts on in their profile.", fields: [["smtp_host", "SMTP host", "text"], ["smtp_port", "SMTP port (587 or 465)", "number"], ["smtp_user", "SMTP username", "text"], ["smtp_pass", "SMTP password", "password"], ["smtp_from", "From address", "text"], ["owner_alert_email", "Owner alert email", "text"]] },
  { id: "wa", title: "WhatsApp alerts via Meta Cloud API", note: "From Meta for Developers: create a WhatsApp Business app, copy the permanent access token and the phone number ID. Recipients must have messaged the number in the last 24 hours, or a template is needed.", fields: [["whatsapp_token", "Access token", "password"], ["whatsapp_phone_id", "Phone number ID", "text"]] },
  { id: "rem", title: "Reminders", note: "The morning digest and the end-of-day reminder are sent at these hours, Pakistan time.", fields: [["reminder_morning_hour", "Morning digest hour (0–23)", "number"], ["reminder_eod_hour", "End-of-day reminder hour (0–23)", "number"]] },
  { id: "cal", title: "Calendly", note: "In Calendly → Integrations → Webhooks, add the URL below for the events invitee.created and invitee.canceled. Paste the signing key here. Bookings are matched to prospects by the invitee's email and credited to the prospect's owner; unknown invitees land in the Unassigned pool.", fields: [["calendly_signing_key", "Webhook signing key", "password"]], urls: [["Webhook URL", "/api/webhooks/calendly"]] },
  { id: "meta", title: "Meta Lead Ads", note: "In the Meta app dashboard, add the Webhooks product, subscribe the Page to leadgen with the callback URL below and the verify token you choose here. The page access token is used to fetch each lead's form fields. Leads land in the Unassigned pool with the ad set name as campaign tag.", fields: [["meta_verify_token", "Verify token (you choose it)", "text"], ["meta_page_token", "Page access token", "password"], ["meta_app_secret", "App secret (signature check)", "password"]], urls: [["Callback URL", "/api/webhooks/meta"]] },
  { id: "google", title: "Google Ads lead forms", note: "In the lead form asset, set the webhook URL below and the key you choose here. Leads land in the Unassigned pool with the campaign ID as campaign tag.", fields: [["google_lead_key", "Webhook key (you choose it)", "password"]], urls: [["Webhook URL", "/api/webhooks/google"]] },
  { id: "chatflow", title: "ChatFlow / WhatsApp conversations", note: "Point ChatFlow (or any WhatsApp tool) at the URL below with the key you choose. Outbound messages are logged as activities for the agent; inbound replies become notes, move Contacted → Replied and alert the owner. Unknown numbers become Unassigned leads.", fields: [["chatflow_key", "Webhook key (you choose it)", "password"]], urls: [["Webhook URL", "/api/webhooks/chatflow"]], extra: 'POST JSON body: {"key": "...", "phone": "+92...", "direction": "in" | "out", "text": "...", "agent_email": "optional", "timestamp": "optional ISO", "id": "optional unique id"}' },
  { id: "imap", title: "Email capture via IMAP", note: "Agents BCC this mailbox on outreach; replies from prospects to it are captured too. Polled every 10 minutes. Use an app password.", fields: [["imap_host", "IMAP host", "text"], ["imap_user", "IMAP username", "text"], ["imap_pass", "IMAP password", "password"]] },
];
function copy(text: string) { try { void navigator.clipboard.writeText(text); } catch { /* ignore */ } }

function Integrations({ owner }: { owner: boolean }) {
  const q = useAsync(() => get("/settings"), []);
  const settings = (q.data ?? {}) as Record<string, string>;
  return (
    <div>
      {!owner && <div className="info">Read-only for managers. Secrets are hidden.</div>}
      <Err e={q.error} />
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", alignItems: "start" }}>
        {GROUPS.map(g => <IntegrationCard key={g.id} group={g} settings={settings} owner={owner} onSaved={q.reload} />)}
      </div>
    </div>
  );
}

function IntegrationCard({ group, settings, owner, onSaved }: { group: Group; settings: Record<string, string>; owner: boolean; onSaved: () => void }) {
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const vals = f ?? settings;
  const origin = typeof location !== "undefined" ? location.origin : "";
  async function save() {
    if (!f) return;
    setErr(null); setMsg(""); setBusy(true);
    try {
      const body: Record<string, string> = {};
      for (const [k] of group.fields) if (f[k] !== undefined && f[k] !== MASK) body[k] = f[k];
      await api("PUT", "/settings", body); setMsg("Saved."); setF(null); onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="card">
      <h2>{group.title}</h2>
      <p className="small muted">{group.note}</p>
      {group.urls?.map(([l, path]) => (
        <Field key={path} label={l}>
          <div className="row" style={{ flexWrap: "nowrap" }}><input readOnly value={origin + path} /><button className="btn sm muted" onClick={() => copy(origin + path)}>Copy</button></div>
        </Field>
      ))}
      {group.extra && <pre className="small" style={{ whiteSpace: "pre-wrap", background: "#f3f4f6", padding: 8, borderRadius: 8 }}>{group.extra}</pre>}
      {group.fields.map(([k, l, t]) => (
        <Field key={k} label={l}>
          {t === "textarea"
            ? <textarea value={vals[k] ?? ""} disabled={!owner} onChange={e => setF({ ...vals, [k]: e.target.value })} />
            : <input type={t} value={vals[k] ?? ""} disabled={!owner} placeholder={t === "password" ? "not set" : ""} onChange={e => setF({ ...vals, [k]: e.target.value })} autoComplete="off" />}
        </Field>
      ))}
      <Err e={err} />{msg && <div className="info">{msg}</div>}
      {owner && <button className="btn" disabled={!f || busy} onClick={save}>Save</button>}
    </div>
  );
}

/* ---------------- Custom leaderboards ---------------- */
function Leaderboards({ owner }: { owner: boolean }) {
  const q = useAsync(() => get("/leaderboard/custom"), []);
  const [name, setName] = useState(""); const [metric, setMetric] = useState("deals_closed");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const metrics: string[] = q.data?.metrics ?? Object.keys(METRIC_LABEL);
  async function add() {
    setErr(null); setBusy(true);
    try { await post("/leaderboard/custom", { name, metric }); setName(""); q.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function toggle(b: any) { setErr(null); try { await patch(`/leaderboard/custom/${b.id}`, { active: !b.active }); q.reload(); } catch (e) { setErr(e); } }
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", alignItems: "start" }}>
      <div className="card">
        <h2>Custom boards</h2>
        <p className="small muted">Meetings and Commission are always on. Add a third board on any number the CRM already tracks. Boards appear for every agent immediately; names and totals only.</p>
        <Err e={q.error || err} />
        {(q.data?.boards ?? []).length === 0 ? <Empty text="No custom boards yet" /> : (
          <ul className="list">{(q.data?.boards as any[]).map(b => (
            <li key={b.id}><div className="main"><div className="title">{b.name}</div><div className="sub">{METRIC_LABEL[b.metric] ?? b.metric}</div></div>
              <div className="row"><span className={`chip ${b.active ? "ok" : "grey"}`}>{b.active ? "active" : "off"}</span>{owner && <button className="btn sm muted" onClick={() => toggle(b)}>{b.active ? "Deactivate" : "Activate"}</button>}</div></li>
          ))}</ul>
        )}
      </div>
      {owner && (
        <div className="card">
          <h2>New board</h2>
          <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Deals closed" /></Field>
          <Field label="Ranks by"><Select value={metric} onChange={setMetric} options={metrics.map(m => ({ value: m, label: METRIC_LABEL[m] ?? m }))} /></Field>
          <button className="btn" disabled={busy || !name.trim()} onClick={add}>Add board</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Import ---------------- */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}
const FIELDS = ["company", "contact_name", "email", "phone", "website", "country", "source", "service_interest", "campaign_tag", "owner_email"];
const ALIASES: Record<string, string> = { name: "contact_name", contact: "contact_name", "contact name": "contact_name", "company name": "company", organisation: "company", organization: "company", mail: "email", "e-mail": "email", mobile: "phone", whatsapp: "phone", url: "website", site: "website", domain: "website", service: "service_interest", interest: "service_interest", campaign: "campaign_tag", tag: "campaign_tag", owner: "owner_email", agent: "owner_email", "agent email": "owner_email" };
const SOURCES = ["cold_email", "linkedin", "upwork", "fiverr", "referral", "inbound", "instagram", "other"];
const SERVICES = ["web_shopify", "seo_aeo_geo", "performance_marketing", "social_media", "marketplace", "video", "staff_augmentation", "other"];

function Import() {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [defSource, setDefSource] = useState("cold_email"); const [defService, setDefService] = useState("other");
  const [result, setResult] = useState<any | null>(null);
  const [force, setForce] = useState<number[]>([]);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);

  function parse(t: string) {
    setText(t); setResult(null); setForce([]);
    const parsed = parseCsv(t);
    if (parsed.length < 2) { setRows([]); setHeaders([]); return; }
    const hdr = parsed[0].map(h => { const k = h.trim().toLowerCase(); return FIELDS.includes(k) ? k : ALIASES[k] ?? ""; });
    setHeaders(hdr);
    setRows(parsed.slice(1).map(r => { const o: Record<string, string> = {}; hdr.forEach((h, i) => { if (h && r[i]?.trim()) o[h] = r[i].trim(); }); return o; }).filter(o => o.company));
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const fr = new FileReader(); fr.onload = () => parse(String(fr.result ?? "")); fr.readAsText(file);
  }
  async function send(forceIds?: number[]) {
    setErr(null); setBusy(true);
    try {
      const payload = { rows: rows.map(r => ({ ...r, contact_name: r.contact_name || "Unknown" })), default_source: defSource, default_service: defService, force_ids: forceIds };
      const r = await post("/reports/import", payload);
      if (forceIds) setResult({ ...result, imported: (result?.imported ?? 0) + r.imported, duplicates: r.duplicates.filter((d: any) => !forceIds.includes(d.row)) , forced: true });
      else setResult(r);
      setForce([]);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  const mapped = headers.filter(Boolean);
  return (
    <div>
      <div className="card">
        <h2>Import leads from a sheet</h2>
        <p className="small muted">Export your Google Sheet as CSV and choose it here, or paste CSV text. Recognised columns: {FIELDS.join(", ")}. Rows matching an existing prospect (email, phone or website) are flagged as duplicates and not imported unless you tick them. Rows without owner_email land in the Unassigned pool.</p>
        <div className="form-grid">
          <Field label="CSV file"><input type="file" accept=".csv,text/csv" onChange={onFile} /></Field>
          <Field label="Default source"><Select value={defSource} onChange={setDefSource} options={SOURCES} labelFn={label} /></Field>
          <Field label="Default service"><Select value={defService} onChange={setDefService} options={SERVICES} labelFn={label} /></Field>
        </div>
        <Field label="Or paste CSV"><textarea value={text} onChange={e => parse(e.target.value)} placeholder={"company,contact_name,email,phone,website,source,campaign_tag,owner_email\nAcme,Jo,jo@acme.com,+92300...,acme.com,cold_email,Oct seq,haider@tdm.services"} /></Field>
        {rows.length > 0 && <div className="small">Found <b>{rows.length}</b> rows. Mapped columns: {mapped.join(", ") || "none"}{headers.some(h => !h) && <span className="muted"> (unrecognised columns ignored)</span>}</div>}
      </div>
      {rows.length > 0 && !result && (
        <div className="card table-wrap">
          <h2>Preview (first 10)</h2>
          <table><thead><tr>{mapped.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.slice(0, 10).map((r, i) => <tr key={i}>{mapped.map(h => <td key={h}>{r[h] ?? ""}</td>)}</tr>)}</tbody></table>
          <Err e={err} />
          <button className="btn" disabled={busy} onClick={() => send()}>{busy ? "Importing…" : `Import ${rows.length} rows`}</button>
        </div>
      )}
      {result && (
        <div className="card ok">
          <h2>Imported {result.imported} leads</h2>
          <Err e={err} />
          {result.duplicates.length > 0 && (
            <div>
              <h3>{result.duplicates.length} duplicates not imported</h3>
              <ul className="list">{result.duplicates.map((d: any) => (
                <li key={d.row}>
                  <div className="main"><div className="title">{d.company}</div><div className="sub">Matches <Link to={`/prospects/${d.existing.id}`}>{d.existing.company}</Link> owned by {d.existing.owner_name} (added {fmtDateTime(d.existing.created_at)}, on {d.existing.matched_on.join(", ")})</div></div>
                  <label className="small row"><input type="checkbox" style={{ width: "auto" }} checked={force.includes(d.row)} onChange={e => setForce(e.target.checked ? [...force, d.row] : force.filter(x => x !== d.row))} /> Import anyway</label>
                </li>
              ))}</ul>
              <button className="btn" disabled={busy || force.length === 0} onClick={() => send(force)}>Import {force.length} ticked rows</button>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>Assign imported leads on the <Link to="/admin?tab=unassigned">Unassigned</Link> tab.</p>
        </div>
      )}
    </div>
  );
}

/* ---------------- Unassigned ---------------- */
function Unassigned() {
  const q = useAsync(() => get("/prospects?unassigned=1"), []);
  const users = useAsync(() => get("/users"), []);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const agents = ((users.data ?? []) as any[]).filter(u => u.active && u.role === "agent");
  async function assign(id: number) { setErr(null); try { await post(`/prospects/${id}/assign`, { owner_id: Number(pick[id]) }); q.reload(); } catch (e) { setErr(e); } }
  return (
    <div className="card">
      <h2>Unassigned pool</h2>
      <p className="small muted">Imported and inbound leads. Only Abdul and Adnan see them; an agent sees a lead once it is assigned.</p>
      <Err e={err || q.error} />
      {((q.data ?? []) as any[]).length === 0 ? <Empty text="Pool is empty" /> : (
        <ul className="list">{(q.data as any[]).map(p => (
          <li key={p.id}>
            <div className="main"><div className="title"><Link to={`/prospects/${p.id}`}>{p.company}</Link></div><div className="sub">{p.contact_name} · {p.email ?? p.phone ?? "—"} · {label(p.source)} · {label(p.service_interest)}{p.campaign_tag && ` · ${p.campaign_tag}`}</div></div>
            <div className="row" style={{ gap: 4 }}>
              <select value={pick[p.id] ?? ""} onChange={e => setPick({ ...pick, [p.id]: e.target.value })} style={{ width: "auto" }}><option value="">Agent…</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
              <button className="btn sm" disabled={!pick[p.id]} onClick={() => assign(p.id)}>Assign</button>
            </div>
          </li>
        ))}</ul>
      )}
    </div>
  );
}

/* ---------------- Reassign ---------------- */
function Reassign({ owner }: { owner: boolean }) {
  const users = useAsync(() => get("/users"), []);
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [deactivate, setDeactivate] = useState(false);
  const [confirm, setConfirm] = useState(false); const [res, setRes] = useState<any | null>(null); const [err, setErr] = useState<unknown>(null);
  const all = (users.data ?? []) as any[];
  const name = (id: string) => all.find(u => String(u.id) === id)?.name ?? "";
  async function go() { setErr(null); try { const r = await post("/reports/reassign", { from_user_id: Number(from), to_user_id: Number(to), deactivate: owner && deactivate }); setRes(r); setConfirm(false); } catch (e) { setErr(e); } }
  return (
    <div className="card">
      <h2>Reassign everything from one person to another</h2>
      <p className="small muted">For when someone leaves or changes territory. All their open prospects and open tasks move. Their Pending commission is frozen until Abdul decides per deal on the Payouts page. Paid entries are untouched.</p>
      <div className="form-grid">
        <Field label="From"><Select value={from} onChange={setFrom} allowEmpty="Pick a person" options={all.map(u => ({ value: String(u.id), label: `${u.name}${u.active ? "" : " (inactive)"}` }))} /></Field>
        <Field label="To"><Select value={to} onChange={setTo} allowEmpty="Pick a person" options={all.filter(u => u.active && String(u.id) !== from).map(u => ({ value: String(u.id), label: u.name }))} /></Field>
      </div>
      {owner && <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" style={{ width: "auto" }} checked={deactivate} onChange={e => setDeactivate(e.target.checked)} /> Also deactivate {name(from) || "this person"}'s login</label>}
      <Err e={err} />
      {res && <div className="info">Moved {res.moved} open prospects from {name(from)} to {name(to)}. Pending commission frozen: see <Link to="/payouts">Payouts</Link>.</div>}
      <button className="btn danger" disabled={!from || !to} onClick={() => setConfirm(true)}>Reassign</button>
      {confirm && (
        <Modal title="Confirm reassignment" onClose={() => setConfirm(false)}>
          <p>Move every open prospect and open task from <b>{name(from)}</b> to <b>{name(to)}</b>{deactivate && owner ? ` and deactivate ${name(from)}` : ""}? Pending commission for {name(from)} will be frozen for Abdul to decide. This is logged on every record.</p>
          <button className="btn danger" onClick={go}>Yes, reassign</button>
        </Modal>
      )}
    </div>
  );
}
