import { useState } from "react";
import { get, usd, label, fmtDate, todayPk, addDays, type User } from "../lib/api";
import { useAsync, Err, Empty, Tabs, Field, Select, Stat, Link } from "../lib/ui";
import { downloadCsv } from "./Payouts";

const SERVICES = ["web_shopify", "seo_aeo_geo", "performance_marketing", "social_media", "marketplace", "video", "staff_augmentation", "other"];
const SOURCES = ["cold_email", "linkedin", "upwork", "fiverr", "referral", "inbound", "instagram", "other"];
const TABS = [["pipeline", "Pipeline"], ["funnel", "Funnel"], ["revenue", "Revenue"], ["forecast", "Forecast"], ["team", "Team"], ["delivery", "Delivery"], ["lost", "Lost deals"], ["campaigns", "Campaigns"], ["activity", "Activity"]].map(([id, l]) => ({ id, label: l }));

const pct = (a: number, b: number) => b ? `${Math.round(a / b * 100)}%` : "—";

export function ReportsPage({ user }: { user: User }) {
  void user;
  const [tab, setTab] = useState("pipeline");
  const [f, setF] = useState({ owner_id: "", service: "", source: "", from: addDays(todayPk(), -90), to: todayPk(), campaign: "" });
  const [funnelBy, setFunnelBy] = useState("agent");
  const [err, setErr] = useState<unknown>(null);
  const users = useAsync(() => get("/users"), []);
  const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const path = tab === "funnel" ? `/reports/funnel?by=${funnelBy}&${qs}` : tab === "forecast" ? `/reports/pipeline?${qs}` : `/reports/${tab}?${qs}`;
  const q = useAsync(() => get(path), [path]);
  const funnelForForecast = useAsync(() => tab === "forecast" ? get(`/reports/funnel?by=agent&${qs}`) : Promise.resolve(null), [tab, qs]);
  async function exp(what: string) { setErr(null); try { await downloadCsv(what); } catch (e) { setErr(e); } }

  return (
    <div>
      <h1>Reports</h1>
      <div className="card">
        <div className="form-grid">
          <Field label="Agent"><Select value={f.owner_id} onChange={v => setF({ ...f, owner_id: v })} allowEmpty="All" options={((users.data ?? []) as any[]).filter(u => u.role === "agent").map(u => ({ value: String(u.id), label: u.name }))} /></Field>
          <Field label="Service"><Select value={f.service} onChange={v => setF({ ...f, service: v })} allowEmpty="All" options={SERVICES} labelFn={label} /></Field>
          <Field label="Source"><Select value={f.source} onChange={v => setF({ ...f, source: v })} allowEmpty="All" options={SOURCES} labelFn={label} /></Field>
          <Field label="From"><input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Campaign tag"><input value={f.campaign} onChange={e => setF({ ...f, campaign: e.target.value })} placeholder="exact tag" /></Field>
        </div>
        <div className="row small"><span className="muted">Export:</span>{["prospects", "commission", "payments", "activities", "tasks"].map(w => <button key={w} className="btn sm ghost" onClick={() => exp(w)}>{label(w)}</button>)}</div>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <Err e={err || q.error} />
      {q.loading && !q.data ? <Empty text="Loading…" /> : q.data && (
        <div>
          {tab === "pipeline" && <Pipeline d={q.data} />}
          {tab === "funnel" && <>
            <Tabs tabs={[{ id: "agent", label: "By agent" }, { id: "source", label: "By source" }]} value={funnelBy} onChange={setFunnelBy} />
            <Funnel rows={q.data} />
          </>}
          {tab === "revenue" && <Revenue d={q.data} />}
          {tab === "forecast" && <Forecast pipeline={q.data} funnel={funnelForForecast.data} />}
          {tab === "team" && <Team rows={q.data} />}
          {tab === "delivery" && <Delivery d={q.data} />}
          {tab === "lost" && <Simple rows={q.data} cols={[["lost_reason", "Reason", label], ["count", "Count"], ["value_usd", "Value", usd]]} />}
          {tab === "campaigns" && <Simple rows={q.data} cols={[["campaign", "Campaign"], ["leads", "Leads"], ["meetings", "Meetings"], ["won", "Won"], ["lost", "Lost"]]} />}
          {tab === "activity" && <Activity d={q.data} />}
        </div>
      )}
    </div>
  );
}

