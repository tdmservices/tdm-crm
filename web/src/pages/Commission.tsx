import { get, usd2, fmtDate, label, type User } from "../lib/api";
import { useAsync, Err, Empty, Stat, Link } from "../lib/ui";

const STATUS_CLS: Record<string, string> = { pending: "grey", payable: "warn", paid: "ok", reversed: "red" };

function modelText(model: string, rate: number) {
  if (model === "profit_split") return "Profit split 50/50 after project cost";
  return `Revenue share ${Math.round(rate * 100)}%`;
}

export function CommissionPage({ user }: { user: User }) {
  const { data, error, loading } = useAsync(() => get("/commission/mine"), []);
  if (error) return <Err e={error} />;
  if (loading || !data) return <Empty text="Loading…" />;
  const t = data.totals;
  return (
    <div>
      <h1>My commission</h1>
      <div className="grid tight">
        <Stat v={usd2(t.pending)} l="Pending" sub="Deals closed, client not yet paid" />
        <Stat v={usd2(t.payable)} l="Payable" sub="TDM owes you now" tone={t.payable > 0 ? "warn" : undefined} />
        <Stat v={usd2(t.paid_this_month)} l="Paid this month" />
        <Stat v={usd2(t.paid_all_time)} l="Paid all time" tone="ok" />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="b">Your model: {modelText(data.profile.model ?? user.commission_model, data.profile.rate ?? user.commission_rate)}</div>
        <div className="small muted">Retainers: 30% first month, then 10% each later month. Shared deals: 30% split 15% each (retainers 5% each).</div>
      </div>
      <div className="card">
        <h2>Entries</h2>
        {data.entries.length === 0 ? <Empty text="No commission entries yet" /> : (
          <ul className="list">
            {data.entries.map((e: any) => (
              <li key={e.id}>
                <div className="main">
                  <div className="title">{e.prospect_id ? <Link to={`/prospects/${e.prospect_id}`}>{e.company ?? "Deal"}</Link> : (e.company ?? "—")} <span className={`chip ${e.kind === "clawback" ? "red" : e.kind === "bonus" ? "ok" : e.kind === "true_up" ? "warn" : "grey"}`}>{label(e.kind)}</span></div>
                  <div className="sub">{e.description}</div>
                  {e.kind === "sales" && e.base_usd != null && (
                    <div className="sub">base {usd2(e.base_usd)}{e.rate != null && ` · rate ${Math.round(e.rate * 100)}%`}{e.cost_share_usd != null && ` · cost share ${usd2(e.cost_share_usd)}`}</div>
                  )}
                  <div className="sub">{fmtDate(e.created_at)}{e.paid_at ? ` · paid ${fmtDate(e.paid_at)}` : ""}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="b" style={e.amount_usd < 0 ? { color: "var(--danger)" } : undefined}>{usd2(e.status === "paid" && e.paid_amount_usd != null ? e.paid_amount_usd : e.amount_usd)}</div>
                  <span className={`chip ${STATUS_CLS[e.status] ?? ""}`}>{e.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
