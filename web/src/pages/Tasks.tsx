import { useState } from "react";
import { get, post, patch, label, fmtDate, todayPk, type User } from "../lib/api";
import { Modal, Field, Select, Err, Empty, useAsync, Link } from "../lib/ui";
import { TaskDoneModal } from "./Today";

export function TasksPage({ user }: { user: User }) {
  const mgmt = user.role !== "agent";
  const [showDone, setShowDone] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [modal, setModal] = useState<{ task: any; mode: "done" | "blocked" } | null>(null);
  const [create, setCreate] = useState(false);
  const qs = new URLSearchParams(); if (!showDone) qs.set("open", "1"); if (assignee) qs.set("assigned_to", assignee);
  const list = useAsync(() => get(`/tasks?${qs}`), [showDone, assignee]);
  const users = useAsync(() => mgmt ? get("/users") : Promise.resolve([]), []);
  const today = todayPk();
  const tasks: any[] = list.data ?? [];
  const groups = [
    { id: "overdue", title: "Overdue", cls: "red", items: tasks.filter(t => t.status !== "done" && t.due_date < today) },
    { id: "today", title: "Due today", cls: "", items: tasks.filter(t => t.status !== "done" && t.due_date === today) },
    { id: "upcoming", title: "Upcoming", cls: "", items: tasks.filter(t => t.status !== "done" && t.due_date > today) },
    { id: "done", title: "Done", cls: "ok", items: tasks.filter(t => t.status === "done") },
  ].filter(g => g.items.length || g.id !== "done");
  async function start(t: any) { await patch(`/tasks/${t.id}`, { status: "in_progress" }); list.reload(); }
  return (
    <div>
      <div className="row between"><h1>Tasks</h1>{mgmt && <button className="btn sm" onClick={() => setCreate(true)}>New task</button>}</div>
      <div className="row" style={{ marginBottom: 10 }}>
        {mgmt && <select value={assignee} onChange={e => setAssignee(e.target.value)} style={{ width: "auto" }}><option value="">Everyone</option>{(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} style={{ width: "auto" }} /> Show done</label>
      </div>
      <Err e={list.error} />
      {!tasks.length && !list.loading && <div className="card"><Empty text="No tasks." /></div>}
      {groups.map(g => g.items.length ? (
        <div key={g.id} className={`card ${g.cls}`}>
          <h3>{g.title} ({g.items.length})</h3>
          <ul className="list">{g.items.map(t => (
            <li key={t.id}>
              <div className="main">
                <div className="title">{t.title} <span className={`chip ${t.priority === "high" ? "red" : t.priority === "low" ? "grey" : ""}`}>{t.priority}</span> {t.status === "blocked" && <span className="chip red">Blocked</span>}{t.status === "in_progress" && <span className="chip warn">In progress</span>}{t.recurrence && <span className="chip grey">{t.recurrence}</span>}</div>
                <div className="sub">Due {fmtDate(t.due_date)} · from {t.assigned_by_name}{mgmt ? ` · to ${t.assigned_to_name}` : ""}{t.company ? <> · <Link to={`/prospects/${t.prospect_id}`}>{t.company}</Link></> : null}</div>
                {t.description && <div className="sub">{t.description}</div>}
                {t.status === "done" && <div className="sub">✓ {t.completion_note} · {fmtDate(t.completed_at)}</div>}
                {t.status === "blocked" && <div className="sub">Reason: {t.blocked_reason}</div>}
              </div>
              {t.status !== "done" && (t.assigned_to === user.id || mgmt) && (
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  {t.status === "open" && <button className="btn sm muted" onClick={() => start(t)}>Start</button>}
                  <button className="btn sm ok" onClick={() => setModal({ task: t, mode: "done" })}>Done</button>
                  {t.status !== "blocked" && <button className="btn sm muted" onClick={() => setModal({ task: t, mode: "blocked" })}>Block</button>}
                </div>
              )}
            </li>
          ))}</ul>
        </div>
      ) : null)}
      {modal && <TaskDoneModal task={modal.task} mode={modal.mode} onClose={() => setModal(null)} onDone={list.reload} />}
      {create && <NewTaskModal users={(users.data ?? []).filter((u: any) => u.active !== 0)} onClose={() => setCreate(false)} onDone={list.reload} />}
    </div>
  );
}

export function NewTaskModal({ users, prospectId, onClose, onDone }: { users: any[]; prospectId?: number; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ title: "", description: "", assigned_to: users.find(u => u.role === "agent")?.id ?? users[0]?.id ?? "", due_date: todayPk(), priority: "normal", recurrence: "", prospect_id: prospectId ? String(prospectId) : "" });
  const [search, setSearch] = useState(""); const [matches, setMatches] = useState<any[]>([]); const [picked, setPicked] = useState<string>("");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s: any) => ({ ...s, [k]: v }));
  async function find(q: string) { setSearch(q); if (q.length < 2) { setMatches([]); return; } try { setMatches((await get(`/prospects?search=${encodeURIComponent(q)}`)).slice(0, 8)); } catch { /* ignore */ } }
  async function save() {
    setBusy(true); setErr(null);
    try { await post("/tasks", { title: f.title, description: f.description || undefined, assigned_to: Number(f.assigned_to), prospect_id: f.prospect_id ? Number(f.prospect_id) : null, due_date: f.due_date, priority: f.priority, recurrence: f.recurrence || null }); onDone(); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Modal title="New task" onClose={onClose}>
      <Field label="Title *"><input value={f.title} onChange={e => set("title", e.target.value)} autoFocus /></Field>
      <Field label="Description"><textarea value={f.description} onChange={e => set("description", e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="Assign to *"><Select value={String(f.assigned_to)} onChange={v => set("assigned_to", v)} options={users.map(u => ({ value: String(u.id), label: u.name }))} /></Field>
        <Field label="Due date *"><input type="date" value={f.due_date} onChange={e => set("due_date", e.target.value)} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={v => set("priority", v)} options={["high", "normal", "low"]} labelFn={label} /></Field>
        <Field label="Repeats"><Select value={f.recurrence} onChange={v => set("recurrence", v)} options={["daily", "weekly", "monthly"]} labelFn={label} allowEmpty="No" /></Field>
      </div>
      {!prospectId && (
        <Field label="Link to prospect (optional)">
          <input value={picked || search} onChange={e => { setPicked(""); set("prospect_id", ""); find(e.target.value); }} placeholder="Type a company name" />
          {matches.length > 0 && !picked && <div className="card" style={{ marginTop: 4, padding: 6 }}>{matches.map(m => <div key={m.id} style={{ padding: "6px 4px", cursor: "pointer" }} onClick={() => { set("prospect_id", String(m.id)); setPicked(m.company); setMatches([]); }}>{m.company} <span className="muted small">· {m.contact_name}</span></div>)}</div>}
        </Field>
      )}
      <Err e={err} />
      <button className="btn" disabled={busy || !f.title || !f.assigned_to || !f.due_date} onClick={save}>Create task</button>
    </Modal>
  );
}
