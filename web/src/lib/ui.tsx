import { useEffect, useState, type ReactNode } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="btn sm muted" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="f"><span>{label}</span>{children}{hint && <span className="small muted" style={{ marginTop: 3 }}>{hint}</span>}</label>;
}
export function Select({ value, onChange, options, allowEmpty, labelFn }: { value: string; onChange: (v: string) => void; options: readonly string[] | { value: string; label: string }[]; allowEmpty?: string; labelFn?: (s: string) => string }) {
  const opts = options.map(o => typeof o === "string" ? { value: o, label: labelFn ? labelFn(o) : o } : o);
  return <select value={value} onChange={e => onChange(e.target.value)}>{allowEmpty !== undefined && <option value="">{allowEmpty}</option>}{opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
export function Err({ e }: { e: unknown }) { if (!e) return null; return <div className="err">{(e as Error).message ?? String(e)}</div>; }
export function Empty({ text }: { text: string }) { return <div className="center">{text}</div>; }
export function Stat({ v, l, sub, tone }: { v: ReactNode; l: string; sub?: ReactNode; tone?: "red" | "ok" | "warn" }) {
  return <div className="stat" style={tone === "red" ? { borderColor: "#fca5a5" } : tone === "ok" ? { borderColor: "#86efac" } : tone === "warn" ? { borderColor: "#fcd34d" } : undefined}><div className="v">{v}</div><div className="l">{l}</div>{sub && <div className="sub">{sub}</div>}</div>;
}
export function Stage({ s }: { s: string }) {
  const cls = s === "closed_won" ? "ok" : s === "closed_lost" ? "grey" : ["proposal_sent", "negotiation"].includes(s) ? "warn" : "";
  return <span className={`chip ${cls}`}>{s.replace(/_/g, " ")}</span>;
}
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, set] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => { let alive = true; set(s => ({ ...s, loading: true })); fn().then(d => alive && set({ data: d, loading: false })).catch(e => alive && set(s => ({ data: s.data, error: e, loading: false }))); return () => { alive = false; }; }, [...deps, tick]);
  return { ...state, reload: () => setTick(t => t + 1) };
}
export function Progress({ done, total, won }: { done: number; total: number; won?: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  return <div className={`progress ${won ? "won" : ""}`}><div style={{ width: `${pct}%` }} /></div>;
}
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs">{tabs.map(t => <button key={t.id} className={t.id === value ? "active" : ""} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
/** Minimal hash router. */
export function useHash() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => { const h = () => setHash(window.location.hash.slice(1) || "/"); window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h); }, []);
  return hash;
}
export function nav(path: string) { window.location.hash = path; }
export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) { return <a href={`#${to}`} className={className}>{children}</a>; }
