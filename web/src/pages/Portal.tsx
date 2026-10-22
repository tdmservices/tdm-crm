import { get, label, fmtDate, ApiError } from "../lib/api";
import { Err, useAsync } from "../lib/ui";
import { DocumentView } from "./Documents";

const money = (n: number, cur: string) => `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${cur}`;

function Invalid() {
  return <div className="login card"><h1>Link not valid</h1><p className="muted">This link is not valid or has expired. Ask your account manager for a new one.</p></div>;
}

export function PortalPage({ token, documentId }: { token: string; documentId: number | null }) {
  const d = useAsync(() => documentId ? get(`/portal/${token}/documents/${documentId}`) : get(`/portal/${token}`), [token, documentId]);
  if (d.loading && !d.data) return <div className="center">Loading…</div>;
  if (d.error && !d.data) return d.error instanceof ApiError && d.error.status === 404 ? <Invalid /> : <div className="content"><Err e={d.error} /></div>;
  if (documentId) {
    return (
      <div className="content">
        <style>{`@media print { .doc-toolbar { display: none !important; } .content { padding: 0 !important; } }`}</style>
        <div className="doc-toolbar row between" style={{ marginBottom: 12 }}>
          <a href={`#/portal/${token}`} className="btn sm muted">← Back</a>
          <button className="btn sm" onClick={() => window.print()}>Print / Save as PDF</button>
        </div>
        <DocumentView doc={d.data} />
      </div>
    );
  }
  const { agency, deal, schedule, payments, documents } = d.data;
  const statusLine = deal.after_close_status ? label(deal.after_close_status) : deal.closed_won_at ? "Active" : "In progress";
  return (
    <div className="content" style={{ maxWidth: 760 }}>
      <div className="row" style={{ marginBottom: 14 }}>
        {agency?.logo ? <img src={agency.logo} alt="" style={{ maxHeight: 44 }} /> : null}
        <h1 style={{ margin: 0 }}>{agency?.name ?? "TDM"}</h1>
      </div>
      <div className="card">
        <h2 style={{ marginBottom: 2 }}>Hello {deal.contact_name}</h2>
        <div className="muted">{deal.company} · {label(deal.engagement_model)} · <span className="chip ok">{statusLine}</span></div>
      </div>
      <div className="card">
        <h3>Payment schedule</h3>
        {schedule.length === 0 ? <div className="muted">No scheduled payments.</div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Payment</th><th className="num">Amount</th><th>Expected</th><th>Status</th></tr></thead>
            <tbody>{schedule.map((s: any) => <tr key={s.id}><td>{s.name}</td><td className="num">{money(s.amount, s.currency)}</td><td>{fmtDate(s.expected_date)}</td><td><span className={`chip ${s.status === "received" ? "ok" : s.status === "overdue" ? "red" : "grey"}`}>{s.status === "received" ? `Received ${fmtDate(s.received_at)}` : label(s.status)}</span></td></tr>)}</tbody>
          </table></div>
        )}
      </div>
      <div className="card">
        <h3>Payments received</h3>
        {payments.length === 0 ? <div className="muted">None yet.</div> : <ul className="list">{payments.map((p: any, i: number) => <li key={i}><div className="main"><div className="title">{p.label ?? "Payment"} · {money(p.amount, p.currency)}</div><div className="sub">Received {fmtDate(p.received_at)}</div></div></li>)}</ul>}
      </div>
      <div className="card">
        <h3>Documents</h3>
        {documents.length === 0 ? <div className="muted">No documents shared yet.</div> : <ul className="list">{documents.map((doc: any) => <li key={doc.id}><div className="main"><a href={`#/portal/${token}/documents/${doc.id}`}><span className="title">{doc.number} · {doc.title}</span></a><div className="sub">{label(doc.type)} · {money(doc.total, doc.currency)} · issued {fmtDate(doc.issued_at)}{doc.due_date ? ` · due ${fmtDate(doc.due_date)}` : ""} · {label(doc.status)}</div></div><a className="btn sm ghost" href={`#/portal/${token}/documents/${doc.id}`}>Open</a></li>)}</ul>}
      </div>
      {agency?.bank && <div className="card"><h3>Payment details</h3><div style={{ whiteSpace: "pre-wrap" }}>{agency.bank}</div></div>}
      <div className="center small">Questions? Reply to your account manager at {agency?.name ?? "TDM"}.</div>
    </div>
  );
}
