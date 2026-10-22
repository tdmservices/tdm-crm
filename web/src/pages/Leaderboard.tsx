import { useState } from "react";
import { get, usd, pkr, type User } from "../lib/api";
import { Tabs, useAsync, Err, Empty } from "../lib/ui";
import { METRIC_LABEL } from "./Targets";

interface Row { rank: number; id: number; name: string; total: number; total_pkr?: number; previous: number | null; is_me: boolean; badge: string | null }
const BADGE: Record<string, string> = { gold: "🥇", silver: "🥈", bronze: "🥉" };

function Change({ row, money }: { row: Row; money?: boolean }) {
  if (row.previous == null) return null;
  const d = row.total - row.previous;
  if (Math.abs(d) < 0.005) return <span className="small muted">—</span>;
  const up = d > 0;
  return <span className="small" style={{ color: up ? "var(--ok)" : "var(--danger)" }}>{up ? "▲" : "▼"} {money ? usd(Math.abs(d)) : Math.abs(d)}</span>;
}

function Board({ title, subtitle, rows, money, usdOnly }: { title: string; subtitle?: string; rows: Row[]; money?: boolean; usdOnly?: boolean }) {
  const fmt = (v: number) => money ? pkr(v) : usdOnly ? usd(v) : v;
  return (
    <div className="card">
      <h2 style={subtitle ? { marginBottom: 0 } : undefined}>{title}</h2>
      {subtitle && <div className="small muted" style={{ marginBottom: 8 }}>{subtitle}</div>}
      {rows.length === 0 ? <Empty text="No agents yet" /> : (
        <ul className="list">
          {rows.map(r => (
            <li key={r.id} className={r.is_me ? "me" : ""} style={r.is_me ? { paddingLeft: 6, paddingRight: 6, borderRadius: 8 } : undefined}>
              <span className="rank">{r.rank}</span>
              <div className="main">
                <div className="title">{r.badge && <span className="badge">{BADGE[r.badge]} </span>}{r.name}{r.is_me && <span className="small muted"> (you)</span>}</div>
                <div className="sub"><Change row={r} money={money || usdOnly} /></div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="b">{money ? pkr(r.total_pkr) : fmt(r.total)}</div>
                {money && <div className="small muted">{usd(r.total)}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LeaderboardPage({ user }: { user: User }) {
  void user;
  const [period, setPeriod] = useState("month");
  const { data, error, loading } = useAsync(() => get(`/leaderboard?period=${period}`), [period]);
  return (
    <div>
      <h1>Leaderboards</h1>
      <Tabs tabs={[{ id: "week", label: "This week" }, { id: "month", label: "This month" }, { id: "quarter", label: "This quarter" }, { id: "all", label: "All time" }]} value={period} onChange={setPeriod} />
      <Err e={error} />
      {loading && !data ? <Empty text="Loading…" /> : data && (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <Board title="Meetings booked" rows={data.meetings} />
          <Board title="Commission earned" rows={data.commission} money />
          {(data.custom ?? []).map((b: any) => <Board key={b.id} title={b.name} subtitle={METRIC_LABEL[b.metric] ?? b.metric} rows={b.rows} usdOnly={b.metric === "revenue_usd"} />)}
        </div>
      )}
      <p className="small muted">Names and totals only. Pending commission and target bonuses do not count. Commission shown in PKR at today's rate; USD amounts are frozen per entry.</p>
    </div>
  );
}
