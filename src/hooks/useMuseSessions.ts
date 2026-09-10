import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../lib/env";
import {
  appendLog,
  dropLog,
  loadActiveId,
  loadLog,
  loadSessions,
  loadWorkspace,
  newId,
  saveActiveId,
  saveLog,
  saveSessions,
  saveWorkspace,
  type LogEntry,
  type LogRole,
  type StoredSession,
} from "../lib/persist";

/** One session: persisted metadata + live running flag. */
export interface MuseSession extends StoredSession {
  running: boolean;
}

/** Raw event relayed by the Rust supervisor (always tagged by session_id). */
export interface MuseEvent {
  session_id: string;
  kind: string;
  payload: string;
}

/** One buffered backend event with its sequence number (poll transport). */
interface DrainedEvent extends MuseEvent {
  seq: number;
}

interface PollResult {
  head: number;
  events: DrainedEvent[];
}

/** Poll cadence: prompt enough for streaming text, cheap enough to be boring. */
const POLL_MS = 300;

export interface ApprovalChoice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
}

export interface ApprovalRequest {
  session_id: string;
  request_id: string;
  summary: string;
  toolName: string;
  choices: ApprovalChoice[];
}

interface UseMuseSessions {
  sessions: MuseSession[];
  activeId: string | null;
  logs: Record<string, LogEntry[]>;
  activeLog: LogEntry[];
  approvals: ApprovalRequest[];
  activeApprovals: ApprovalRequest[];
  workspace: string | null;
  setWorkspace: (path: string) => void;
  setActive: (id: string | null) => void;
  startSession: () => Promise<void>;
  sendInput: (sessionId: string, text: string) => Promise<void>;
  approve: (sessionId: string, approvalId: string, choiceId: string) => Promise<void>;
  cancelSession: (sessionId: string) => Promise<void>;
  killSession: (sessionId: string) => Promise<void>;
  error: string | null;
  /** TEMPORARY dev diagnosis: backend events received by this window. */
  evtCount: number;
  /** True when the Tauri backend is unreachable (plain-browser preview). */
  backendMissing: boolean;
}

interface BackendSessionMeta {
  session_id: string;
  workspace: string;
  running: boolean;
}

/** Status kinds that mean the child is no longer producing output. */
const STOPPED_KINDS = new Set([
  "cancelled",
  "completed",
  "stopped",
  "exited",
  "host_exited",
  "error",
  "turn_end",
  "idle",
]);

/** Status kinds that mean the child is (still) running. */
const RUNNING_KINDS = new Set(["started", "running", "created", "turn_start"]);

function shortTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 42 ? `${oneLine.slice(0, 42)}…` : oneLine;
}

/** Best-effort parse of a subagent payload: JSON or tagged/plain text. */
function parseSubagent(payload: string): { agentId: string; text: string } {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const agentId =
        (typeof obj.agent_id === "string" && obj.agent_id) ||
        (typeof obj.id === "string" && obj.id) ||
        (typeof obj.name === "string" && obj.name) ||
        "agent";
      const text =
        (typeof obj.text === "string" && obj.text) ||
        (typeof obj.chunk === "string" && obj.chunk) ||
        (typeof obj.output === "string" && obj.output) ||
        payload;
      return { agentId, text };
    } catch {
      // fall through to plain text
    }
  }
  const m = /^\/\*([^*]+)\*\/\s*([\s\S]*)$/.exec(trimmed) ?? /^([A-Za-z0-9_-]{1,32}):\s+([\s\S]+)$/.exec(trimmed);
  if (m) return { agentId: m[1].trim() || "agent", text: m[2] };
  return { agentId: "agent", text: payload };
}

/**
 * Parse a stream-chunk payload: JSON `{itemId, text}` from the supervisor, or
 * raw text from older payloads. Never throws.
 */
function parseChunk(payload: string): { itemId?: string; text: string } {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.text === "string") {
        const itemId = typeof obj.itemId === "string" ? obj.itemId : undefined;
        return { itemId, text: obj.text };
      }
    } catch {
      // fall through to raw text
    }
  }
  return { text: payload };
}

/** Index of the last open entry matching role (+agentId), -1 when none. */
function lastOpenIndex(
  log: LogEntry[],
  role: LogRole,
  agentId?: string,
): number {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.open && e.role === role && (agentId === undefined || e.agentId === agentId)) return i;
  }
  return -1;
}

