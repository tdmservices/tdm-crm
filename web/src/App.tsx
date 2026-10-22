import { useEffect, useState } from "react";
import { get, post, setToken, getToken, flushOutbox, outboxCount, cmpVersion, APP_VERSION, type User } from "./lib/api";
import { useHash, Link, Err } from "./lib/ui";
import { TodayPage } from "./pages/Today";
import { PipelinePage } from "./pages/Pipeline";
import { ProspectPage } from "./pages/Prospect";
import { TasksPage } from "./pages/Tasks";
import { LeaderboardPage } from "./pages/Leaderboard";
import { CommissionPage } from "./pages/Commission";
import { TargetsPage } from "./pages/Targets";
import { TeamPage } from "./pages/Team";
import { ReportsPage } from "./pages/Reports";
import { AdminPage } from "./pages/Admin";
import { PayoutsPage } from "./pages/Payouts";
import { DocumentPage } from "./pages/Documents";
import { PortalPage } from "./pages/Portal";
import { ProfilePage } from "./pages/Profile";

export function App() {
  const hash = useHash();
  const portal = hash.match(/^\/portal\/([A-Za-z0-9_-]+)(?:\/documents\/(\d+))?/);
  if (portal) return <PortalPage token={portal[1]} documentId={portal[2] ? Number(portal[2]) : null} />;
  return <AuthedApp />;
}

function AuthedApp() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(!!getToken());
  const [gate, setGate] = useState<{ min: string; url: string } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(outboxCount());

  useEffect(() => {
    const on = () => { setOnline(true); void flushOutbox().then(() => setPending(outboxCount())); };
    const off = () => setOnline(false);
    const ob = () => setPending(outboxCount());
    const lo = () => setUser(null);
    window.addEventListener("online", on); window.addEventListener("offline", off); window.addEventListener("tdm:outbox", ob); window.addEventListener("tdm:logout", lo);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); window.removeEventListener("tdm:outbox", ob); window.removeEventListener("tdm:logout", lo); };
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    get("/auth/me").then(r => { setUser(r.user); checkVersion(r.min_app_version, r.apk_download_url); void flushOutbox(); })
      .catch(() => { /* offline: keep cached session */ const c = localStorage.getItem("tdm_user"); if (c) setUser(JSON.parse(c)); })
      .finally(() => setBooting(false));
  }, []);
  useEffect(() => { if (user) localStorage.setItem("tdm_user", JSON.stringify(user)); }, [user]);

  function checkVersion(min: string | undefined, url: string | undefined) {
    if (min && cmpVersion(APP_VERSION, min) < 0) setGate({ min, url: url ?? "" });
  }

  if (gate) return (
    <div className="login card">
      <h1>Update required</h1>
      <p>This app is version {APP_VERSION}. The team must be on at least {gate.min} so everyone runs the same commission logic.</p>
      {gate.url ? <a className="btn" href={gate.url}>Download the new APK</a> : <p className="muted">Ask Abdul for the new APK.</p>}
    </div>
  );
  if (booting) return <div className="center">Loading…</div>;
  if (!user) return <Login onLogin={(u, min, url) => { setUser(u); checkVersion(min, url); }} />;
  return <Shell user={user} online={online} pending={pending} onLogout={() => { setToken(null); localStorage.removeItem("tdm_user"); setUser(null); }} />;
}

