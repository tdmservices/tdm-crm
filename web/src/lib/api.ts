/** API client with offline outbox. Agents can add prospects, log activities, complete tasks and write notes
 *  without signal; queued writes replay in order when back online, carrying the original device timestamp. */
export const APP_VERSION = "1.0.0";
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export interface User { id: number; name: string; email: string; role: "owner" | "manager" | "agent"; commission_model: string; commission_rate: number }

export class ApiError extends Error {
  status: number; data?: any;
  constructor(status: number, message: string, data?: any) { super(message); this.status = status; this.data = data; }
}

let token: string | null = safeGet("tdm_token");
export function setToken(t: string | null) { token = t; if (t) safeSet("tdm_token", t); else safeDel("tdm_token"); }
export function getToken() { return token; }

function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function safeDel(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + "/api" + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), "X-App-Version": APP_VERSION },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) { setToken(null); window.dispatchEvent(new Event("tdm:logout")); }
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data);
  }
  return data as T;
}
export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b);
export const patch = <T = any>(p: string, b?: unknown) => api<T>("PATCH", p, b);

/* ---------- Offline outbox ---------- */
interface Queued { id: string; method: string; path: string; body: any; created_at: string }
const OUTBOX_KEY = "tdm_outbox";
function readOutbox(): Queued[] { try { return JSON.parse(safeGet(OUTBOX_KEY) ?? "[]"); } catch { return []; } }
function writeOutbox(q: Queued[]) { safeSet(OUTBOX_KEY, JSON.stringify(q)); window.dispatchEvent(new Event("tdm:outbox")); }
export function outboxCount() { return readOutbox().length; }
export function isOnline() { return typeof navigator === "undefined" ? true : navigator.onLine; }

/** Write that may be queued offline. Body gets client_created_at and (for creates) client_uuid. */
export async function offlineWrite(method: string, path: string, body: any) {
  const stamped = { ...body, client_created_at: body.client_created_at ?? new Date().toISOString() };
  if (method === "POST" && path === "/prospects" && !stamped.client_uuid) stamped.client_uuid = crypto.randomUUID();
  if (!isOnline()) { queue(method, path, stamped); return { queued: true }; }
  try { return await api(method, path, stamped); }
  catch (e) {
    if (e instanceof ApiError) throw e;             // server rejected: surface it
    queue(method, path, stamped); return { queued: true };   // network failure: queue
  }
}
function queue(method: string, path: string, body: any) { const q = readOutbox(); q.push({ id: crypto.randomUUID(), method, path, body, created_at: new Date().toISOString() }); writeOutbox(q); }

let flushing = false;
export async function flushOutbox(): Promise<{ sent: number; failed: { item: Queued; error: string }[] }> {
  if (flushing || !isOnline()) return { sent: 0, failed: [] };
  flushing = true; let sent = 0; const failed: { item: Queued; error: string }[] = [];
  try {
    let q = readOutbox();
    while (q.length) {
      const item = q[0];
      try { await api(item.method, item.path, item.body); sent++; }
      catch (e) {
        if (e instanceof ApiError) { failed.push({ item, error: e.message }); }   // rejected: drop so the rest can go
        else break;                                                                 // still offline: stop
      }
      q = q.slice(1); writeOutbox(q);
    }
  } finally { flushing = false; }
  if (failed.length) { safeSet("tdm_outbox_failed", JSON.stringify([...(JSON.parse(safeGet("tdm_outbox_failed") ?? "[]")), ...failed].slice(-20))); }
  return { sent, failed };
}
export function failedOutbox(): { item: Queued; error: string }[] { try { return JSON.parse(safeGet("tdm_outbox_failed") ?? "[]"); } catch { return []; } }
export function clearFailedOutbox() { safeDel("tdm_outbox_failed"); window.dispatchEvent(new Event("tdm:outbox")); }
if (typeof window !== "undefined") window.addEventListener("online", () => { void flushOutbox(); });

/* ---------- Cached reads for offline viewing ---------- */
export function cacheSet(key: string, v: unknown) { safeSet("tdm_cache_" + key, JSON.stringify({ at: Date.now(), v })); }
export function cacheGet<T = any>(key: string): { at: number; v: T } | null { try { const s = safeGet("tdm_cache_" + key); return s ? JSON.parse(s) : null; } catch { return null; } }
export async function cachedGet<T = any>(key: string, path: string): Promise<{ data: T; stale: boolean }> {
  try { const data = await get<T>(path); cacheSet(key, data); return { data, stale: false }; }
  catch (e) { if (e instanceof ApiError) throw e; const c = cacheGet<T>(key); if (c) return { data: c.v, stale: true }; throw e; }
}

/* ---------- Formatting ---------- */
export const usd = (n: number | null | undefined) => n == null ? "—" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
export const usd2 = (n: number | null | undefined) => n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pkr = (n: number | null | undefined) => n == null ? "—" : `Rs ${Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
export const label = (s: string | null | undefined) => s ? s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace("Seo Aeo Geo", "SEO/AEO/GEO").replace("Web Shopify", "Web/Shopify").replace("Usd", "USD") : "—";
export const fmtDate = (s: string | null | undefined) => { if (!s) return "—"; const d = new Date(s.length === 10 ? s + "T00:00:00" : s); return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
export const fmtDateTime = (s: string | null | undefined) => { if (!s) return "—"; const d = new Date(s); return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" }); };
export const todayPk = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export function cmpVersion(a: string, b: string) { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0); } return 0; }
