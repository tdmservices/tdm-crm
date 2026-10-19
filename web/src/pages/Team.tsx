import { useState } from "react";
import { get, post, patch, cachedGet, usd, label, fmtDate, fmtDateTime, type User } from "../lib/api";
import { useAsync, Err, Empty, Modal, Field, Link, Stat } from "../lib/ui";

export function TeamPage({ user }: { user: User }) {
  void user;
  const q = useAsync(() => cachedGet("team", "/today/team"), []);
  const [err, setErr] = useState<unknown>(null);
  const [decline, setDecline] = useState<any | null>(null);
  const [declineNote, setDeclineNote] = useState("");
  const [logMeeting, setLogMeeting] = useState(false);

  async function act(fn: () => Promise<unknown>) { setErr(null); try { await fn(); q.reload(); } catch (e) { setErr(e); } }

  if (q.error && !q.data) return <Err e={q.error} />;
  if (!q.data) return <Empty text="Loading…" />;
  const d: any = q.data.data;
  const people: any[] = d.people;
  const eodByDate: Record<string, any[]> = {};
  for (const e of d.eod_log as any[]) (eodByDate[e.report_date] ??= []).push(e);

  return (
    <div>
      <div className="row between"><h1>Team overview</h1><span className="small muted">{fmtDate(d.today)}{q.data.stale && " · showing saved copy"}</span></div>
      <Err e={err} />

      <div className="grid tight">
        <Stat v={d.approvals.length} l="Approvals waiting" tone={d.approvals.length ? "warn" : undefined} />
        <Stat v={d.partner_requests.length} l="Partner requests" tone={d.partner_requests.length ? "warn" : undefined} />
        <Stat v={<Link to="/pipeline?unassigned=1">{d.unassigned}</Link>} l="Unassigned leads" tone={d.unassigned ? "warn" : undefined} />
        <Stat v={d.overdue_all.length} l="Overdue follow-ups" tone={d.overdue_all.length ? "red" : undefined} />
        <Stat v={d.meetings_today.length} l="Meetings today" />
      </div>

      {d.approvals.length > 0 && (
        <div className="card warn">
          <h2>Closed won approvals</h2>
          <ul className="list">
            {d.approvals.map((a: any) => (
              <li key={a.prospect_id}>
                <div className="main"><div className="title"><Link to={`/prospects/${a.prospect_id}`}>{a.company}</Link> · {usd(a.deal_value_usd)}</div><div className="sub">{a.owner_name} · {a.payment_terms} · requested {fmtDateTime(a.closed_won_requested_at)}</div></div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm ok" onClick={() => act(() => post(`/prospects/${a.prospect_id}/approve`, { approve: true }))}>Approve</button>
                  <button className="btn sm danger" onClick={() => { setDecline(a); setDeclineNote(""); }}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.partner_requests.length > 0 && (
        <div className="card warn">
          <h2>Partner requests</h2>
          <ul className="list">
            {d.partner_requests.map((r: any) => (
              <li key={r.id}>
                <div className="main"><div className="title"><Link to={`/prospects/${r.prospect_id}`}>{r.company}</Link></div><div className="sub">{r.requester_name} wants to join · owner {r.owner_name ?? "unassigned"} · {fmtDateTime(r.created_at)}</div></div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm ok" onClick={() => act(() => post(`/prospects/${r.prospect_id}/partner-request/${r.id}`, { accept: true }))}>Accept</button>
                  <button className="btn sm muted" onClick={() => act(() => post(`/prospects/${r.prospect_id}/partner-request/${r.id}`, { accept: false }))}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="row between"><h2>Meetings today</h2><button className="btn sm" onClick={() => setLogMeeting(true)}>Log meeting</button></div>
        {d.meetings_today.length === 0 ? <Empty text="No meetings booked for today" /> : (
          <ul className="list">
            {d.meetings_today.map((m: any) => (
              <li key={m.id}>
                <div className="main"><div className="title">{fmtDateTime(m.scheduled_at)} · <Link to={`/prospects/${m.prospect_id}`}>{m.company}</Link></div><div className="sub">credited to {m.credited_name}{m.link && <> · <a href={m.link} target="_blank" rel="noreferrer">link</a></>}</div></div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm ok" onClick={() => act(() => patch(`/meetings/${m.id}`, { status: "held" }))}>Held</button>
                  <button className="btn sm danger" onClick={() => act(() => patch(`/meetings/${m.id}`, { status: "no_show" }))}>No-show</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card table-wrap">
        <h2>Per person</h2>
        <table>
          <thead><tr><th>Agent</th><th className="num">Today</th><th className="num">Week</th><th className="num">Open tasks</th><th className="num">Overdue tasks</th><th className="num">Overdue f/u</th><th className="num">&gt;2 days</th><th className="num">No date</th><th className="num">Booked</th><th className="num">Held</th><th className="num">No-show %</th><th>EOD</th><th>Last login</th></tr></thead>
          <tbody>
            {people.map(p => {
              const ns = p.meetings_booked_month + p.no_shows_month;
              return (
                <tr key={p.id}>
                  <td className="b">{p.name}</td>
                  <td className="num" style={p.activities_today < d.daily_min ? { color: "var(--danger)", fontWeight: 600 } : undefined}>{p.activities_today}<span className="small muted">/{d.daily_min}</span></td>
                  <td className="num">{p.activities_week}</td>
                  <td className="num">{p.open_tasks}</td>
                  <td className="num" style={p.overdue_tasks ? { color: "var(--danger)" } : undefined}>{p.overdue_tasks}</td>
                  <td className="num" style={p.overdue_follow_ups ? { color: "var(--danger)" } : undefined}>{p.overdue_follow_ups}</td>
                  <td className="num" style={p.overdue_2d ? { color: "var(--danger)", fontWeight: 600 } : undefined}>{p.overdue_2d}</td>
                  <td className="num" style={p.no_date ? { color: "var(--warn)" } : undefined}>{p.no_date}</td>
                  <td className="num">{p.meetings_booked_month}</td>
                  <td className="num">{p.meetings_held_month}</td>
                  <td className="num">{ns ? `${Math.round(p.no_shows_month / ns * 100)}%` : "—"}</td>
                  <td>{p.eod_today ? "✓" : <span style={{ color: "var(--danger)" }}>✗</span>}{p.eod_gaps_week ? <span className="small muted"> ({p.eod_gaps_week} gaps)</span> : null}</td>
                  <td className="small">{fmtDateTime(p.last_login_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div className="card red">
          <h2>Overdue company-wide</h2>
          {d.overdue_all.length === 0 ? <Empty text="Nothing overdue" /> : (
            <ul className="list">{d.overdue_all.slice(0, 50).map((o: any, i: number) => (
              <li key={i}><div className="main"><div className="title"><Link to={`/prospects/${o.prospect_id}`}>{o.company}</Link></div><div className="sub">{o.owner_name ?? "unassigned"} · {label(o.stage)} · {label(o.kind)}</div></div><span className="chip red">{fmtDate(o.due_date)}</span></li>
            ))}</ul>
          )}
        </div>
        <div className="card">
          <h2>Proposals open by age</h2>
          {d.proposals.length === 0 ? <Empty text="No open proposals" /> : (
            <ul className="list">{d.proposals.map((p: any) => (
              <li key={p.prospect_id}><div className="main"><div className="title"><Link to={`/prospects/${p.prospect_id}`}>{p.company}</Link> · {usd(p.deal_value_usd)}</div><div className="sub">{p.owner_name} · sent {fmtDate(p.proposal_sent_at)}</div></div><span className={`chip ${p.age_days >= 5 ? "red" : "grey"}`}>{p.age_days}d</span></li>
            ))}</ul>
          )}
        </div>
        <div className="card">
          <h2>Delivery overdue</h2>
          {d.delivery_overdue.length === 0 ? <Empty text="None" /> : (
            <ul className="list">{d.delivery_overdue.map((p: any) => (
              <li key={p.prospect_id}><div className="main"><div className="title"><Link to={`/prospects/${p.prospect_id}`}>{p.company}</Link></div><div className="sub">{p.owner_name}</div></div><span className="chip red">due {fmtDate(p.expected_delivery_date)}</span></li>
            ))}</ul>
          )}
        </div>
        <div className="card">
          <h2>Unpaid retainers this month</h2>
          {d.unpaid_retainers.length === 0 ? <Empty text="All active retainers paid" /> : (
            <ul className="list">{d.unpaid_retainers.map((p: any) => (
              <li key={p.prospect_id}><div className="main"><div className="title"><Link to={`/prospects/${p.prospect_id}`}>{p.company}</Link></div><div className="sub">{p.owner_name}</div></div><span className="chip warn">unpaid</span></li>
            ))}</ul>
          )}
        </div>
        <div className="card">
          <h2>Pipeline</h2>
          <table><tbody>{d.pipeline.map((s: any) => <tr key={s.stage}><td>{label(s.stage)}</td><td className="num">{s.count}</td><td className="num">{usd(s.value_usd)}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h2>End of day reports (7 days)</h2>
          {Object.keys(eodByDate).length === 0 ? <Empty text="No reports yet" /> : Object.entries(eodByDate).map(([date, rows]) => (
            <div key={date} style={{ marginBottom: 8 }}>
              <div className="small b muted">{fmtDate(date)}</div>
              {rows.map((r: any) => <div key={r.id} className="small"><b>{r.name}:</b> {r.note}</div>)}
            </div>
          ))}
        </div>
      </div>

      {d.notifications.length > 0 && (
        <div className="card">
          <div className="row between"><h2>Notifications</h2><button className="btn sm muted" onClick={() => act(() => post("/today/notifications/read", {}))}>Mark all read</button></div>
          <ul className="list">{d.notifications.map((n: any) => (
            <li key={n.id}><div className="main"><div className="title">{n.prospect_id ? <Link to={`/prospects/${n.prospect_id}`}>{n.title}</Link> : n.title}</div><div className="sub">{n.body} · {fmtDateTime(n.created_at)}</div></div></li>
          ))}</ul>
        </div>
      )}

      {decline && (
        <Modal title={`Decline: ${decline.company}`} onClose={() => setDecline(null)}>
          <p className="small muted">The deal returns to Negotiation with your note.</p>
          <Field label="Note"><textarea value={declineNote} onChange={e => setDeclineNote(e.target.value)} /></Field>
          <button className="btn danger" onClick={() => act(async () => { await post(`/prospects/${decline.prospect_id}/approve`, { approve: false, note: declineNote || undefined }); setDecline(null); })}>Decline</button>
        </Modal>
      )}
      {logMeeting && <LogMeetingModal onClose={() => setLogMeeting(false)} onSaved={() => { setLogMeeting(false); q.reload(); }} />}
    </div>
  );
}

export function LogMeetingModal({ prospectId, onClose, onSaved }: { prospectId?: number; onClose: () => void; onSaved: () => void }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [picked, setPicked] = useState<any | null>(prospectId ? { id: prospectId } : null);
  const [when, setWhen] = useState("");
  const [link, setLink] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<unknown>(null);
  async function doSearch(s: string) {
    setSearch(s);
    if (s.length < 2) { setResults([]); return; }
    try { setResults(await get(`/prospects?search=${encodeURIComponent(s)}`)); } catch (e) { setErr(e); }
  }
  async function save() {
    setErr(null);
    try { await post("/meetings", { prospect_id: picked.id, scheduled_at: new Date(when).toISOString(), link: link || null, prep_notes: notes || null }); onSaved(); }
    catch (e) { setErr(e); }
  }
  return (
    <Modal title="Log meeting from Calendly" onClose={onClose}>
      {!prospectId && (
        <Field label="Prospect">
          {picked ? <div className="row between"><span className="b">{picked.company} · {picked.owner_name ?? "unassigned"}</span><button className="btn sm muted" onClick={() => setPicked(null)}>Change</button></div> : (
            <>
              <input value={search} onChange={e => doSearch(e.target.value)} placeholder="Search company, contact or email" />
              {results.length > 0 && <ul className="list">{results.slice(0, 8).map(r => <li key={r.id} onClick={() => setPicked(r)} style={{ cursor: "pointer" }}><div className="main"><div className="title">{r.company}</div><div className="sub">{r.contact_name} · {r.owner_name ?? "unassigned"} · {label(r.stage)}</div></div></li>)}</ul>}
            </>
          )}
        </Field>
      )}
      <Field label="Date and time (Pakistan time)"><input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></Field>
      <Field label="Meeting link"><input value={link} onChange={e => setLink(e.target.value)} placeholder="https://" /></Field>
      <Field label="Prep notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <p className="small muted">Credited to the prospect's owner. Counts on the meetings leaderboard.</p>
      <Err e={err} />
      <button className="btn" disabled={!picked || !when} onClick={save}>Save meeting</button>
    </Modal>
  );
}