/** Best-effort parse of a tool-request payload into id + summary + choices. */
function parseApproval(sessionId: string, payload: string): ApprovalRequest {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const requestId =
        (typeof obj.request_id === "string" && obj.request_id) ||
        (typeof obj.approvalId === "string" && obj.approvalId) ||
        (typeof obj.id === "string" && obj.id) ||
        trimmed;
      const summary =
        (typeof obj.summary === "string" && obj.summary) ||
        (typeof obj.command === "string" && obj.command) ||
        (typeof obj.description === "string" && obj.description) ||
        trimmed;
      const toolName = typeof obj.toolName === "string" ? obj.toolName : "tool";
      const rawChoices = Array.isArray(obj.choices) ? obj.choices : [];
      const choices: ApprovalChoice[] = rawChoices
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => ({
          choiceId: typeof c.choiceId === "string" ? c.choiceId : "",
          label: typeof c.label === "string" ? c.label : "?",
          decision: typeof c.decision === "string" ? c.decision : "",
          scope: typeof c.scope === "string" ? c.scope : "",
        }))
        .filter((c) => c.choiceId.length > 0);
      return { session_id: sessionId, request_id: requestId, summary, toolName, choices };
    } catch {
      // fall through
    }
  }
  return { session_id: sessionId, request_id: trimmed, summary: trimmed, toolName: "tool", choices: [] };
}

/**
 * Session-multiplexing hook.
 *
 * - Session list + active session, persisted to localStorage and merged
 *   with the supervisor's `restore_sessions` on boot.
 * - Per-session append-only log (user input, assistant stream chunks
 *   coalesced into one open entry, sub-agent blocks grouped by agent id,
 *   tool/system entries), persisted per session and restored on boot.
 * - Invokes `start_session` / `send_input` / `approve` / `cancel_session` /
 *   `kill_session` with camelCase args (Tauri `#[command]` default), and
 *   subscribes to `output` / `subagent_event` / `tool_request` / `status`.
 *   (Event payloads stay snake_case: they are Rust-serde JSON, not args.)
 */
