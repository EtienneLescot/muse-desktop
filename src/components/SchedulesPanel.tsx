import { useMemo, useState } from "react";
import {
  validateScheduleInput,
  type Schedule,
  type ScheduleInput,
  type ScheduleAuthorizationMode,
  type ScheduleMissedPolicy,
  type ThreadReuse,
} from "../lib/schedules";
import type { ScheduleRun } from "../lib/scheduleRuns";
import type { MuseNotification, NotificationPermission } from "../lib/notifications";

interface SessionRef {
  session_id: string;
  title: string;
}

interface Props {
  schedules: Schedule[];
  runs: ScheduleRun[];
  notifications: MuseNotification[];
  notificationPermission: NotificationPermission;
  notificationsMuted: boolean;
  unreadNotifications: number;
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
  onCancelRun: (id: string) => void;
  onOpenRun: (run: ScheduleRun) => void;
  onMarkRunRead: (id: string) => void;
  onSetRunArchived: (id: string, archived: boolean) => void;
  onRetryRunNow: (id: string) => void;
  onEnableNotifications: () => Promise<NotificationPermission>;
  onSetNotificationsMuted: (muted: boolean) => void;
  onMarkNotificationRead: (id: string) => void;
  onOpenNotification: (notification: MuseNotification) => void;
}

type TriggerKind = "once" | "cron";
type ReuseKind = "active" | "new" | "session";
type RunFilter = "all" | "unread" | "queued" | "running" | "completed" | "failed" | "archived";

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
  if (status === "completed") return "Completed";
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Queued";
}

function describeNotificationTime(createdAt: number): string {
  return new Date(createdAt).toLocaleString();
}

/**
 * US-9 automations panel (sidebar): create/list/enable/disable/delete
 * schedules plus a run-now button. Ask mode creates a review entry; workspace
 * and YOLO modes dispatch automatically and surface the latest run records.
 */
