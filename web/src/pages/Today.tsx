import { useState } from "react";
import { cachedGet, offlineWrite, post, patch, get, usd, usd2, pkr, label, fmtDate, fmtDateTime, todayPk, addDays, type User } from "../lib/api";
import { Modal, Field, Select, Err, Stat, Stage, Progress, useAsync, Link, nav } from "../lib/ui";
import { ColumnChart, Donut } from "../lib/charts";
import { AddProspectModal, AddClosedDealModal } from "./Pipeline";

const ACTIONS = ["emailed", "called", "messaged", "met", "no_answer"] as const;
const LOST = ["price", "no_response", "went_elsewhere", "bad_fit", "timing"] as const;

/** Log an outreach action on a prospect, set the next follow-up, or decide on a cold prospect. */
export function LogActionModal({ prospect, onClose, onDone }: { prospect: { id: number; company: string; is_cold?: number | boolean }; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<string>("emailed");
  const [detail, setDetail] = useState("");
  const [next, setNext] = useState(addDays(todayPk(), 3));
  const [mode, setMode] = useState<"log" | "lost">("log");
  const [lost, setLost] = useState<string>("no_response");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [queued, setQueued] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try {
      if (mode === "lost") { await post(`/prospects/${prospect.id}/stage`, { stage: "closed_lost", lost_reason: lost, note: detail || undefined }); }
      else { const r = await offlineWrite("POST", `/prospects/${prospect.id}/activities`, { type, detail: detail || undefined, next_follow_up: next || null }); if ((r as any)?.queued) setQueued(true); }
      onDone(); if (!queued) onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function keepChasing() {
    setBusy(true); setErr(null);
    try { await post(`/prospects/${prospect.id}/keep-chasing`, { next_follow_up: next }); onDone(); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Log action · ${prospect.company}`} onClose={onClose}>
      {prospect.is_cold ? <div className="info">No reply after 14 days. Keep chasing with a new date, or mark lost.</div> : null}
      {queued && <div className="info">Saved on this device. It will sync when you are back online.</div>}
      <div className="tabs"><button className={mode === "log" ? "active" : ""} onClick={() => setMode("log")}>Log action</button><button className={mode === "lost" ? "active" : ""} onClick={() => setMode("lost")}>Mark lost</button></div>
      {mode === "log" ? (
        <>
          <div className="row" style={{ marginBottom: 10 }}>{ACTIONS.map(a => <button key={a} className={`btn sm ${type === a ? "" : "muted"}`} onClick={() => setType(a)}>{label(a)}</button>)}</div>
          <Field label="Detail (optional)"><input value={detail} onChange={e => setDetail(e.target.value)} placeholder="What was said, what is next" /></Field>
          <Field label="Next follow-up date" hint="Required until the deal closes"><input type="date" value={next} onChange={e => setNext(e.target.value)} /></Field>
          <Err e={err} />
          <div className="row">
            <button className="btn" disabled={busy || !next} onClick={save}>Save</button>
            {prospect.is_cold ? <button className="btn ghost" disabled={busy || !next} onClick={keepChasing}>Keep chasing only</button> : null}
          </div>
        </>
      ) : (
        <>
          <Field label="Lost reason"><Select value={lost} onChange={setLost} options={LOST} labelFn={label} /></Field>
          <Field label="Note (optional)"><input value={detail} onChange={e => setDetail(e.target.value)} /></Field>
          <Err e={err} />
          <button className="btn danger" disabled={busy} onClick={save}>Mark lost</button>
        </>
      )}
    </Modal>
  );
}

export function TaskDoneModal({ task, mode, onClose, onDone }: { task: { id: number; title: string }; mode: "done" | "blocked"; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(""); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(null);
    try { await offlineWrite("PATCH", `/tasks/${task.id}`, mode === "done" ? { status: "done", completion_note: note } : { status: "blocked", blocked_reason: note }); onDone(); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title={mode === "done" ? `Done · ${task.title}` : `Blocked · ${task.title}`} onClose={onClose}>
      <Field label={mode === "done" ? "What was done" : "Why is it blocked"} hint="Required"><textarea value={note} onChange={e => setNote(e.target.value)} autoFocus /></Field>
      <Err e={err} />
      <button className={`btn ${mode === "done" ? "ok" : "danger"}`} disabled={busy || !note.trim()} onClick={save}>{mode === "done" ? "Mark done" : "Mark blocked"}</button>
    </Modal>
  );
}

function ProspectRow({ p, sub, onLog }: { p: any; sub: string; onLog: (p: any) => void }) {
  return (
    <li>
      <div className="main"><Link to={`/prospects/${p.prospect_id}`}><span className="title">{p.company}</span></Link>{p.contact_name ? <span className="muted"> · {p.contact_name}</span> : null}<div className="sub">{sub} {p.stage && <Stage s={p.stage} />}{p.is_cold ? <span className="chip warn" style={{ marginLeft: 6 }}>Cold</span> : null}</div></div>
      <button className="btn sm" onClick={() => onLog({ id: p.prospect_id, company: p.company, is_cold: p.is_cold })}>Log</button>
    </li>
  );
}

export function TodayPage({ user }: { user: User }) {
  const { data, error, loading, reload } = useAsync(() => cachedGet("today", "/today"), []);
  const [logFor, setLogFor] = useState<any>(null);
  const [taskModal, setTaskModal] = useState<{ task: any; mode: "done" | "blocked" } | null>(null);
  const [eod, setEod] = useState(""); const [eodErr, setEodErr] = useState<unknown>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [addProspect, setAddProspect] = useState(false);
  const [addClosed, setAddClosed] = useState(false);
  if (loading && !data) return <div className="center">Loading your day…</div>;
  if (error && !data) return <Err e={error} />;
  const t = data!.data; const stale = data!.stale;
  const ov = t.overdue; const overdueCount = ov.follow_ups.length + ov.no_date.length + ov.tasks.length + ov.chases.length + ov.delivery.length;
  const n = t.numbers;
  async function submitEod() { setEodErr(null); try { await post("/today/eod", { note: eod }); reload(); } catch (e) { setEodErr(e); } }
  async function markRead() { await post("/today/notifications/read", {}); reload(); }
  const targetFor = (metric: string, period: "week" | "month") => t.targets.cards.find((c: any) => c.metric === metric && c.period === period);
  const numRow = (lbl: string, key: string, metric?: string, money?: boolean) => {
    const fmt = (v: number) => money ? usd(v) : v;
    const tw = metric ? targetFor(metric, "week") : null, tm = metric ? targetFor(metric, "month") : null;
    return <tr key={key}><td>{lbl}</td><td className="num">{fmt(n.week[key])}{tw ? <span className="muted small"> / {tw.number} · {Math.max(0, tw.number - n.week[key])} to go</span> : null}</td><td className="num">{fmt(n.month[key])}{tm ? <span className="muted small"> / {tm.number} · {Math.max(0, tm.number - n.month[key])} to go</span> : null}</td></tr>;
  };
  const totalProspects = (t.pipeline as any[]).reduce((s: number, x: any) => s + x.count, 0);
  const weekTarget = (metric: string) => t.targets.cards.find((c: any) => c.metric === metric && c.period === "week")?.number ?? 0;
  const weekSeries = [
    { label: "Done this week", values: [n.week.activities, n.week.meetings_booked, n.week.leads_added] },
    { label: "Weekly target", values: [weekTarget("activities"), weekTarget("meetings_booked"), weekTarget("leads_added")], color: "var(--line)" },
  ];
  const hasWeekTargets = weekSeries[1].values.some(v => v > 0);
  const stageColor: Record<string, string> = { new_lead: "#9ca3af", contacted: "#0891b2", replied: "#2563eb", meeting_booked: "#7c3aed", meeting_held: "#db2777", proposal_sent: "#d97706", negotiation: "#ea580c", closed_won: "#16a34a", closed_lost: "#dc2626" };
  const donutParts = (t.pipeline as any[]).map((x: any) => ({ label: label(x.stage), value: x.count, color: stageColor[x.stage] }));
  const dueTodayCount = t.due_today.follow_ups.length + t.due_today.tasks.length + t.due_today.meetings.length;
  return (
    <div>
      <div className="row between"><h1>Today · {fmtDate(t.today)}</h1><span className="muted small">{user.name}</span></div>
      {stale && <div className="info">Offline: showing the last saved copy of your day.</div>}

      <div className="kpi-strip">
        <div className={`kpi ${n.activities_today >= n.daily_min ? "ok" : "warn"}`}>
          <div className="v">{n.activities_today} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>/ {n.daily_min}</span></div>
          <div className="l">Outreach today</div>
          <div style={{ marginTop: 6 }}><Progress done={n.activities_today} total={n.daily_min} won={n.activities_today >= n.daily_min} /></div>
        </div>
        <div className={`kpi ${overdueCount ? "red" : ""}`}><div className="v">{dueTodayCount}</div><div className="l">Due today</div><div className="sub">{overdueCount ? `${overdueCount} overdue` : "Nothing overdue"}</div></div>
        <div className="kpi"><div className="v">{t.meetings_week.length}</div><div className="l">Meetings this week</div><div className="sub">{n.month.meetings_booked} booked this month</div></div>
        <div className="kpi ok"><div className="v">{usd2(n.commission_due)}</div><div className="l">Commission due to me</div><div className="sub">{usd(n.month.commission_earned)} earned this month</div></div>
      </div>

      {totalProspects === 0 && (
        <div className="card ok getting-started">
          <h2>Getting started</h2>
          <p className="small muted">Your pipeline is empty. Five steps and the CRM starts working for you:</p>
          <ol>
            <li><a onClick={() => setAddProspect(true)}>Add your first prospect</a>. Every prospect you are working on, even if you only emailed once.</li>
            <li><a onClick={() => setAddClosed(true)}>Add the deals you have already closed</a> with their closing date, so your commission history is right.</li>
            <li>Log every call, email and message on the prospect. Logging is what counts towards targets and the leaderboard.</li>
            <li>Always set the next follow-up date. The Today view is built from those dates.</li>
            <li>Send a one-line end-of-day report before you stop, from the bottom of this page.</li>
          </ol>
        </div>
      )}

      {totalProspects > 0 && (
        <div className="charts-row">
          <div className="card">
            <h3>My week{hasWeekTargets ? " vs target" : ""}</h3>
            <ColumnChart series={hasWeekTargets ? weekSeries : [weekSeries[0]]} categories={["Outreach", "Meetings", "Leads added"]} />
            {!hasWeekTargets && <div className="small muted">Abdul has not set weekly targets yet.</div>}
          </div>
          <div className="card"><h3>My pipeline by stage</h3><Donut parts={donutParts} /></div>
        </div>
      )}
      {t.notifications.length > 0 && (
        <div className="card">
          <div className="row between"><h3>New</h3><button className="btn sm muted" onClick={markRead}>Mark all read</button></div>
          <ul className="list">{t.notifications.map((x: any) => <li key={x.id}><div className="main"><div className="title">{x.title}</div><div className="sub">{x.body} · {fmtDateTime(x.created_at)}</div></div>{x.prospect_id && <Link to={`/prospects/${x.prospect_id}`} className="btn sm ghost">Open</Link>}</li>)}</ul>
        </div>
      )}
      <div className={`card ${overdueCount ? "red" : "ok"}`}>
        <h3>Overdue {overdueCount ? `(${overdueCount})` : ""}</h3>
        {overdueCount === 0 ? <div className="muted">Nothing overdue. Keep it that way.</div> : (
          <ul className="list">
            {ov.follow_ups.map((f: any) => <ProspectRow key={`f${f.follow_up_id}`} p={f} sub={`Follow-up due ${fmtDate(f.due_date)} · ${label(f.kind)}`} onLog={setLogFor} />)}
            {ov.no_date.map((p: any) => <ProspectRow key={`n${p.prospect_id}`} p={p} sub="No next follow-up date set" onLog={setLogFor} />)}
            {ov.chases.map((c: any) => <ProspectRow key={`c${c.prospect_id}`} p={{ ...c, stage: "proposal_sent" }} sub={`Proposal sent ${fmtDate(c.proposal_sent_at)} · ${usd(c.deal_value_usd)} · chase it`} onLog={setLogFor} />)}
            {ov.delivery.map((d: any) => <li key={`d${d.prospect_id}`}><div className="main"><Link to={`/prospects/${d.prospect_id}`}><span className="title">{d.company}</span></Link><div className="sub">In delivery past {fmtDate(d.expected_delivery_date)}. Mark delivered or update the date.</div></div></li>)}
            {ov.tasks.map((k: any) => <li key={`t${k.id}`}><div className="main"><div className="title">{k.title}</div><div className="sub">Task due {fmtDate(k.due_date)}{k.company ? ` · ${k.company}` : ""} · <span className={`chip ${k.priority === "high" ? "red" : "grey"}`}>{k.priority}</span></div></div><button className="btn sm ok" onClick={() => setTaskModal({ task: k, mode: "done" })}>Done</button></li>)}
          </ul>
        )}
      </div>
      <div className="card">
        <h3>Due today</h3>
        {t.due_today.follow_ups.length + t.due_today.tasks.length + t.due_today.meetings.length === 0 ? <div className="muted">Nothing due today.</div> : (
          <ul className="list">
            {t.due_today.meetings.map((m: any) => <li key={`m${m.id}`}><div className="main"><Link to={`/prospects/${m.prospect_id}`}><span className="title">{m.company}</span></Link><div className="sub">Meeting {fmtDateTime(m.scheduled_at)} {m.link && <a href={m.link} target="_blank" rel="noreferrer">Join</a>}</div></div></li>)}
            {t.due_today.follow_ups.map((f: any) => <ProspectRow key={`f${f.follow_up_id}`} p={f} sub={`Follow-up · ${label(f.kind)}`} onLog={setLogFor} />)}
            {t.due_today.tasks.map((k: any) => <li key={`t${k.id}`}><div className="main"><div className="title">{k.title}</div><div className="sub">{k.company ?? "Task"} · {k.priority}</div></div><button className="btn sm ok" onClick={() => setTaskModal({ task: k, mode: "done" })}>Done</button></li>)}
          </ul>
        )}
      </div>
      {t.pending_approval.length > 0 && <div className="card warn"><h3>Waiting for approval</h3><ul className="list">{t.pending_approval.map((p: any) => <li key={p.prospect_id}><div className="main"><Link to={`/prospects/${p.prospect_id}`}><span className="title">{p.company}</span></Link><div className="sub">Closed won {usd(p.deal_value_usd)} · pending Abdul or Adnan</div></div></li>)}</ul></div>}
      <div className="card">
        <h3>Meetings this week</h3>
        {t.meetings_week.length === 0 ? <div className="muted">No meetings booked this week.</div> : <ul className="list">{t.meetings_week.map((m: any) => <li key={m.id}><div className="main"><Link to={`/prospects/${m.prospect_id}`}><span className="title">{m.company}</span></Link><span className="muted"> · {m.contact_name}</span><div className="sub">{fmtDateTime(m.scheduled_at)}{m.prep_notes ? ` · ${m.prep_notes}` : ""}</div></div>{m.link && <a className="btn sm ghost" href={m.link} target="_blank" rel="noreferrer">Join</a>}</li>)}</ul>}
      </div>
      <div className="card">
        <div className="row between"><h3>Tasks assigned to me</h3><Link to="/tasks" className="small">All tasks</Link></div>
        {t.tasks.length === 0 ? <div className="muted">No open tasks.</div> : <ul className="list">{t.tasks.slice(0, 8).map((k: any) => <li key={k.id}><div className="main"><div className="title">{k.title}</div><div className="sub">Due {fmtDate(k.due_date)} · from {k.assigned_by_name}{k.company ? ` · ${k.company}` : ""} · <span className={`chip ${k.status === "blocked" ? "red" : "grey"}`}>{label(k.status)}</span></div></div><div className="row"><button className="btn sm ok" onClick={() => setTaskModal({ task: k, mode: "done" })}>Done</button><button className="btn sm muted" onClick={() => setTaskModal({ task: k, mode: "blocked" })}>Blocked</button></div></li>)}</ul>}
      </div>
      <div className="card">
        <div className="row between"><h3>My pipeline</h3><Link to="/pipeline" className="small">Open pipeline</Link></div>
        <div className="grid tight">{t.pipeline.map((s: any) => <div key={s.stage} className="stat" style={{ cursor: "pointer" }} onClick={() => nav(`/pipeline?stage=${s.stage}`)}><div className="v">{s.count}</div><div className="l">{label(s.stage)}</div>{s.value_usd > 0 && <div className="sub">{usd(s.value_usd)}</div>}</div>)}</div>
      </div>
      <div className="card">
        <h3>My numbers</h3>
        <div className="grid tight" style={{ marginBottom: 10 }}>
          <Stat v={`${n.activities_today} / ${n.daily_min}`} l="Outreach today" tone={n.activities_today >= n.daily_min ? "ok" : "warn"} />
          <Stat v={usd2(n.commission_due)} l="Commission due to me" />
          <Stat v={n.days_left_week} l="Days left this week" />
          <Stat v={n.days_left_month} l="Days left this month" />
        </div>
        <div className="table-wrap"><table><thead><tr><th></th><th className="num">This week</th><th className="num">This month</th></tr></thead><tbody>
          {numRow("Leads added", "leads_added", "leads_added")}
          {numRow("Prospects reached", "prospects_reached")}
          {numRow("Outreach activities", "activities", "activities")}
          {numRow("Meetings booked", "meetings_booked", "meetings_booked")}
          {numRow("Meetings held", "meetings_held", "meetings_held")}
          {numRow("Deals closed", "deals_closed", "deals_closed")}
          {numRow("Revenue closed", "revenue_usd", "revenue_usd", true)}
          {numRow("Commission earned", "commission_earned", undefined, true)}
        </tbody></table></div>
      </div>
      {t.targets.cards.length > 0 && (
        <div className="card">
          <div className="row between"><h3>Targets</h3><button className="btn sm muted" onClick={() => setShowHistory(s => !s)}>{showHistory ? "Hide history" : "History"}</button></div>
          <div className="grid">{t.targets.cards.map((c: any) => (
            <div key={`${c.target_id}${c.period}`} className={`card ${c.won ? "ok" : ""}`} style={{ margin: 0 }}>
              <div className="row between"><span className="b">{c.name}</span><span className="chip grey">{c.period}</span></div>
              <div className="small muted">{label(c.metric)} · {fmtDate(c.range.start)} to {fmtDate(c.range.end)}</div>
              <div style={{ fontSize: 20, fontWeight: 700, margin: "6px 0" }}>{c.metric === "revenue_usd" ? usd(c.done) : c.done} <span className="muted" style={{ fontSize: 14 }}>of {c.metric === "revenue_usd" ? usd(c.number) : c.number}</span></div>
              <Progress done={c.done} total={c.number} won={c.won} />
              <div className="small muted" style={{ marginTop: 6 }}>{c.won ? <span className="chip ok">Won{c.bonus_usd ? ` · ${usd(c.bonus_usd)} bonus` : ""}</span> : <>{c.remaining} to go · {c.days_left} days left · pace {c.pace_per_day}/day{c.bonus_usd ? ` · ${usd(c.bonus_usd)} bonus` : ""}</>}</div>
            </div>
          ))}</div>
          {showHistory && <div className="table-wrap" style={{ marginTop: 10 }}><table><thead><tr><th>Target</th><th>Period</th><th className="num">Done</th><th>Result</th></tr></thead><tbody>{t.targets.history.map((h: any, i: number) => <tr key={i}><td>{h.name}</td><td>{fmtDate(h.range.start)} – {fmtDate(h.range.end)}</td><td className="num">{h.done} / {h.number}</td><td>{h.hit ? <span className="chip ok">Hit</span> : <span className="chip red">Missed by {Math.abs(h.gap)}</span>}</td></tr>)}</tbody></table></div>}
        </div>
      )}
      <div className="card">
        <div className="row between"><h3>Leaderboard position</h3><Link to="/leaderboard" className="small">Boards</Link></div>
        <div className="grid">
          <div className="stat"><div className="v">#{t.leaderboard.meetings.rank || "—"} <span className="muted" style={{ fontSize: 13 }}>of {t.leaderboard.meetings.of}</span></div><div className="l">Meetings this month · {t.leaderboard.meetings.total}</div>{t.leaderboard.meetings.above && <div className="sub">Above you: {t.leaderboard.meetings.above.name} ({t.leaderboard.meetings.above.total})</div>}</div>
          <div className="stat"><div className="v">#{t.leaderboard.commission.rank || "—"} <span className="muted" style={{ fontSize: 13 }}>of {t.leaderboard.commission.of}</span></div><div className="l">Commission this month · {pkr(t.leaderboard.commission.total_pkr)}</div>{t.leaderboard.commission.above && <div className="sub">Above you: {t.leaderboard.commission.above.name}</div>}</div>
        </div>
      </div>
      <div className={`card ${t.eod_done ? "ok" : "warn"}`}>
        <h3>End of day report</h3>
        {t.eod_done ? <div className="muted">Submitted for today. You can resubmit to update it.</div> : <div className="muted small">One line: what did you do today?</div>}
        <div className="row" style={{ marginTop: 8 }}><input value={eod} onChange={e => setEod(e.target.value)} placeholder="e.g. 32 emails, 2 replies, booked 1 meeting" style={{ flex: 1 }} /><button className="btn" disabled={!eod.trim()} onClick={submitEod}>Send</button></div>
        <Err e={eodErr} />
      </div>
      {logFor && <LogActionModal prospect={logFor} onClose={() => setLogFor(null)} onDone={reload} />}
      {addProspect && <AddProspectModal user={user} onClose={() => setAddProspect(false)} onCreated={id => { reload(); if (id) nav(`/prospects/${id}`); }} />}
      {addClosed && <AddClosedDealModal user={user} onClose={() => setAddClosed(false)} onCreated={id => { reload(); if (id) nav(`/prospects/${id}`); }} />}
      {taskModal && <TaskDoneModal task={taskModal.task} mode={taskModal.mode} onClose={() => setTaskModal(null)} onDone={reload} />}
    </div>
  );
}
void get; void patch;