type Col = [string, string, ((v: any) => string)?];
function Simple({ rows, cols }: { rows: any[]; cols: Col[] }) {
  if (!rows?.length) return <div className="card"><Empty text="No data for these filters" /></div>;
  return (
    <div className="card table-wrap"><table>
      <thead><tr>{cols.map(c => <th key={c[0]} className={c[2] === usd || typeof rows[0]?.[c[0]] === "number" ? "num" : ""}>{c[1]}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c[0]} className={c[2] === usd || typeof r[c[0]] === "number" ? "num" : ""}>{c[2] ? c[2](r[c[0]]) : r[c[0]] ?? "—"}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

function Pipeline({ d }: { d: any }) {
  const prev: Record<string, any> = Object.fromEntries((d.previous_month_snapshot as any[]).map(p => [p.stage, p]));
  const total = (d.now as any[]).reduce((s, r) => s + r.value_usd, 0);
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>Stage</th><th className="num">Now</th><th className="num">Value</th><th className="num">Last month</th><th className="num">Value</th></tr></thead>
        <tbody>
          {(d.now as any[]).map(r => <tr key={r.stage}><td>{label(r.stage)}</td><td className="num b">{r.count}</td><td className="num">{usd(r.value_usd)}</td><td className="num muted">{prev[r.stage]?.count ?? 0}</td><td className="num muted">{usd(prev[r.stage]?.value_usd ?? 0)}</td></tr>)}
          <tr><td className="b">Total</td><td className="num b">{(d.now as any[]).reduce((s, r) => s + r.count, 0)}</td><td className="num b">{usd(total)}</td><td /><td /></tr>
        </tbody>
      </table>
      <p className="small muted">Last month column counts prospects that existed before this month, at their current stage.</p>
    </div>
  );
}

function Funnel({ rows }: { rows: any[] }) {
  if (!rows?.length) return <div className="card"><Empty text="No leads in range" /></div>;
  return (
    <div className="card table-wrap"><table>
      <thead><tr><th>Group</th><th className="num">Leads</th><th className="num">Contacted</th><th className="num">Replied</th><th className="num">Meeting</th><th className="num">Proposal</th><th className="num">Won</th><th className="num">Lost</th></tr></thead>
      <tbody>{rows.map(r => (
        <tr key={r.grp ?? "none"}>
          <td className="b">{r.grp ?? "Unassigned"}</td>
          <td className="num">{r.leads}</td>
          <td className="num">{r.contacted}<div className="small muted">{pct(r.contacted, r.leads)}</div></td>
          <td className="num">{r.replied}<div className="small muted">{pct(r.replied, r.contacted)}</div></td>
          <td className="num">{r.meeting}<div className="small muted">{pct(r.meeting, r.replied)}</div></td>
          <td className="num">{r.proposal}<div className="small muted">{pct(r.proposal, r.meeting)}</div></td>
          <td className="num">{r.won}<div className="small muted">{pct(r.won, r.proposal)}</div></td>
          <td className="num">{r.lost}</td>
        </tr>
      ))}</tbody>
    </table><p className="small muted">Percentages are conversion from the previous step.</p></div>
  );
}

function Revenue({ d }: { d: any }) {
  return (
    <div>
      <div className="grid tight">
        <Stat v={usd(d.expected_usd)} l="Expected (one-off deals won)" />
        <Stat v={usd(d.received_usd)} l="Received" tone="ok" />
        <Stat v={usd(d.outstanding.reduce((s: number, o: any) => s + o.balance_usd, 0))} l="Outstanding client balance" tone={d.outstanding.length ? "warn" : undefined} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", marginTop: 12 }}>
        <div><h3>By month</h3><Simple rows={d.by_month} cols={[["month", "Month"], ["deals", "Deals"], ["value_usd", "Value", usd]]} /></div>
        <div><h3>By service</h3><Simple rows={d.by_service} cols={[["service", "Service", label], ["deals", "Deals"], ["value_usd", "Value", usd]]} /></div>
        <div><h3>By agent</h3><Simple rows={d.by_agent} cols={[["agent", "Agent"], ["deals", "Deals"], ["value_usd", "Value", usd]]} /></div>
      </div>
      <h3>Outstanding balances</h3>
      {d.outstanding.length === 0 ? <div className="card"><Empty text="Nothing outstanding" /></div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Deal</th><th>Agent</th><th className="num">Value</th><th className="num">Received</th><th className="num">Balance</th></tr></thead>
          <tbody>{d.outstanding.map((o: any) => <tr key={o.id}><td><Link to={`/prospects/${o.id}`}>{o.company}</Link></td><td>{o.owner_name}</td><td className="num">{usd(o.deal_value_usd)}</td><td className="num">{usd(o.received_usd)}</td><td className="num b">{usd(o.balance_usd)}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}

function Forecast({ pipeline, funnel }: { pipeline: any; funnel: any[] | null }) {
  const stage = (s: string) => (pipeline.now as any[]).find(r => r.stage === s) ?? { count: 0, value_usd: 0 };
  const prop = stage("proposal_sent"), neg = stage("negotiation");
  const tot = (funnel ?? []).reduce((a, r) => ({ proposal: a.proposal + r.proposal, won: a.won + r.won }), { proposal: 0, won: 0 });
  const rate = tot.proposal ? tot.won / tot.proposal : 0;
  const negRate = Math.min(1, rate * 1.5);
  return (
    <div>
      <div className="grid tight">
        <Stat v={usd(prop.value_usd)} l={`In Proposal sent (${prop.count})`} />
        <Stat v={usd(neg.value_usd)} l={`In Negotiation (${neg.count})`} />
        <Stat v={usd(prop.value_usd * rate + neg.value_usd * negRate)} l="Weighted forecast" tone="ok" />
      </div>
      <div className="card small muted" style={{ marginTop: 12 }}>
        Assumption: proposal → won rate in the selected range is <b>{Math.round(rate * 100)}%</b> ({tot.won} won of {tot.proposal} proposals). Proposal sent is weighted at that rate; Negotiation at 1.5× it (capped at 100%, here {Math.round(negRate * 100)}%). Full forecast report is Phase 3.
      </div>
    </div>
  );
}

function Team({ rows }: { rows: any[] }) {
  return (
    <div className="card table-wrap"><table>
      <thead><tr><th>Agent</th><th className="num">Leads</th><th className="num">Activities</th><th className="num">Booked</th><th className="num">Held</th><th className="num">No-shows</th><th className="num">Closed</th><th className="num">Lost</th><th className="num">Close rate</th><th className="num">Avg deal</th><th className="num">Revenue</th><th className="num">Commission</th><th className="num">Overdue</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td className="b">{r.name}</td><td className="num">{r.leads_added}</td><td className="num">{r.activities}</td><td className="num">{r.meetings_booked}</td><td className="num">{r.meetings_held}</td><td className="num">{r.no_shows}</td><td className="num">{r.deals_closed}</td><td className="num">{r.deals_lost}</td><td className="num">{r.close_rate == null ? "—" : `${r.close_rate}%`}</td><td className="num">{usd(r.avg_deal_usd)}</td><td className="num">{usd(r.revenue_usd)}</td><td className="num">{usd(r.commission_earned)}</td><td className="num" style={r.overdue_items ? { color: "var(--danger)" } : undefined}>{r.overdue_items}</td></tr>)}</tbody>
    </table></div>
  );
}

function Delivery({ d }: { d: any }) {
  const L = ({ title, rows, extra }: { title: string; rows: any[]; extra: (r: any) => string }) => (
    <div className="card"><h2>{title}</h2>{rows.length === 0 ? <Empty text="None" /> : <ul className="list">{rows.map(r => <li key={r.id}><div className="main"><div className="title"><Link to={`/prospects/${r.id}`}>{r.company}</Link></div><div className="sub">{r.owner_name} · {extra(r)}</div></div>{r.deal_value_usd != null && <span className="b">{usd(r.deal_value_usd)}</span>}</li>)}</ul>}</div>
  );
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
      <L title="In delivery" rows={d.in_delivery} extra={r => `won ${fmtDate(r.closed_won_at)} · due ${fmtDate(r.expected_delivery_date)}`} />
      <L title="Delivered this month" rows={d.delivered_this_month} extra={r => `delivered ${fmtDate(r.delivered_at)}`} />
      <L title="Active retainers" rows={d.active_retainers} extra={r => `${r.payments_logged} payments · last ${fmtDate(r.last_payment)}`} />
      <L title="Retainers finished" rows={d.finished_retainers} extra={r => `finished ${fmtDate(r.retainer_finished_at)}`} />
    </div>
  );
}

function Activity({ d }: { d: any }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
      <div><h3>Activities by day</h3><Simple rows={d.by_day} cols={[["day", "Day", fmtDate], ["name", "Agent"], ["activities", "All"], ["outreach", "Outreach"]]} /></div>
      <div><h3>Logins</h3><Simple rows={d.logins} cols={[["day", "Day", fmtDate], ["name", "Person"], ["logins", "Logins"]]} /></div>
    </div>
  );
}