function Login({ onLogin }: { onLogin: (u: User, min?: string, url?: string) => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await post("/auth/login", { email, password, app_version: APP_VERSION }); setToken(r.token); onLogin(r.user, r.min_app_version, r.apk_download_url); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <form className="login card" onSubmit={submit}>
      <h1>TDM CRM</h1>
      <p className="muted small">If it is not in the CRM, it did not happen.</p>
      <label className="f"><span>Email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></label>
      <label className="f"><span>Password</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      <Err e={err} />
      <button className="btn" disabled={busy} style={{ width: "100%" }}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

function Shell({ user, online, pending, onLogout }: { user: User; online: boolean; pending: number; onLogout: () => void }) {
  const hash = useHash();
  const [brand, setBrand] = useState(() => { try { return localStorage.getItem("tdm_brand") || "TDM CRM"; } catch { return "TDM CRM"; } });
  useEffect(() => { get("/settings/branding").then(b => { const n = b.agency_name ? `${b.agency_name} CRM` : "TDM CRM"; setBrand(n); document.title = n; try { localStorage.setItem("tdm_brand", n); } catch { /* ignore */ } }).catch(() => {}); }, []);
  const docMatch = hash.match(/^\/documents\/(\d+)/);
  if (docMatch) return <DocumentPage id={Number(docMatch[1])} user={user} />;
  const mgmt = user.role !== "agent";
  const tabs = mgmt
    ? [["/", "Team", "▣"], ["/pipeline", "Pipeline", "☰"], ["/tasks", "Tasks", "✓"], ["/payouts", "Payouts", "$"], ["/reports", "Reports", "▤"], ["/leaderboard", "Board", "★"], ["/targets", "Targets", "◎"], ["/admin", "Admin", "⚙"]]
    : [["/", "Today", "☀"], ["/pipeline", "Pipeline", "☰"], ["/tasks", "Tasks", "✓"], ["/commission", "Money", "$"], ["/leaderboard", "Board", "★"], ["/targets", "Targets", "◎"]];
  const active = (p: string) => (p === "/" ? hash === "/" : hash.startsWith(p)) ? "active" : "";
  const mobileTabs = tabs.slice(0, 5);
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">{brand}</div>
        {tabs.map(([p, l]) => <Link key={p} to={p} className={active(p)}>{l}</Link>)}
        <div className="who"><Link to="/me" style={{ padding: 0, display: "inline", color: "#cbd5e1" }}>{user.name}</Link> · {user.role}<br /><a onClick={onLogout} style={{ padding: 0, display: "inline", color: "#94a3b8" }}>Sign out</a></div>
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}>
        <header className="topbar"><span className="brand">{brand}</span><span className="who"><Link to="/me" style={{ color: "#fff" }}>{user.name}</Link> · <a onClick={onLogout} style={{ color: "#cbd5e1" }}>Sign out</a></span></header>
        {!online && <div className="offline-bar">Offline. Entries are saved on this device and will sync when back online{pending ? ` (${pending} waiting)` : ""}.</div>}
        {online && pending > 0 && <div className="offline-bar">Syncing {pending} saved entries…</div>}
        <main className="content"><Router hash={hash} user={user} /></main>
      </div>
      <nav className="tabbar">{mobileTabs.map(([p, l, i]) => <Link key={p} to={p} className={active(p)}><span className="ico">{i}</span>{l}</Link>)}{mgmt && <Link to="/admin" className={active("/admin")}><span className="ico">⚙</span>More</Link>}</nav>
    </div>
  );
}

function Router({ hash, user }: { hash: string; user: User }) {
  const [path, query] = hash.split("?");
  const q = new URLSearchParams(query ?? "");
  const mgmt = user.role !== "agent";
  const m = path.match(/^\/prospects\/(\d+)/);
  if (m) return <ProspectPage id={Number(m[1])} user={user} />;
  switch (path) {
    case "/": return mgmt ? <TeamPage user={user} /> : <TodayPage user={user} />;
    case "/today": return <TodayPage user={user} />;
    case "/pipeline": return <PipelinePage user={user} query={q} />;
    case "/tasks": return <TasksPage user={user} />;
    case "/leaderboard": return <LeaderboardPage user={user} />;
    case "/commission": return <CommissionPage user={user} />;
    case "/payouts": return mgmt ? <PayoutsPage user={user} /> : <CommissionPage user={user} />;
    case "/targets": return <TargetsPage user={user} />;
    case "/reports": return mgmt ? <ReportsPage user={user} /> : <TodayPage user={user} />;
    case "/admin": return mgmt ? <AdminPage user={user} tab={q.get("tab") ?? "users"} /> : <TodayPage user={user} />;
    case "/me": return <ProfilePage user={user} />;
    default: return <div className="center">Page not found. <Link to="/">Go home</Link></div>;
  }
}
