import { useState } from "react";
import {
  validateScheduleInput,
  type Schedule,
  type ScheduleInput,
  type ScheduleAuthorizationMode,
  type ThreadReuse,
} from "../lib/schedules";
import type { ScheduleRun } from "../lib/scheduleRuns";

interface SessionRef {
  session_id: string;
  title: string;
}

interface Props {
  schedules: Schedule[];
  runs: ScheduleRun[];
  sessions: SessionRef[];
  activeId: string | null;
  workspace: string | null;
  projectId: string | null;
  model: string;
  authorizationMode: ScheduleAuthorizationMode;
  onCreate: (input: ScheduleInput) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
}

type TriggerKind = "once" | "cron";
type ReuseKind = "active" | "new" | "session";

function describeSchedule(s: Schedule): string {
  if (s.trigger.kind === "once") {
    return `At ${new Date(s.trigger.at).toLocaleString()}`;
  }
  return `cron ${s.trigger.cron}`;
}

function describeReuse(r: ThreadReuse, sessions: SessionRef[]): string {
  if (r.kind === "active") return "Active conversation";
  if (r.kind === "new") return "New conversation";
  return (
    sessions.find((s) => s.session_id === r.sessionId)?.title ??
    "Conversation not found"
  );
}

function describeRunStatus(status: ScheduleRun["status"]): string {
  if (status === "completed") return "Dispatched";
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Queued";
}

/**
 * US-9 automations panel (sidebar): create/list/enable/disable/delete
 * schedules plus a run-now button. Ask mode creates a review entry; workspace
 * and YOLO modes dispatch automatically and surface the latest run records.
 */
export function SchedulesPanel({
  schedules,
  runs,
  sessions,
  activeId,
  workspace,
  projectId,
  model,
  authorizationMode,
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
      workspace: workspace ?? undefined,
      projectId: projectId ?? undefined,
      model,
      authorizationMode,
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
    <section className="schedules" aria-label="Automations">
      <h2 className="schedules-summary">
        New automation
        {schedules.length > 0 && (
          <span
            className="schedules-count"
            title={`${schedules.length} schedule(s)`}
          >
            {schedules.length}
          </span>
        )}
      </h2>
      <div className="sched-form">
        <input
          type="text"
          placeholder="Name (e.g. daily review)"
          aria-label="Automation name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          placeholder="Instructions to run after approval"
          aria-label="Instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
        />
        <div className="sched-row">
          <select
            aria-label="Frequency"
            value={triggerKind}
            onChange={(e) => setTriggerKind(e.target.value as TriggerKind)}
          >
            <option value="once">Once</option>
            <option value="cron">Recurring (cron)</option>
          </select>
          {triggerKind === "once" ? (
            <input
              type="datetime-local"
              aria-label="Date and time"
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
            aria-label="Target conversation"
            value={reuseKind}
            onChange={(e) => setReuseKind(e.target.value as ReuseKind)}
          >
            <option value="active">Active conversation</option>
            <option value="new">New conversation</option>
            <option value="session">Existing conversation</option>
          </select>
          {reuseKind === "session" && (
            <select
              aria-label="Existing conversation"
              value={reuseSession}
              onChange={(e) => setReuseSession(e.target.value)}
            >
              <option value="">Choose…</option>
              {sessions.map((s) => (
                <option key={s.session_id} value={s.session_id}>
                  {s.title || s.session_id.slice(0, 8)}
                </option>
              ))}
            </select>
          )}
        </div>
        {formError !== null && <div className="error">{formError}</div>}
        <button type="button" className="primary" onClick={submit}>
          Create automation
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
                  title="Run this automation now"
                >
                  Run
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
      {runs.length > 0 && (
        <div className="schedule-runs" aria-label="Recent automation runs">
          <h3>Recent runs</h3>
          <ul className="sched-list">
            {runs.slice(-8).reverse().map((run) => (
              <li key={run.id} className="sched-item schedule-run" data-status={run.status}>
                <div className="sched-head">
                  <strong>{run.scheduleName}</strong>
                  <span className="run-status">{describeRunStatus(run.status)}</span>
                </div>
                <span className="muted">{new Date(run.createdAt).toLocaleString()} · {run.sessionId ? "conversation started" : "dispatching"}</span>
                {run.error && <small className="error">{run.error}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
