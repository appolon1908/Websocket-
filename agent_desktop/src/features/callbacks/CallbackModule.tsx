import { useMemo, useState } from "react";
import { Card } from "../../components/Card";

export type CallbackPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export interface DueCallback {
  id: string; customer: string; phoneMasked: string; campaign: string; reason: string;
  scheduledAt: string; customerTimezone: string; version: number; company?: string;
  lead?: string; lastCall?: string; lastDisposition?: string; lastNotes?: string;
  previousCallbacks?: number; openTasks?: number; recentCommunications?: string[]; crmUrl?: string;
}

function zonedIso(local: string, zone: string): string {
  if (!local) throw new Error("Date and time are required");
  const [date, time] = local.split("T"), [year, month, day] = date.split("-").map(Number), [hour, minute] = time.split(":").map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
  for (let index = 0; index < 2; index++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter(item => item.type !== "literal").map(item => [item.type, Number(item.value)]));
    guess += Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  }
  return new Date(guess).toISOString();
}

interface Props {
  onSave: (iso: string, reason: string, timezone: string, priority: CallbackPriority) => Promise<void>;
  due?: DueCallback;
  onCallNow?: (callback: DueCallback) => Promise<void>;
  onSnooze?: (callback: DueCallback, minutes: number) => Promise<void>;
}

export function CallbackModule({onSave, due, onCallNow, onSnooze}: Props) {
  const [when, setWhen] = useState(""), [timezone, setTimezone] = useState("America/New_York");
  const [reason, setReason] = useState(""), [priority, setPriority] = useState<CallbackPriority>("NORMAL"), [status, setStatus] = useState("");
  const agentTime = useMemo(() => when ? new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}).format(new Date(zonedIso(when, timezone))) : "—", [when, timezone]);
  const run = async (action: () => Promise<void>, success: string) => { try { await action(); setStatus(success); } catch (error) { setStatus(error instanceof Error ? error.message : "Callback action failed"); } };
  const save = () => run(() => onSave(zonedIso(when, timezone), reason, timezone, priority), "Callback scheduled");
  return <Card title="Callbacks">
    {due && <section className="callback-popup" role="alertdialog" aria-labelledby="callback-due-title" aria-describedby="callback-due-reason">
      <header><div><small>CALLBACK DUE</small><h3 id="callback-due-title">{due.customer}</h3></div><time>{new Intl.DateTimeFormat(undefined, {timeStyle: "short"}).format(new Date(due.scheduledAt))}</time></header>
      <p>{due.phoneMasked}</p><dl>
        <div><dt>Campaign</dt><dd>{due.campaign}</dd></div><div><dt>Reason</dt><dd id="callback-due-reason">{due.reason}</dd></div>
        <div><dt>Company / lead</dt><dd>{[due.company, due.lead].filter(Boolean).join(" · ") || "No linked lead"}</dd></div>
        <div><dt>Last call / disposition</dt><dd>{[due.lastCall, due.lastDisposition].filter(Boolean).join(" · ") || "No prior call"}</dd></div>
        <div><dt>Last notes</dt><dd>{due.lastNotes || "No prior notes"}</dd></div>
        <div><dt>Previous callbacks / open tasks</dt><dd>{due.previousCallbacks ?? 0} / {due.openTasks ?? 0}</dd></div>
        <div><dt>Recent communications</dt><dd>{due.recentCommunications?.join(" · ") || "None"}</dd></div>
      </dl><div className="callback-actions">
        <button onClick={() => onCallNow && void run(() => onCallNow(due), "Callback started")}>Call now</button>
        {due.crmUrl ? <a className="button secondary" href={due.crmUrl}>Open CRM</a> : <button className="secondary" disabled>Open CRM</button>}
        <button className="secondary" onClick={() => onSnooze && void run(() => onSnooze(due, 10), "Callback snoozed 10 minutes")}>Snooze 10 min</button>
        <button className="secondary" onClick={() => document.getElementById("callback-schedule-time")?.focus()}>Reschedule</button>
      </div>
    </section>}
    <h3>Schedule callback</h3>
    <label className="field">Customer date and time<input id="callback-schedule-time" type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} aria-describedby="callback-times" /></label>
    <label className="field">Customer timezone<select value={timezone} onChange={event => setTimezone(event.target.value)}><option>America/New_York</option><option>America/Santo_Domingo</option><option>America/Chicago</option><option>America/Denver</option><option>America/Los_Angeles</option><option>UTC</option></select></label>
    <div id="callback-times" className="callback-times"><span>Customer <b>{when || "—"} {timezone}</b></span><span>Agent <b>{agentTime}</b></span></div>
    <label className="field">Reason<input value={reason} onChange={event => setReason(event.target.value)} maxLength={256} /></label>
    <label className="field">Priority<select value={priority} onChange={event => setPriority(event.target.value as CallbackPriority)}><option>LOW</option><option>NORMAL</option><option>HIGH</option><option>URGENT</option></select></label>
    <button disabled={!when || !reason} onClick={() => void save()}>Schedule callback</button><span className="sr-status" role="status">{status}</span>
  </Card>;
}
