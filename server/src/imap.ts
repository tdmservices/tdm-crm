/** Phase 3 email activity capture. Agents BCC (or forward) the CRM mailbox; sent mail from a known user to a known
 *  prospect address is logged as an "emailed" activity for that agent. Replies from a prospect address are logged as a
 *  note and move Contacted → Replied. Configure imap_host/imap_user/imap_pass in Admin → Integrations. */
import { db, getSetting } from "./db.js";
import { logActivity, notify } from "./log.js";

export async function pollMailbox() {
  const host = getSetting("imap_host"), user = getSetting("imap_user"), pass = getSetting("imap_pass");
  if (!host || !user || !pass) return;
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const unseen = (await client.search({ seen: false })) || [];
      for (const uid of unseen as number[]) {
        const msg = await client.fetchOne(uid, { source: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const from = (mail.from?.value?.[0]?.address ?? "").toLowerCase();
        const toAll = [...(mail.to ? (Array.isArray(mail.to) ? mail.to : [mail.to]) : []), ...(mail.cc ? (Array.isArray(mail.cc) ? mail.cc : [mail.cc]) : [])].flatMap(a => a.value.map(v => (v.address ?? "").toLowerCase()));
        const sender = db.prepare("SELECT id FROM users WHERE lower(email) = ? AND active = 1").get(from) as any;
        const mid = mail.messageId ?? `uid-${uid}`;
        const dup = db.prepare("SELECT 1 FROM inbound_events WHERE source = 'imap' AND external_id = ?").get(mid);
        if (dup) { await client.messageFlagsAdd(uid, ["\\Seen"]); continue; }
        let outcome = "no match";
        if (sender) {
          for (const addr of toAll) {
            const p = db.prepare("SELECT id FROM prospects WHERE lower(email) = ?").get(addr) as any;
            if (p) { logActivity({ prospectId: p.id, userId: sender.id, type: "emailed", detail: `Email: ${mail.subject ?? ""}`.slice(0, 200), occurredAt: mail.date?.toISOString() }); outcome = `emailed prospect ${p.id}`; }
          }
        } else {
          const p = db.prepare("SELECT id, owner_id, stage FROM prospects WHERE lower(email) = ?").get(from) as any;
          if (p && p.owner_id) {
            db.prepare("INSERT INTO notes (prospect_id, user_id, body) VALUES (?, ?, ?)").run(p.id, p.owner_id, `Email reply: ${mail.subject ?? ""}\n${(mail.text ?? "").slice(0, 1000)}`);
            if (p.stage === "contacted") { db.prepare("UPDATE prospects SET stage = 'replied', is_cold = 0, updated_at = datetime('now') WHERE id = ?").run(p.id); logActivity({ prospectId: p.id, userId: p.owner_id, type: "stage_change", detail: "contacted → replied (email reply captured)" }); }
            notify(p.owner_id, "email_reply", `Email reply from prospect`, mail.subject ?? undefined, p.id);
            outcome = `reply on prospect ${p.id}`;
          }
        }
        db.prepare("INSERT OR IGNORE INTO inbound_events (source, external_id, payload, outcome) VALUES ('imap', ?, ?, ?)").run(mid, JSON.stringify({ from, to: toAll, subject: mail.subject }), outcome);
        await client.messageFlagsAdd(uid, ["\\Seen"]);
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }
}
