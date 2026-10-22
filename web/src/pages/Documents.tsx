import { useState } from "react";
import { get, patch, label, fmtDate, type User } from "../lib/api";
import { Err, useAsync } from "../lib/ui";

const money = (n: number, cur: string) => `${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

/** Pure rendering of a proposal or invoice. Shared by the internal page and the client portal. */
export function DocumentView({ doc }: { doc: any }) {
  const isInvoice = doc.type === "invoice";
  return (
    <div className="doc">
      <style>{`
        .doc { background: #fff; color: #111; max-width: 800px; margin: 0 auto; padding: 32px 28px; border: 1px solid #e5e7eb; border-radius: 12px; font-size: 14px; }
        .doc h1 { font-size: 24px; margin: 0; } .doc h2 { font-size: 15px; margin: 0 0 4px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
        .doc .hdr { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; border-bottom: 2px solid #111; padding-bottom: 14px; margin-bottom: 18px; }
        .doc .meta { text-align: right; } .doc .block { margin-bottom: 18px; }
        .doc table { width: 100%; border-collapse: collapse; } .doc th, .doc td { padding: 8px 6px; border-bottom: 1px solid #e5e7eb; text-align: left; } .doc th { font-size: 12px; color: #6b7280; }
        .doc td.num, .doc th.num { text-align: right; } .doc .totals { margin-left: auto; width: 280px; } .doc .totals td { border: 0; padding: 4px 6px; } .doc .totals .grand td { font-weight: 700; font-size: 16px; border-top: 2px solid #111; }
        .doc .bank { background: #f4f6f9; padding: 12px; border-radius: 8px; white-space: pre-wrap; }
        .doc img.logo { max-height: 56px; }
        @media print { body { background: #fff; } .doc { border: 0; max-width: none; padding: 0; } }
      `}</style>
      <div className="hdr">
        <div>
          {doc.agency?.logo ? <img className="logo" src={doc.agency.logo} alt="" /> : null}
          <h1>{doc.agency?.name ?? "TDM"}</h1>
          {doc.agency?.address && <div style={{ whiteSpace: "pre-wrap", color: "#6b7280" }}>{doc.agency.address}</div>}
        </div>
        <div className="meta">
          <h2>{isInvoice ? "Invoice" : "Proposal"}</h2>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{doc.number}</div>
          <div>Issued {fmtDate(doc.issued_at)}</div>
          {isInvoice && doc.due_date && <div>Due {fmtDate(doc.due_date)}</div>}
          <div style={{ color: "#6b7280" }}>{label(doc.status)}</div>
        </div>
      </div>
      <div className="block">
        <h2>{isInvoice ? "Bill to" : "Prepared for"}</h2>
        <div style={{ fontWeight: 600 }}>{doc.company}</div>
        <div>{doc.contact_name}</div>
        {doc.email && <div>{doc.email}</div>}
        {doc.country && <div>{doc.country}</div>}
      </div>
      <div className="block">
        <h2>{doc.title}</h2>
        <table>
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
          <tbody>{(doc.lines ?? []).map((l: any, i: number) => <tr key={i}><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{money(l.unit_price, doc.currency)}</td><td className="num">{money(l.qty * l.unit_price, doc.currency)}</td></tr>)}</tbody>
        </table>
        <table className="totals">
          <tbody>
            <tr><td>Subtotal</td><td className="num">{money(doc.subtotal, doc.currency)}</td></tr>
            {doc.tax_rate > 0 && <tr><td>Tax {doc.tax_rate}%</td><td className="num">{money(doc.total - doc.subtotal, doc.currency)}</td></tr>}
            <tr className="grand"><td>Total</td><td className="num">{money(doc.total, doc.currency)}</td></tr>
          </tbody>
        </table>
      </div>
      {doc.notes && <div className="block"><h2>Notes</h2><div style={{ whiteSpace: "pre-wrap" }}>{doc.notes}</div></div>}
      {isInvoice && doc.agency?.bank && <div className="block"><h2>Payment details</h2><div className="bank">{doc.agency.bank}</div></div>}
    </div>
  );
}

export function DocumentPage({ id, user }: { id: number; user: User }) {
  const d = useAsync(() => get(`/documents/${id}`), [id]);
  const [err, setErr] = useState<unknown>(null);
  if (d.loading && !d.data) return <div className="center">Loading…</div>;
  if (d.error && !d.data) return <Err e={d.error} />;
  const doc = d.data;
  async function setStatus(status: string) { setErr(null); try { await patch(`/documents/${id}`, { status }); d.reload(); } catch (e) { setErr(e); } }
  return (
    <div>
      <style>{`@media print { .doc-toolbar, .sidebar, .topbar, .tabbar, .offline-bar { display: none !important; } .content { padding: 0 !important; } }`}</style>
      <div className="doc-toolbar card">
        <div className="row between">
          <div className="row">
            <a onClick={() => history.back()} className="btn sm muted">← Back</a>
            <a href={`#/prospects/${doc.prospect_id}`} className="small">{doc.company}</a>
          </div>
          <div className="row">
            <select value={doc.status} onChange={e => setStatus(e.target.value)} style={{ width: "auto" }}>
              {["draft", "sent", "accepted", "paid", "void"].map(s => <option key={s} value={s}>{label(s)}</option>)}
            </select>
            <button className="btn sm" onClick={() => window.print()}>Print / Save as PDF</button>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>Mark as Sent once you email it. Created by {doc.created_by_name}{user.role !== "agent" ? "" : ""}.</div>
        <Err e={err} />
      </div>
      <DocumentView doc={doc} />
    </div>
  );
}
