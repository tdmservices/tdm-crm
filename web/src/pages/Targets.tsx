import { useState } from "react";
import { get, post, patch, usd, fmtDate, type User } from "../lib/api";
import { useAsync, Err, Empty, Modal, Field, Select, Progress } from "../lib/ui";

export const METRIC_LABEL: Record<string, string> = {
  activities: "Prospects reached out (activities)", meetings_booked: "Meetings booked", meetings_held: "Meetings held",
  deals_closed: "Deals closed", revenue_usd: "Revenue closed (USD)", leads_added: "Leads added",
};
const PERIOD_LABEL: Record<string, string> = { week: "This week", month: "This month", quarter: "This quarter", custom: "Custom" };
const fmtVal = (metric: string, v: number) => metric === "revenue_usd" ? usd(v) : String(v);

export function TargetsPage({ user }: { user: User }) {
  return user.role === "agent" ? <AgentTargets /> : <ManageTargets />;
}

function AgentTargets() {
  const { data, error, loading } = useAsync(() => get("/targets"), []);
  if (error) return <Err e={error} />;
  if (loading || !data) return <Empty text="Loading…" />;
  const cards: any[] = data.cards ?? []; const history: any[] = data.history ?? [];
  return (
    <div>
      <h1>My targets</h1>
      {cards.length === 0 ? <div className="card"><Empty text="No active targets. Abdul sets them." /></div> : (
        <div className="grid">
          {cards.map(c => (
            <div key={`${c.target_id}-${c.period}`} className={`card ${c.won ? "ok" : ""}`}>
              <div className="row between"><div className="b">{c.name}</div><span className="chip grey">{PERIOD_LABEL[c.period]}</span></div>
              <div className="small muted">{METRIC_LABEL[c.metric] ?? c.metric}</div>
              <div style={{ fontSize: 24, fontWeight: 700, margin: "6px 0" }}>{fmtVal(c.metric, c.done)} <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>of {fmtVal(c.metric, c.number)}</span></div>
              <Progress done={c.done} total={c.number} won={c.won} />
              {c.won ? <div className="b" style={{ color: "var(--ok)", marginTop: 6 }}>Won{c.bonus_usd > 0 ? ` · ${usd(c.bonus_usd)} bonus added as Payable` : ""}</div>
                : <div className="small muted" style={{ marginTop: 6 }}>{fmtVal(c.metric, c.remaining)} to go · {c.days_left} days left · pace {fmtVal(c.metric, c.pace_per_day)}/day{c.bonus_usd > 0 ? ` · bonus ${usd(c.bonus_usd)}` : ""}</div>}
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="card table-wrap">
          <h2>History</h2>
          <table>
            <thead><tr><th>Target</th><th>Period</th><th className="num">Done / Target</th><th>Result</th></tr></thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td>{h.name}<div className="small muted">{METRIC_LABEL[h.metric] ?? h.metric}</div></td>
                  <td className="small">{fmtDate(h.range.start)} – {fmtDate(h.range.end)}</td>
                  <td className="num">{fmtVal(h.metric, h.done)} / {fmtVal(h.metric, h.number)}</td>
                  <td>{h.hit ? <span className="chip ok">Hit +{fmtVal(h.metric, h.gap)}</span> : <span className="chip red">Missed {fmtVal(h.metric, h.gap)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ManageTargets() {
  const q = useAsync(() => get("/targets"), []);
  const users = useAsync(() => get("/users"), []);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const agents: any[] = (users.data ?? []).filter((u: any) => u.role === "agent" && u.active);
  async function toggle(t: any) { setErr(null); try { await patch(`/targets/${t.id}`, { active: !t.active }); q.reload(); } catch (e) { setErr(e); } }
  const targets: any[] = q.data?.targets ?? [];
  return (
    <div>
      <div className="row between"><h1>Targets</h1><button className="btn" onClick={() => setAdding(true)}>New target</button></div>
      <Err e={err || q.error} />
      {q.loading && !q.data ? <Empty text="Loading…" /> : targets.length === 0 ? <div className="card"><Empty text="No targets yet" /></div> : targets.map(t => (
        <div key={t.id} className="card" style={t.active ? undefined : { opacity: .6 }}>
          <div className="row between">
            <div>
              <div className="b">{t.name} <span className="chip grey">{PERIOD_LABEL[t.period]}</span>{!t.active && <span className="chip red">inactive</span>}</div>
              <div className="small muted">{METRIC_LABEL[t.metric] ?? t.metric} · hit {fmtVal(t.metric, t.number)} · bonus {usd(t.bonus_usd)} · {t.scope === "team" ? "whole team" : agents.filter(a => t.user_ids.includes(a.id)).map(a => a.name).join(", ") || "named users"}</div>
              <div className="small muted">Current period {fmtDate(t.range.start)} – {fmtDate(t.range.end)}</div>
            </div>
            <button className="btn sm muted" onClick={() => toggle(t)}>{t.active ? "Deactivate" : "Activate"}</button>
          </div>
          <div style={{ marginTop: 10 }}>
            {t.progress.map((p: any) => (
              <div key={p.user_id} style={{ marginBottom: 6 }}>
                <div className="row between small"><span>{p.name}</span><span className={p.done >= p.number ? "b" : "muted"} style={p.done >= p.number ? { color: "var(--ok)" } : undefined}>{fmtVal(t.metric, p.done)} / {fmtVal(t.metric, p.number)}</span></div>
                <Progress done={p.done} total={p.number} won={p.done >= p.number} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {adding && <NewTarget metrics={q.data?.metrics ?? Object.keys(METRIC_LABEL)} agents={agents} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
    </div>
  );
}

function NewTarget({ metrics, agents, onClose, onSaved }: { metrics: string[]; agents: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: "", scope: "team", user_ids: [] as number[], metric: "meetings_booked", number: "", period: "month", custom_start: "", custom_end: "", repeat: true, bonus_usd: "" });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function save() {
    setErr(null); setBusy(true);
    try {
      await post("/targets", { name: f.name, scope: f.scope, user_ids: f.scope === "user" ? f.user_ids : undefined, metric: f.metric, number: Number(f.number), period: f.period, custom_start: f.period === "custom" ? f.custom_start : undefined, custom_end: f.period === "custom" ? f.custom_end : undefined, repeat: f.repeat, bonus_usd: Number(f.bonus_usd || 0) });
      onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title="New target" onClose={onClose}>
      <Field label="Name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. 40 meetings a month" /></Field>
      <div className="form-grid">
        <Field label="Metric"><Select value={f.metric} onChange={v => setF({ ...f, metric: v })} options={metrics.map(m => ({ value: m, label: METRIC_LABEL[m] ?? m }))} /></Field>
        <Field label="Number to hit"><input type="number" value={f.number} onChange={e => setF({ ...f, number: e.target.value })} /></Field>
        <Field label="Period"><Select value={f.period} onChange={v => setF({ ...f, period: v })} options={[{ value: "week", label: "Every week" }, { value: "month", label: "Every month" }, { value: "quarter", label: "Every quarter" }, { value: "custom", label: "Custom range" }]} /></Field>
        <Field label="Bonus (USD) on hitting it"><input type="number" value={f.bonus_usd} onChange={e => setF({ ...f, bonus_usd: e.target.value })} /></Field>
      </div>
      {f.period === "custom" && <div className="form-grid">
        <Field label="From"><input type="date" value={f.custom_start} onChange={e => setF({ ...f, custom_start: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={f.custom_end} onChange={e => setF({ ...f, custom_end: e.target.value })} /></Field>
      </div>}
      <Field label="Who"><Select value={f.scope} onChange={v => setF({ ...f, scope: v })} options={[{ value: "team", label: "Whole team (each person measured on their own)" }, { value: "user", label: "Named people" }]} /></Field>
      {f.scope === "user" && (
        <div className="card">
          {agents.map(a => (
            <label key={a.id} className="row" style={{ marginBottom: 6 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={f.user_ids.includes(a.id)} onChange={e => setF({ ...f, user_ids: e.target.checked ? [...f.user_ids, a.id] : f.user_ids.filter(x => x !== a.id) })} /> {a.name}
            </label>
          ))}
        </div>
      )}
      {f.period !== "custom" && <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" style={{ width: "auto" }} checked={f.repeat} onChange={e => setF({ ...f, repeat: e.target.checked })} /> Repeat every period</label>}
      <Err e={err} />
      <button className="btn" disabled={busy || !f.name || !f.number || (f.scope === "user" && f.user_ids.length === 0)} onClick={save}>Save target</button>
    </Modal>
  );
}