export function useMuseSessions(): UseMuseSessions {
  const [sessions, setSessions] = useState<MuseSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [workspace, setWorkspaceState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // TEMPORARY dev diagnosis: counts backend events received by this window.
  const [evtCount, setEvtCount] = useState(0);
  const [backendMissing, setBackendMissing] = useState<boolean>(!isTauriRuntime());

  // Boot: restore local persistence first (instant history), then merge
  // the supervisor's live table, then poll the backend event buffer.
  // (Polling, not `listen` push: push subscriptions resolved yet never fired
  // in one environment, while `invoke` always worked — same broadcast
  // semantics, boring transport.)
  useEffect(() => {
    // No once-guard here: React StrictMode (dev) mounts, unmounts, and
    // remounts — a "booted" ref would skip the second (real) setup forever
    // after cleanup cancelled the first. Teardown below makes re-setup safe.
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let cursor = 0;

    const stored = loadSessions();
    const storedLogs: Record<string, LogEntry[]> = {};
    for (const s of stored) storedLogs[s.session_id] = loadLog(s.session_id);
    const storedWorkspace = loadWorkspace();
    const storedActive = loadActiveId();
    if (!cancelled) {
      // Mark restored sessions stopped: sidecar children do not survive
      // an app restart; the user relaunches by sending new input.
      setSessions(stored.map((s) => ({ ...s, running: false })));
      setLogs(storedLogs);
      setWorkspaceState(storedWorkspace);
      setActiveId(
        storedActive && stored.some((s) => s.session_id === storedActive)
          ? storedActive
          : (stored[0]?.session_id ?? null),
      );
    }

    // Outside the Tauri webview there is no backend: local history stays
    // visible, backend calls are skipped (their error banners would lie).
    if (!isTauriRuntime()) {
      setBackendMissing(true);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const restored = await invoke<BackendSessionMeta[]>("restore_sessions");
        if (cancelled) return;
        setSessions((cur) => {
          const next = [...cur];
          for (const meta of restored) {
            const i = next.findIndex((s) => s.session_id === meta.session_id);
            if (i >= 0) {
              next[i] = { ...next[i], workspace: meta.workspace, running: meta.running };
            } else {
              next.push({
                session_id: meta.session_id,
                workspace: meta.workspace,
                title: `Session ${meta.session_id.slice(0, 8)}`,
                createdAt: Date.now(),
                running: meta.running,
              });
            }
          }
          return next;
        });
        setActiveId((cur) => {
          if (cur !== null) return cur;
          return restored[0]?.session_id ?? null;
        });
      } catch (e) {
        if (!cancelled) setError(`restore_sessions failed: ${String(e)}`);
      }
      // Start polling from the current head: no replay of ancient history,
      // live events only. Each response advances the cursor past what we fed.
      try {
        const head = await invoke<PollResult>("poll_events", {});
        if (cancelled) return;
        cursor = head.head;
      } catch (err) {
        if (!cancelled) setError(`event poll failed: ${String(err)}`);
        return;
      }
      const tick = async () => {
        try {
          const res = await invoke<PollResult>("poll_events", { since: cursor });
          if (cancelled) return;
          cursor = res.head;
          for (const e of res.events) handleEvent(e);
        } catch (err) {
          if (!cancelled) setError(`event poll failed: ${String(err)}`);
        }
      };
      timer = setInterval(() => void tick(), POLL_MS);
      void tick();
    })();

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write-through persistence.
  useEffect(() => {
    saveSessions(sessions.map(({ running: _r, ...rest }) => rest));
  }, [sessions]);

  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  useEffect(() => {
    // null means "not loaded yet" (there is no clear-workspace action),
    // so never persist it over the stored value.
    if (workspace !== null) saveWorkspace(workspace);
  }, [workspace]);

  /** Append entries to a session log (state + disk), creating the session row if needed. */
  function pushLog(sessionId: string, entries: LogEntry[]): void {
    if (entries.length === 0) return;
    setLogs((cur) => ({ ...cur, [sessionId]: [...(cur[sessionId] ?? []), ...entries] }));
    appendLog(sessionId, entries);
  }

  function ensureSessionRow(sessionId: string, ws: string | null): void {
    setSessions((cur) => {
      if (cur.some((s) => s.session_id === sessionId)) return cur;
      return [
        ...cur,
        {
          session_id: sessionId,
          workspace: ws ?? "",
          title: `Session ${sessionId.slice(0, 8)}`,
          createdAt: Date.now(),
          running: true,
        },
      ];
    });
  }

  function closeOpenBlocks(sessionId: string, itemId?: string): void {
    setLogs((cur) => {
      const log = cur[sessionId];
      if (!log || !log.some((e) => e.open)) return cur;
      // With an item id, close only that block: concurrent items keep
      // streaming into their own entries. Without one (turn end), close all.
      const next = log.map((e) =>
        e.open && (itemId === undefined || e.itemId === itemId)
          ? { ...e, open: false }
          : e,
      );
      saveLog(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  function handleEvent(evt: MuseEvent): void {
    const { session_id: sid, kind, payload } = evt;
    setEvtCount((c) => c + 1);
    if (!sid) return;
    if (kind === "output") {
      ensureSessionRow(sid, null);
      const { itemId, text } = parseChunk(payload);
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        // Coalesce into the last open assistant entry, not merely the last
        // entry: an interleaved subagent/tool block must not fragment the turn.
        const i = lastOpenIndex(log, "assistant");
        let next: LogEntry[];
        if (i >= 0) {
          const merged = { ...log[i], text: log[i].text + text, itemId: itemId ?? log[i].itemId };
          next = [...log.slice(0, i), merged, ...log.slice(i + 1)];
        } else {
          next = [
            ...log,
            { id: newId(), ts: Date.now(), role: "assistant" as LogRole, text, itemId, open: true },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
      return;
    }
    if (kind === "subagent_event") {
      ensureSessionRow(sid, null);
      const { agentId, text } = parseSubagent(payload);
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        const i = lastOpenIndex(log, "subagent", agentId);
        let next: LogEntry[];
        if (i >= 0) {
          next = [...log.slice(0, i), { ...log[i], text: log[i].text + text }, ...log.slice(i + 1)];
        } else {
          next = [
            ...log,
            { id: newId(), ts: Date.now(), role: "subagent" as LogRole, text, agentId, open: true },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      return;
    }
    if (kind === "item_done") {
      // Close exactly the completed item; other open blocks keep streaming.
      ensureSessionRow(sid, null);
      let itemId: string | undefined;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (typeof obj.itemId === "string" && obj.itemId.length > 0) itemId = obj.itemId;
      } catch {
        // unparseable payload: close all, as before
      }
      closeOpenBlocks(sid, itemId);
      return;
    }
    if (kind === "tool_request") {
      ensureSessionRow(sid, null);
      const req = parseApproval(sid, payload);
      setApprovals((cur) =>
        cur.some((a) => a.session_id === sid && a.request_id === req.request_id)
          ? cur
          : [...cur, req],
      );
      pushLog(sid, [
        { id: newId(), ts: Date.now(), role: "tool", text: `Approval requested: ${req.summary}` },
      ]);
      closeOpenBlocks(sid);
      return;
    }
    // status (and any future kinds): record + reflect liveness.
    ensureSessionRow(sid, null);
    const lower = kind.toLowerCase();
    if (RUNNING_KINDS.has(lower)) {
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
    } else if (STOPPED_KINDS.has(lower)) {
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: false } : s)),
      );
    }
    if (payload) {
      pushLog(sid, [{ id: newId(), ts: Date.now(), role: "system", text: `[${kind}] ${payload}` }]);
    }
    closeOpenBlocks(sid);
  }

  const setWorkspace = useCallback((path: string) => {
    setWorkspaceState(path);
    saveWorkspace(path);
    // Rust holds the pick as source of truth too (fire-and-forget: a stale
    // start_session arg can then still resolve server-side).
    void invoke<string>("set_workspace", { path }).catch(() => {});
  }, []);

  const setActive = useCallback((id: string | null) => setActiveId(id), []);

  const startSession = useCallback(async () => {
    try {
      setError(null);
      // Live React state first: localStorage writes are best-effort and may
      // silently fail, which previously enabled the buttons while sending
      // workspace_path=null ("no workspace selected" from the backend).
      const ws = workspace ?? loadWorkspace() ?? undefined;
      if (ws === undefined) {
        setError("Pick a workspace folder first.");
        return;
      }
      const meta = await invoke<BackendSessionMeta>("start_session", {
        workspacePath: ws,
      });
      const record: MuseSession = {
        session_id: meta.session_id,
        workspace: meta.workspace,
        title: `Session ${meta.session_id.slice(0, 8)}`,
        createdAt: Date.now(),
        running: meta.running,
      };
      setSessions((cur) => [...cur, record]);
      setLogs((cur) => (cur[meta.session_id] ? cur : { ...cur, [meta.session_id]: [] }));
      setActiveId(meta.session_id);
    } catch (e) {
      setError(`start_session failed: ${String(e)}`);
    }
  }, [workspace]);

  const sendInput = useCallback(
    async (sessionId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      closeOpenBlocks(sessionId);
      pushLog(sessionId, [{ id: newId(), ts: Date.now(), role: "user", text: trimmed }]);
      setSessions((cur) =>
        cur.map((s) =>
          s.session_id === sessionId
            ? {
                ...s,
                title: s.title.startsWith("Session ") ? shortTitle(trimmed) : s.title,
                running: true,
              }
            : s,
        ),
      );
      try {
        setError(null);
        await invoke("send_input", { sessionId, text: trimmed });
      } catch (e) {
        setError(`send_input failed: ${String(e)}`);
        setSessions((cur) =>
          cur.map((s) => (s.session_id === sessionId ? { ...s, running: false } : s)),
        );
      }
    },
    [],
  );

  const approve = useCallback(
    async (sessionId: string, approvalId: string, choiceId: string) => {
      try {
        setError(null);
        await invoke("approve", {
          sessionId,
          approvalId,
          choiceId,
        });
        setApprovals((cur) =>
          cur.filter(
            (a) => !(a.session_id === sessionId && a.request_id === approvalId),
          ),
        );
        pushLog(sessionId, [
          {
            id: newId(),
            ts: Date.now(),
            role: "system",
            text: `Decision sent: ${choiceId} (${approvalId})`,
          },
        ]);
      } catch (e) {
        setError(`approve failed: ${String(e)}`);
      }
    },
    [],
  );

  const cancelSession = useCallback(async (sessionId: string) => {
    try {
      setError(null);
      await invoke("cancel_session", { sessionId });
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sessionId ? { ...s, running: false } : s)),
      );
      closeOpenBlocks(sessionId);
      pushLog(sessionId, [
        { id: newId(), ts: Date.now(), role: "system", text: "Session cancelled." },
      ]);
    } catch (e) {
      setError(`cancel_session failed: ${String(e)}`);
    }
  }, []);

  const killSession = useCallback(
    async (sessionId: string) => {
      try {
        setError(null);
        await invoke("kill_session", { sessionId });
      } catch (e) {
        setError(`kill_session failed: ${String(e)}`);
        return;
      }
      setSessions((cur) => cur.filter((s) => s.session_id !== sessionId));
      setLogs((cur) => {
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      dropLog(sessionId);
      setApprovals((cur) => cur.filter((a) => a.session_id !== sessionId));
      setActiveId((cur) => {
        if (cur !== sessionId) return cur;
        const remaining = loadSessions().filter((s) => s.session_id !== sessionId);
        return remaining[0]?.session_id ?? null;
      });
    },
    [],
  );

  const activeLog = (activeId !== null && logs[activeId]) || [];
  const activeApprovals = approvals.filter((a) => a.session_id === activeId);

  return {
    sessions,
    activeId,
    logs,
    activeLog,
    approvals,
    activeApprovals,
    workspace,
    backendMissing,
    setWorkspace,
    setActive,
    startSession,
    sendInput,
    approve,
    cancelSession,
    killSession,
    error,
    evtCount,
  };
}
