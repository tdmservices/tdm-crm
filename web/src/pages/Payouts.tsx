import { useState } from "react";
import { get, post, getToken, usd2, label, fmtDate, todayPk, type User } from "../lib/api";
import { useAsync, Err, Empty, Modal, Field, Select, Link } from "../lib/ui";

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

/** Export a CSV with the auth header, then trigger a browser download. */
export async function downloadCsv(what: string) {
  const res = await fetch(`${BASE}/api/reports/export/${what}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const text = await res.text();
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `tdm-${what}-${todayPk()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PayoutsPage({ user }: { user: User }) {
  const owner = user.role === "owner";
  const q = useAsync(() => get("/commission/payouts"), []);
  const frozen = useAsync(() => get("/reports/frozen"), []);
  const users = useAsync(() => get("/users"), []);
  const [paying, setPaying] = useState<any | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [transfer, setTransfer] = useState<{ entry: any; to: string } | null>(null);

  async function pay() {
    if (!paying) return;
    setErr(null);
    try {
      const r = await post(`/commission/payouts/${paying.id}/pay`, { note: note || undefined });
      setResult(r.paid > 0 ? `Paid ${usd2(r.paid)} to ${paying.name}.` : r.carried < 0 ? `Nothing due. Balance of ${usd2(r.carried)} carried forward for ${paying.name}.` : `Nothing payable for ${paying.name}.`);
      setPaying(null); setNote(""); q.reload();
    } catch (e) { setErr(e); }
  }
  async function decide(entry: any, decision: string, newUser?: number) {
    setErr(null);
    try { await post(`/commission/entries/${entry.id}/decide`, { decision, new_user_id: newUser }); setTransfer(null); frozen.reload(); q.reload(); }
    catch (e) { setErr(e); }
  }
  async function exp() { setErr(null); try { await downloadCsv("commission"); } catch (e) { setErr(e); } }

  const people: any[] = q.data?.people ?? [];
  const entries: any[] = q.data?.open_entries ?? [];
  const agents: any[] = (users.data ?? []).filter((u: any) => u.active);

  return (
    <div>
      <div className="row between"><h1>Payouts</h1><button className="btn sm ghost" onClick={exp}>Export CSV</button></div>
      <Err e={err || q.error} />
      {result && <div className="info">{result}</div>}
      {!owner && <div className="info">Only Abdul approves payouts. You can view everything here.</div>}
      {q.loading && !q.data ? <Empty text="Loading…" /> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Person</th><th>Model</th><th className="num">Payable now</th><th className="num">Frozen</th><th className="num">Pending</th><th className="num">Paid this month</th><th></th></tr></thead>
            <tbody>
              {people.map(p => (
                <>
                  <tr key={p.id}>
                    <td><a onClick={() => setOpen(open === p.id ? null : p.id)} style={{ cursor: "pointer" }}>{p.name}</a> <span className="small muted">{open === p.id ? "▴" : "▾"}</span></td>
                    <td className="small">{label(p.commission_model)} {p.commission_model === "revenue_share" ? `${Math.round(p.commission_rate * 100)}%` : ""}</td>
                    <td className="num b" style={p.payable < 0 ? { color: "var(--danger)" } : undefined}>{usd2(p.payable)}</td>
                    <td className="num">{usd2(p.frozen)}</td>
                    <td className="num">{usd2(p.pending)}</td>
                    <td className="num">{usd2(p.paid_this_month)}</td>
                    <td><button className="btn sm" disabled={!owner || p.payable === 0} title={owner ? "" : "Only Abdul approves payouts"} onClick={() => setPaying(p)}>Mark paid</button></td>
                  </tr>
                  {open === p.id && (
                    <tr key={`${p.id}-d`}><td colSpan={7} style={{ background: "#f9fafb" }}>
                      {entries.filter(e => e.user_id === p.id).length === 0 ? <span className="muted small">No open entries</span> : (
                        <ul className="list">
                          {entries.filter(e => e.user_id === p.id).map(e => (
                            <li key={e.id}>
                              <div className="main">
                                <div className="title">{e.prospect_id ? <Link to={`/prospects/${e.prospect_id}`}>{e.company}</Link> : "—"} <span className="chip grey">{label(e.kind)}</span>{e.frozen ? <span className="chip warn">frozen</span> : null}</div>
                                <div className="sub">{e.description} · {fmtDate(e.created_at)}</div>
                              </div>
                              <div style={{ textAlign: "right" }}><div className="b" style={e.amount_usd < 0 ? { color: "var(--danger)" } : undefined}>{usd2(e.amount_usd)}</div><span className={`chip ${e.status === "payable" ? "warn" : "grey"}`}>{e.status}</span></div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td></tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Frozen (reassignment)</h2>
        <p className="small muted">Pending commission of someone who left or was reassigned. Abdul decides per deal: keep with the original person, transfer to the new owner, or cancel.</p>
        <Err e={frozen.error} />
        {(frozen.data ?? []).length === 0 ? <Empty text="Nothing frozen" /> : (
          <ul className="list">
            {(frozen.data as any[]).map(e => (
              <li key={e.id}>
                <div className="main">
                  <div className="title">{e.prospect_id ? <Link to={`/prospects/${e.prospect_id}`}>{e.company}</Link> : "—"}</div>
                  <div className="sub">Originally {e.user_name} · current owner {e.current_owner_name ?? "unassigned"} · {e.description}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="b">{usd2(e.amount_usd)}</div>
                  {owner && <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                    <button className="btn sm muted" onClick={() => decide(e, "keep")}>Keep</button>
                    <button className="btn sm" onClick={() => setTransfer({ entry: e, to: String(e.current_owner_id ?? "") })}>Transfer</button>
                    <button className="btn sm danger" onClick={() => { if (confirm("Cancel this commission entry?")) decide(e, "cancel"); }}>Cancel</button>
                  </div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {paying && (
        <Modal title={`Mark paid: ${paying.name}`} onClose={() => setPaying(null)}>
          <p>Marks every Payable entry for {paying.name} as paid. Total due now: <b>{usd2(paying.payable)}</b>.{paying.payable < 0 && " The balance is negative, so nothing is paid and it carries forward."}</p>
          <Field label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. bank transfer ref" /></Field>
          <Err e={err} />
          <button className="btn ok" onClick={pay}>Confirm paid</button>
        </Modal>
      )}
      {transfer && (
        <Modal title="Transfer entry" onClose={() => setTransfer(null)}>
          <Field label="Transfer to"><Select value={transfer.to} onChange={v => setTransfer({ ...transfer, to: v })} allowEmpty="Pick a person" options={agents.map((u: any) => ({ value: String(u.id), label: u.name }))} /></Field>
          <button className="btn" disabled={!transfer.to} onClick={() => decide(transfer.entry, "transfer", Number(transfer.to))}>Transfer</button>
        </Modal>
      )}
    </div>
  );
}
