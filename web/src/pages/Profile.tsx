import { useEffect, useState } from "react";
import { get, post, patch, api, outboxCount, failedOutbox, clearFailedOutbox, flushOutbox, fmtDateTime, type User } from "../lib/api";
import { useAsync, Err, Field, Empty } from "../lib/ui";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const pushSupported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function modelText(u: User) {
  if (u.role !== "agent") return "Partner in the business, no commission";
  if (u.commission_model === "profit_split") return "Profit split 50/50 after project cost";
  return `Revenue share ${Math.round((u.commission_rate ?? 0) * 100)}%`;
}

export function ProfilePage({ user }: { user: User }) {
  const prefs = useAsync(() => get("/users/me/preferences"), []);
  const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState("");
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = prefs.data ?? {};
  const phoneVal = phone ?? p.phone ?? "";

  async function setPref(key: string, value: boolean | string | null) {
    setErr(null); setMsg("");
    try { await patch("/users/me/preferences", { [key]: value }); prefs.reload(); } catch (e) { setErr(e); }
  }

  async function togglePush(on: boolean) {
    setErr(null); setMsg(""); setBusy(true);
    try {
      if (!pushSupported()) { setMsg("Push is not available in this browser. On the Android app use email or WhatsApp alerts."); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (on) {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") { setMsg("Notification permission was not granted."); return; }
        if (!p.vapid_public) { setMsg("Push keys are not set up on the server yet."); return; }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(p.vapid_public) });
        const j = sub.toJSON();
        await post("/users/me/push", { endpoint: j.endpoint, keys: j.keys });
        await patch("/users/me/preferences", { notify_push: true });
        setMsg("Push alerts are on for this device.");
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api("DELETE", "/users/me/push", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
        await patch("/users/me/preferences", { notify_push: false });
        setMsg("Push alerts are off for this device.");
      }
      prefs.reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div>
      <h1>My profile</h1>
      <Err e={err || prefs.error} />{msg && <div className="info">{msg}</div>}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", alignItems: "start" }}>
        <div className="card">
          <h2>My account</h2>
          <table><tbody>
            <tr><td className="muted">Name</td><td className="b">{user.name}</td></tr>
            <tr><td className="muted">Email</td><td>{user.email}</td></tr>
            <tr><td className="muted">Role</td><td>{user.role}</td></tr>
            <tr><td className="muted">Commission</td><td>{modelText(user)}</td></tr>
          </tbody></table>
          {user.role === "agent" && <p className="small muted">Retainers and dedicated resources pay 30% of the first month then 10% of each later month. Shared deals split 15% each.</p>}
        </div>

        <div className="card">
          <div className="row between"><h2>Notifications</h2><button className="btn sm ghost" disabled={busy} onClick={async () => { setErr(null); try { const r = await post("/users/me/test-alert", {}); const on = Object.entries(r.channels).filter(([, v]) => v).map(([k]) => k).join(", ") || "in-app only"; setMsg(`Test alert sent via: ${on}.${r.channels.whatsapp && !r.whatsapp_configured ? " WhatsApp is on for you but not configured in Admin → Integrations." : ""}${r.channels.email && !r.smtp_configured ? " Email is on for you but SMTP is not configured." : ""}`); } catch (e) { setErr(e); } }}>Send test alert</button></div>
          <p className="small muted">In-app notifications are always on. Choose where else alerts go.</p>
          <label className="row" style={{ marginBottom: 10 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!p.notify_push} disabled={busy || prefs.loading} onChange={e => togglePush(e.target.checked)} />
            <span>Push on this device{p.push_count != null && <span className="small muted"> · {p.push_count} device{p.push_count === 1 ? "" : "s"}</span>}</span>
          </label>
          {!pushSupported() && <div className="small muted" style={{ marginBottom: 10 }}>Push is not available in this browser. On the Android app use email or WhatsApp alerts.</div>}
          <label className="row" style={{ marginBottom: 10 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!p.notify_email} disabled={prefs.loading} onChange={e => setPref("notify_email", e.target.checked)} />
            <span>Email to {user.email}</span>
          </label>
          <label className="row" style={{ marginBottom: 10 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={!!p.notify_whatsapp} disabled={prefs.loading} onChange={e => setPref("notify_whatsapp", e.target.checked)} />
            <span>WhatsApp</span>
          </label>
          <Field label="WhatsApp number (with country code)" hint="Used only for alerts to you">
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input value={phoneVal} placeholder="+92 3xx xxxxxxx" onChange={e => setPhone(e.target.value)} />
              <button className="btn sm" disabled={phone === null} onClick={async () => { await setPref("phone", phoneVal || null); setPhone(null); }}>Save</button>
            </div>
          </Field>
        </div>

        <ChangePassword />
        <OfflineQueue />
      </div>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState(""); const [next, setNext] = useState(""); const [again, setAgain] = useState("");
  const [err, setErr] = useState<unknown>(null); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  async function save() {
    setErr(null); setMsg("");
    if (next !== again) { setErr(new Error("New passwords do not match")); return; }
    setBusy(true);
    try { await post("/auth/change-password", { current, next }); setMsg("Password changed."); setCurrent(""); setNext(""); setAgain(""); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="card">
      <h2>Change password</h2>
      <Field label="Current password"><input type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
      <Field label="New password" hint="At least 8 characters"><input type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" /></Field>
      <Field label="Repeat new password"><input type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" /></Field>
      <Err e={err} />{msg && <div className="info">{msg}</div>}
      <button className="btn" disabled={busy || !current || next.length < 8} onClick={save}>Change password</button>
    </div>
  );
}

function OfflineQueue() {
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  useEffect(() => { const h = () => setTick(t => t + 1); window.addEventListener("tdm:outbox", h); return () => window.removeEventListener("tdm:outbox", h); }, []);
  void tick;
  const pending = outboxCount();
  const failed = failedOutbox();
  async function sync() { setMsg(""); const r = await flushOutbox(); setMsg(`Sent ${r.sent}${r.failed.length ? `, ${r.failed.length} rejected` : ""}.`); setTick(t => t + 1); }
  return (
    <div className="card">
      <div className="row between"><h2>Offline queue</h2><button className="btn sm ghost" onClick={sync} disabled={!navigator.onLine}>Sync now</button></div>
      <p className="small muted">Entries made without signal wait here and sync with their original time when you are back online.</p>
      <div className="small b" style={{ marginBottom: 8 }}>{pending === 0 ? "Nothing waiting to sync." : `${pending} waiting to sync.`}</div>
      {msg && <div className="info">{msg}</div>}
      {failed.length > 0 && (
        <>
          <div className="row between"><h3>Rejected by the server</h3><button className="btn sm muted" onClick={() => { clearFailedOutbox(); setTick(t => t + 1); }}>Clear</button></div>
          <ul className="list">{failed.map(f => (
            <li key={f.item.id}><div className="main"><div className="title small">{f.item.method} {f.item.path}</div><div className="sub">{f.error} · {fmtDateTime(f.item.created_at)}</div></div></li>
          ))}</ul>
        </>
      )}
      {failed.length === 0 && pending === 0 && <Empty text="All synced" />}
    </div>
  );
}
