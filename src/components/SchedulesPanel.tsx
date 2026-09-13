import { useState } from "react";
import {
  validateScheduleInput,
  type Schedule,
  type ScheduleInput,
  type ThreadReuse,
} from "../lib/schedules";

interface SessionRef {
  session_id: string;
  title: string;
}

interface Props {
  schedules: Schedule[];
  sessions: SessionRef[];
  activeId: string | null;
  onCreate: (input: ScheduleInput) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
}

type TriggerKind = "once" | "cron";
type ReuseKind = "active" | "new" | "session";

function describeSchedule(s: Schedule): string {
  if (s.trigger.kind === "once") {
    return `once ${new Date(s.trigger.at).toLocaleString()}`;
  }
  return `cron ${s.trigger.cron}`;
}

function describeReuse(r: ThreadReuse, sessions: SessionRef[]): string {
  if (r.kind === "active") return "active thread";
  if (r.kind === "new") return "new thread";
  return sessions.find((s) => s.session_id === r.sessionId)?.title ?? "thread gone";
}

/**
 * US-9 automations panel (sidebar): create/list/enable/disable/delete
 * schedules plus a run-now button that enqueues a review entry immediately.
 * Due schedules never auto-send — everything lands in the review queue.
 */
export function SchedulesPanel({
  schedules,
  sessions,
  activeId,
  onCreate,
  onToggle,
  onDelete,
  onRunNow,
}: Props) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("once");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [reuseKind, setReuseKind] = useState<ReuseKind>("active");
  const [reuseSession, setReuseSession] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function submit(): void {
    const input: ScheduleInput = {
      name,
      instructions,
      trigger:
        triggerKind === "once"
          ? { kind: "once", at: at.length > 0 ? new Date(at).getTime() : NaN }
          : { kind: "cron", cron: cron.trim() },
      threadReuse:
        reuseKind === "session"
          ? { kind: "session", sessionId: reuseSession || activeId || "" }
          : { kind: reuseKind },
    };
    const err = validateScheduleInput(input);
    if (err !== null) {
      setFormError(err);
      return;
    }
    setFormError(null);
    onCreate(input);
    setName("");
    setInstructions("");
    setAt("");
  }

  return (
    <details className="schedules" aria-label="Automations">
      <summary className="schedules-summary">
        Automations
        {schedules.length > 0 && (
          <span className="schedules-count" title={`${schedules.length} schedule(s)`}>
            {schedules.length}
          </span>
        )}
      </summary>
      <div className="sched-form">
        <input
          type="text"
          placeholder="Name (e.g. morning standup)"
          aria-label="Schedule name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          placeholder="Instructions sent on approve"
          aria-label="Schedule instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
        />
        <div className="sched-row">
          <select
            aria-label="Trigger type"
            value={triggerKind}
            onChange={(e) => setTriggerKind(e.target.value as TriggerKind)}
          >
            <option value="once">one-shot</option>
            <option value="cron">cron</option>
          </select>
          {triggerKind === "once" ? (
            <input
              type="datetime-local"
              aria-label="One-shot date and time"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          ) : (
            <input
              type="text"
              aria-label="Cron expression"
              title="5 fields: minute hour day month weekday"
              placeholder="0 9 * * 1-5"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
          )}
        </div>
        <div className="sched-row">
          <select
            aria-label="Target thread"
            value={reuseKind}
            onChange={(e) => setReuseKind(e.target.value as ReuseKind)}
          >
            <option value="active">active thread</option>
            <option value="new">new thread</option>
            <option value="session">specific thread</option>
          </select>
          {reuseKind === "session" && (
            <select
              aria-label="Specific thread"
              value={reuseSession}
              onChange={(e) => setReuseSession(e.target.value)}
            >
              <option value="">choose…</option>
              {sessions.map((s) => (
                <option key={s.session_id} value={s.session_id}>
                  {s.title || s.session_id.slice(0, 8)}
                </option>
              ))}
            </select>
          )}
        </div>
        {formError !== null && <div className="error">{formError}</div>}
        <button type="button" onClick={submit}>
          Add schedule
        </button>
      </div>
      {schedules.length > 0 && (
        <ul className="sched-list">
          {schedules.map((s) => (
            <li key={s.id} className="sched-item" data-enabled={s.enabled}>
              <div className="sched-head">
                <strong>{s.name}</strong>
                <span className="muted" title={describeSchedule(s)}>
                  {describeSchedule(s)}
                </span>
              </div>
              <div className="muted sched-target">
                → {describeReuse(s.threadReuse, sessions)}
              </div>
              <div className="sched-actions">
                <button
                  type="button"
                  onClick={() => onToggle(s.id, !s.enabled)}
                  title={s.enabled ? "Disable schedule" : "Enable schedule"}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => onRunNow(s.id)}
                  title="Enqueue a review entry now"
                >
                  Run now
                </button>
                <button
                  type="button"
                  className="sched-danger"
                  onClick={() => onDelete(s.id)}
                  title="Delete schedule"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