export function SchedulesPanel({
  schedules,
  runs,
  notifications,
  notificationPermission,
  notificationsMuted,
  unreadNotifications,
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
  onCancelRun,
  onOpenRun,
  onMarkRunRead,
  onSetRunArchived,
  onRetryRunNow,
  onEnableNotifications,
  onSetNotificationsMuted,
  onMarkNotificationRead,
  onOpenNotification,
}: Props) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("once");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [reuseKind, setReuseKind] = useState<ReuseKind>("active");
  const [reuseSession, setReuseSession] = useState("");
  const [missedPolicy, setMissedPolicy] = useState<ScheduleMissedPolicy>("latest");
  const [formError, setFormError] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<RunFilter>("all");

  const visibleRuns = useMemo(() => runs
    .filter((run) => {
      if (runFilter === "archived") return run.archived === true;
      if (run.archived === true) return false;
      if (runFilter === "all") return true;
      if (runFilter === "unread") return run.unread === true;
      return run.status === runFilter;
    })
    .slice(-8)
    .reverse(), [runFilter, runs]);

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
      missedPolicy,
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
          placeholder="Instructions for this automation"
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
        {triggerKind === "cron" && (
          <label className="sched-policy">
            <span>When the app wakes late</span>
            <select
              aria-label="Missed run policy"
              value={missedPolicy}
              onChange={(e) => setMissedPolicy(e.target.value as ScheduleMissedPolicy)}
            >
              <option value="latest">Run the latest missed occurrence</option>
              <option value="skip">Skip missed occurrences</option>
            </select>
          </label>
        )}
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
          <div className="schedule-notifications-head">
            <h3>Recent runs</h3>
            <select
              className="run-filter"
              aria-label="Filter automation runs"
              value={runFilter}
              onChange={(e) => setRunFilter(e.target.value as RunFilter)}
            >
              <option value="all">Active</option>
              <option value="unread">Unread</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          {visibleRuns.length === 0 ? (
            <p className="muted notification-empty">No runs match this filter.</p>
          ) : <ul className="sched-list">
            {visibleRuns.map((run) => (
              <li key={run.id} className="sched-item schedule-run" data-status={run.status}>
                <div className="sched-head">
                  <strong>{run.scheduleName}</strong>
                  {run.unread && <span className="run-unread">New</span>}
                  <span className="run-status">{describeRunStatus(run.status)}</span>
                </div>
                <span className="muted">
                  {new Date(run.createdAt).toLocaleString()} · {run.sessionId ? "conversation started" : "dispatching"}
                  {run.nextRetryAt ? ` · retry at ${new Date(run.nextRetryAt).toLocaleTimeString()}` : ""}
                </span>
                {run.resultPreview && <span className="run-preview">{run.resultPreview}</span>}
                {run.error && <small className="error">{run.error}</small>}
                <div className="sched-actions">
                  {run.sessionId && (
                    <button type="button" onClick={() => onOpenRun(run)} title="Open conversation">
                      Open conversation
                    </button>
                  )}
                  {run.unread && (
                    <button type="button" onClick={() => onMarkRunRead(run.id)} title="Mark run as read">
                      Mark read
                    </button>
                  )}
                  {run.status === "queued" && run.nextRetryAt !== undefined && (
                    <>
                      <button type="button" onClick={() => onRetryRunNow(run.id)} title="Retry this run now">
                        Retry now
                      </button>
                      <button type="button" onClick={() => onCancelRun(run.id)} title="Cancel this retry">
                        Cancel retry
                      </button>
                    </>
                  )}
                  {run.status === "failed" && (run.attempt ?? 1) < 3 && (
                    <button type="button" onClick={() => onRetryRunNow(run.id)} title="Retry this run now">
                      Retry now
                    </button>
                  )}
                  {run.archived === true ? (
                    <button type="button" onClick={() => onSetRunArchived(run.id, false)} title="Restore this run">
                      Restore
                    </button>
                  ) : (
                    <button type="button" onClick={() => onSetRunArchived(run.id, true)} title="Archive this run">
                      Archive
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>}
        </div>
      )}
      <div className="schedule-notifications" aria-label="Automation notifications">
        <div className="schedule-notifications-head">
          <h3>Notifications</h3>
          {unreadNotifications > 0 && <span className="schedules-count">{unreadNotifications}</span>}
        </div>
        {notificationPermission === "granted" ? (
          <div className="notification-permission-row">
            <p className="muted notification-permission">Desktop notifications enabled.</p>
            <button
              type="button"
              className="notification-mute"
              aria-pressed={notificationsMuted}
              onClick={() => onSetNotificationsMuted(!notificationsMuted)}
            >
              {notificationsMuted ? "Unmute desktop alerts" : "Mute desktop alerts"}
            </button>
          </div>
        ) : notificationPermission === "unsupported" ? (
          <p className="muted notification-permission">Desktop notifications are unavailable here. In-app alerts remain available.</p>
        ) : (
          <button type="button" className="notification-enable" onClick={() => void onEnableNotifications()}>
            {notificationPermission === "denied" ? "Enable notifications in system settings" : "Enable desktop notifications"}
          </button>
        )}
        {notifications.length === 0 ? (
          <p className="muted notification-empty">Completed and failed automations will appear here.</p>
        ) : (
          <ul className="notification-list">
            {notifications.slice(-6).reverse().map((notification) => (
              <li key={notification.id} className="notification-item" data-unread={notification.unread === true}>
                <div className="notification-item-head">
                  <strong className="notification-title">{notification.title}</strong>
                  {notification.unread && <span className="run-unread">New</span>}
                </div>
                <span className="notification-body">{notification.body}</span>
                <span className="muted notification-meta">{describeNotificationTime(notification.createdAt)}</span>
                <div className="sched-actions">
                  {notification.sessionId && (
                    <button type="button" onClick={() => onOpenNotification(notification)} title="Open conversation">
                      Open conversation
                    </button>
                  )}
                  {notification.unread && (
                    <button type="button" onClick={() => onMarkNotificationRead(notification.id)} title="Mark notification as read">
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
