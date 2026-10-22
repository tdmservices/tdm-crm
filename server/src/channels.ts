/** Phase 3 delivery channels. Every in-app notification is also pushed through the channels the user has on,
 *  when the Owner has configured them in Admin → Integrations. Failures never block the CRM. */
import nodemailer from "nodemailer";
import webpush from "web-push";
import { db, getSetting, setSetting } from "./db.js";

export function ensureVapid() {
  if (!getSetting("vapid_public")) {
    const k = webpush.generateVAPIDKeys();
    setSetting("vapid_public", k.publicKey); setSetting("vapid_private", k.privateKey);
  }
  webpush.setVapidDetails("mailto:" + (getSetting("smtp_from") || "crm@tdm.services"), getSetting("vapid_public")!, getSetting("vapid_private")!);
}

export async function sendEmail(to: string, subject: string, text: string) {
  const host = getSetting("smtp_host"); if (!host || !to) return false;
  try {
    const t = nodemailer.createTransport({ host, port: Number(getSetting("smtp_port") ?? 587), secure: Number(getSetting("smtp_port")) === 465, auth: { user: getSetting("smtp_user"), pass: getSetting("smtp_pass") } });
    await t.sendMail({ from: getSetting("smtp_from") || getSetting("smtp_user"), to, subject, text });
    return true;
  } catch (e) { console.error("email failed", (e as Error).message); return false; }
}

/** WhatsApp via Meta Cloud API (text message; the recipient must have messaged the number in the last 24h or a template is needed). */
export async function sendWhatsApp(phone: string, text: string) {
  const token = getSetting("whatsapp_token"), phoneId = getSetting("whatsapp_phone_id");
  if (!token || !phoneId || !phone) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to: phone.replace(/\D/g, ""), type: "text", text: { body: text } }) });
    return res.ok;
  } catch { return false; }
}

export async function sendPush(userId: number, title: string, body?: string, url?: string) {
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? AND kind = 'webpush'").all(userId) as any[];
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }, JSON.stringify({ title, body, url })); }
    catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id); }
  }
}

/** Fan out one notification to a user's enabled channels. Fire-and-forget. */
export function dispatch(userId: number, title: string, body?: string, prospectId?: number | null) {
  const u = db.prepare("SELECT email, phone, notify_email, notify_whatsapp, notify_push FROM users WHERE id = ?").get(userId) as any;
  if (!u) return;
  const url = prospectId ? `/#/prospects/${prospectId}` : "/#/";
  const text = body ? `${title}\n${body}` : title;
  void (async () => {
    if (u.notify_push) await sendPush(userId, title, body, url);
    if (u.notify_email) await sendEmail(u.email, `[${getSetting("agency_name") ?? "CRM"}] ${title}`, text);
    if (u.notify_whatsapp && u.phone) await sendWhatsApp(u.phone, text);
  })();
}
