import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../lib/env";
import {
  appendLog,
  dropLog,
  loadActiveId,
  loadLog,
  loadSessions,
  loadTombstones,
  loadWorkspace,
  newId,
  saveActiveId,
  saveLog,
  saveSessions,
  saveTombstones,
  saveWorkspace,
  type LogEntry,
  type LogRole,
  type StoredSession,
} from "../lib/persist";
// Input-prompt helpers live in ../lib/input (dependency-free, unit-tested).
// Only parseInputRequest + the locally used types are imported; the rest is
// re-exported below for consumers (InputPanel).
import {
  parseInputRequest,
  type InputAnswer,
  type InputRequest,
} from "../lib/input";
// US-15 persistent approval allowlist: matching + most-restrictive-wins
// resolution live in ../lib/allowlist (dependency-free, unit-tested);
// storage + rule types extend ../lib/persist.
import {
  addAllowRule,
  defaultPatternFor,
  loadAllowlist,
  removeAllowRule,
  resolveApproval,
  saveAllowlist,
  setAllowRuleDecision,
  type AllowDecision,
  type AllowRule,
  type ResolvedApproval,
} from "../lib/allowlist";
export type { AllowDecision, AllowRule, ResolvedApproval } from "../lib/allowlist";
export type {
  InputAnswer,
  InputOption,
  InputPicks,
  InputQuestion,
  InputRequest,
} from "../lib/input";
export { buildAnswers, parseInputRequest } from "../lib/input";
// Serialized poll chain: the periodic tick and the immediate post-send kick
// share it so two drains never overlap with the same cursor (overlap would
// deliver the same buffered events twice and duplicate streamed text).
import { createPollChain, enqueuePoll } from "../lib/poll";
// US-10 reflexive phase: kind→phase mapping + placeholder entries, so the
// stream shows "réflexion…" synchronously on send and on `item/started`
// even before the first delta lands.
import {
  dropEmptyPlaceholders,
  isItemStartKind,
  isRunningKind,
  isStoppedKind,
  isSubagentItemKind,
  upsertReflexivePlaceholder,
} from "../lib/phase";
// Sub-agent payload parsing/formatting (US-6 controls): pure, unit-tested.
import {
  formatDrilldown,
  formatSubagentResult,
  parseSubagentPayload,
} from "../lib/subagent";
// US-4 compaction: local extractive summaries (no model call), entry-count
// thresholds (the muse token threshold is unsourced — see compact.ts).
import {
  buildSummary,
  COMPACT_AUTO_ENTRIES,
  dropSummary,
  formatSummaryText,
  isCompactCommand,
  loadSummary,
  saveSummary,
  type ThreadSummary,
} from "../lib/compact";
// US-7 fan-out: `/fanout` becomes one parent-turn prompt (no spawn
// endpoint exists); children surface as `subagent` entries as usual.
import {
  buildFanoutPrompt,
  fanoutQueueNote,
  parseFanoutCommand,
} from "../lib/fanout";
// US-5 thread archiving flag helper (pure, unit-tested).
import { withArchivedFlag } from "../lib/threads";


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

/**
 * Poll cadence: fast while a turn streams (near-live text), slow at idle.
 * The host emits line-frames as they arrive; 150ms keeps chunking invisible.
 */
const POLL_FAST_MS = 150;
const POLL_SLOW_MS = 1000;

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
  /** US-15: persisted allowlist rules + effective decision per request. */
  allowlist: AllowRule[];
  allowDecisionFor: (approval: ApprovalRequest) => ResolvedApproval;
  /** Approve, then memorize an allow rule (command pattern + choice scope). */
  rememberApproval: (approval: ApprovalRequest, choiceId: string) => Promise<void>;
  revokeAllowRule: (id: string) => void;
  setAllowRuleDecision: (id: string, decision: AllowDecision) => void;
  answerInput: (sessionId: string, inputId: string, answers: InputAnswer[]) => Promise<void>;
  cancelInput: (sessionId: string, inputId: string) => Promise<void>;
  inputRequests: InputRequest[];
  activeInputRequests: InputRequest[];
  cancelSession: (sessionId: string) => Promise<void>;
  killSession: (sessionId: string) => Promise<void>;
  /** US-4: summaries by source session id (a stored summary = compacted). */
  summaries: Record<string, ThreadSummary>;
  /** US-4: build the local summary now (`/compact` manual path / button). */
  compactSession: (sessionId: string) => void;
  /** US-4: open a fresh thread pre-filled with the source summary. */
  newFromSummary: (sourceId: string) => Promise<void>;
  /** US-4: prefill text for the composer after `newFromSummary`. */
  prefill: string | null;
  clearPrefill: () => void;
  /** US-5: move a thread to the archived list (persisted flag). */
  archiveSession: (sessionId: string) => void;
  /** US-5: move a thread back to the active list (persisted flag). */
  restoreSession: (sessionId: string) => void;
  /** US-6 controls: one hook method per `subagent/*` MSP method. */
  subagentInterrupt: (sessionId: string, agentId: string) => Promise<void>;
  subagentStop: (sessionId: string, agentId: string) => Promise<void>;
  subagentResume: (sessionId: string, agentId: string) => Promise<void>;
  subagentFollowup: (sessionId: string, agentId: string, task: string) => Promise<void>;
  /** `subagent/readResult`: formatted result text, or null on error. */
  subagentReadResult: (sessionId: string, agentId: string) => Promise<string | null>;
  /** Drill-down via `session/read`; explicit error when unavailable. */
  subagentDrilldown: (sessionId: string, childSessionId: string | undefined) => Promise<string | null>;
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

/** Status-kind mapping lives in ../lib/phase (unit-tested, US-10). */

function shortTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 42 ? `${oneLine.slice(0, 42)}…` : oneLine;
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
 *   `kill_session` / `subagent_*` with camelCase args (Tauri `#[command]`
 *   default), and
 *   subscribes to `output` / `subagent_event` / `tool_request` / `status`.
 *   (Event payloads stay snake_case: they are Rust-serde JSON, not args.)
 */
export function useMuseSessions(): UseMuseSessions {
  const [sessions, setSessions] = useState<MuseSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  // US-15 allowlist: restored once (survives restarts via localStorage),
  // written through on every change.
  const [allowlist, setAllowlist] = useState<AllowRule[]>(() => loadAllowlist());
  const [inputRequests, setInputRequests] = useState<InputRequest[]>([]);
  const [workspace, setWorkspaceState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // US-4: local thread summaries (mirror of localStorage) + composer prefill
  // after `newFromSummary`.
  const [summaries, setSummaries] = useState<Record<string, ThreadSummary>>({});
  const [prefill, setPrefill] = useState<string | null>(null);
  // Latest logs for the render-detached compaction paths (`/compact` inside
  // sendInput, auto-compact effect): refs stay fresh where useCallback deps
  // would go stale.
  const logsRef = useRef<Record<string, LogEntry[]>>({});
  logsRef.current = logs;
  // TEMPORARY dev diagnosis: counts backend events received by this window.
  const [evtCount, setEvtCount] = useState(0);
  const [backendMissing, setBackendMissing] = useState<boolean>(!isTauriRuntime());
  // Mirror of "any session running", read by the poll loop to pick cadence.
  // Plain ref (not state): the loop lives outside render, StrictMode-safe.
  const runningRef = useRef(false);
  // Shared poll cursor: the periodic tick and the post-send kick both drain
  // from here, so a kick never replays what the tick already fed.
  const cursorRef = useRef(0);
  // One serialized drain chain (tick + kicks); created once per mount.
  const pollChainRef = useRef(createPollChain());
  // Latest handleEvent, read by the render-detached poll drain.
  const handleEventRef = useRef<(evt: DrainedEvent) => void>(() => {});
  // False after unmount: a late kick must not setState on a dead component.
  const aliveRef = useRef(true);
  // Tombstoned ids (user-deleted): late events and backend restores must not
  // resurrect them. Lazy init survives StrictMode remounts (ref persists).
  const tombstoned = useRef<Set<string> | null>(null);
  if (tombstoned.current === null) {
    tombstoned.current = new Set(loadTombstones());
  }

  // One drain of the backend event buffer, shared by the periodic tick and
  // the immediate post-send kick. Stable across renders: it only touches refs
  // plus setState, so send/answer/approve callbacks can safely depend on it.
  const pollOnce = useCallback(async (): Promise<void> => {
    if (!aliveRef.current) return;
    try {
      const res = await invoke<PollResult>("poll_events", { since: cursorRef.current });
      if (!aliveRef.current) return;
      cursorRef.current = res.head;
      const apply = handleEventRef.current;
      for (const e of res.events) apply(e);
    } catch (err) {
      if (aliveRef.current) setError(`event poll failed: ${String(err)}`);
    }
  }, []);

  // Immediate drain right after the backend acknowledges new work: without
  // this the next tick can be a full slow interval away, so the first paint
  // arrives late with a whole backlog at once (catch-up burst) instead of
  // streaming from the first tokens.
  const kickPoll = useCallback((): void => {
    enqueuePoll(pollChainRef.current, () => pollOnce());
  }, [pollOnce]);

  // Boot: restore local persistence first (instant history), then merge
  // the supervisor's live table, then poll the backend event buffer.
  // (Polling, not `listen` push: push subscriptions resolved yet never fired
  // in one environment, while `invoke` always worked — same broadcast
  // semantics, boring transport.)
  useEffect(() => {
    // No once-guard here: React StrictMode (dev) mounts, unmounts, and
    // remounts — a "booted" ref would skip the second (real) setup forever
    // after cleanup cancelled the first. Teardown below makes re-setup safe.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    aliveRef.current = true;

    const stored = loadSessions();
    const storedLogs: Record<string, LogEntry[]> = {};
    for (const s of stored) storedLogs[s.session_id] = loadLog(s.session_id);
    const storedWorkspace = loadWorkspace();
    const storedActive = loadActiveId();
    if (!cancelled) {
      // Mark restored sessions stopped: sidecar children do not survive
      // an app restart; the user relaunches by sending new input.
      // Tombstoned ids never come back, even from a stale persisted list.
      const live = stored.filter((s) => !tombstoned.current?.has(s.session_id));
      setSessions(live.map((s) => ({ ...s, running: false })));
      setLogs(storedLogs);
      // US-4: restore stored summaries (a stored summary = compacted thread).
      const storedSummaries: Record<string, ThreadSummary> = {};
      for (const s of stored) {
        const sum = loadSummary(s.session_id);
        if (sum !== null) storedSummaries[s.session_id] = sum;
      }
      setSummaries(storedSummaries);
      setWorkspaceState(storedWorkspace);
      setActiveId(
        storedActive &&
          stored.some((s) => s.session_id === storedActive && s.archived !== true)
          ? storedActive
          : (stored.find((s) => s.archived !== true)?.session_id ?? null),
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
            // The host keeps killed sessions server-side (no session/stop);
            // never merge a tombstoned id back in.
            if (tombstoned.current?.has(meta.session_id)) continue;
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
        cursorRef.current = head.head;
      } catch (err) {
        if (!cancelled) setError(`event poll failed: ${String(err)}`);
        return;
      }
      // setTimeout chain (not setInterval): cadence adapts to whether a
      // turn is streaming, and a slow tick never piles onto the next. The
      // drain itself goes through the shared chain so a post-send kick can
      // never overlap this tick with the same cursor.
      const tick = () => {
        enqueuePoll(pollChainRef.current, () => pollOnce());
        void pollChainRef.current.current.then(() => {
          if (!cancelled) {
            timer = setTimeout(
              tick,
              runningRef.current ? POLL_FAST_MS : POLL_SLOW_MS,
            );
          }
        });
      };
      tick();
    })();

    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollOnce]);

  // Write-through persistence.
  useEffect(() => {
    saveSessions(sessions.map(({ running: _r, ...rest }) => rest));
  }, [sessions]);

  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  useEffect(() => {
    saveAllowlist(allowlist);
  }, [allowlist]);

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

  /**
   * US-4: build the local extractive summary of a thread now and record it
   * (disk + state) with a system note in the log. Stable across renders:
   * it only touches refs, setState and imports, so `sendInput` and the
   * auto-compact effect can safely depend on it.
   */
  const doCompact = useCallback((sessionId: string): void => {
    const log = logsRef.current[sessionId] ?? loadLog(sessionId);
    const summary = buildSummary(sessionId, log);
    saveSummary(summary);
    setSummaries((cur) => ({ ...cur, [sessionId]: summary }));
    const note: LogEntry = {
      id: newId(),
      ts: Date.now(),
      role: "system",
      text:
        `Thread compacté — résumé local prêt (${summary.entryCount} entrées : ` +
        `${summary.decisions.length} décision(s), ${summary.context.length} contexte, ` +
        `${summary.todos.length} à-faire). Ouvrez un thread neuf via « New From Summary ».`,
    };
    setLogs((cur) => ({ ...cur, [sessionId]: [...(cur[sessionId] ?? []), note] }));
    appendLog(sessionId, [note]);
  }, []);

  // US-4 auto-compaction: once a thread log reaches the persisted-log cap
  // (COMPACT_AUTO_ENTRIES == persist MAX_LOG_ENTRIES), build the local
  // summary once. The disk write inside doCompact is synchronous, so the
  // loadSummary guard stops the loop on the re-render the note triggers.
  useEffect(() => {
    for (const [sid, log] of Object.entries(logs)) {
      if (log.length >= COMPACT_AUTO_ENTRIES && loadSummary(sid) === null) {
        doCompact(sid);
      }
    }
  }, [logs, doCompact]);

  function ensureSessionRow(sessionId: string, ws: string | null): void {
    if (tombstoned.current?.has(sessionId)) return;
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

  /**
   * US-10: paint the reflexive phase immediately (synchronously on send,
   * on turn/item start) as an empty open entry. The first delta coalesces
   * into it, so the stream is never blank pre-first-token. No-op when a
   * live entry already exists.
   */
  function ensurePlaceholder(sessionId: string, itemId?: string, agentId?: string): void {
    const stamp = { id: newId(), ts: Date.now() };
    setLogs((cur) => {
      const next = upsertReflexivePlaceholder(cur[sessionId] ?? [], {
        itemId,
        agentId,
        stamp,
      });
      if (next === (cur[sessionId] ?? [])) return cur;
      saveLog(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  /** US-10: remove a still-empty placeholder (send failed, no delta came). */
  function dropPlaceholder(sessionId: string): void {
    setLogs((cur) => {
      const log = cur[sessionId];
      if (!log) return cur;
      const next = dropEmptyPlaceholders(log);
      if (next === log) return cur;
      saveLog(sessionId, next);
      return { ...cur, [sessionId]: next };
    });
  }

  function handleEvent(evt: MuseEvent): void {
    const { session_id: sid, kind, payload } = evt;
    setEvtCount((c) => c + 1);
    if (!sid) return;
    // Deleted stays deleted: late in-flight events for a killed session are
    // dropped instead of resurrecting its row.
    if (tombstoned.current?.has(sid)) return;
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
      const parsed = parseSubagentPayload(payload);
      setLogs((cur) => {
        const log = cur[sid] ?? [];
        const i = lastOpenIndex(log, "subagent", parsed.agentId);
        let next: LogEntry[];
        if (i >= 0) {
          // Keep drill-down identity learned earlier: a bare delta must not
          // wipe the childSessionId announced at `item/started`.
          const prev = log[i];
          next = [
            ...log.slice(0, i),
            {
              ...prev,
              text: prev.text + parsed.text,
              childSessionId: parsed.childSessionId ?? prev.childSessionId,
              objective: parsed.objective ?? prev.objective,
              subagentRole: parsed.role ?? prev.subagentRole,
              depth: parsed.depth ?? prev.depth,
            },
            ...log.slice(i + 1),
          ];
        } else {
          next = [
            ...log,
            {
              id: newId(),
              ts: Date.now(),
              role: "subagent" as LogRole,
              text: parsed.text,
              agentId: parsed.agentId,
              open: true,
              childSessionId: parsed.childSessionId,
              objective: parsed.objective,
              subagentRole: parsed.role,
              depth: parsed.depth,
            },
          ];
        }
        saveLog(sid, next);
        return { ...cur, [sid]: next };
      });
      return;
    }
    if (kind === "input_request") {
      ensureSessionRow(sid, null);
      const req = parseInputRequest(sid, payload);
      if (req === null) {
        pushLog(sid, [
          { id: newId(), ts: Date.now(), role: "system", text: "input requested (unparseable)" },
        ]);
        return;
      }
      setInputRequests((cur) => {
        const i = cur.findIndex(
          (r) => r.session_id === sid && r.input_id === req.input_id,
        );
        if (i >= 0) {
          const next = [...cur];
          next[i] = req;
          return next;
        }
        return [...cur, req];
      });
      pushLog(sid, [
        { id: newId(), ts: Date.now(), role: "tool", text: `Input requested: ${req.tool_name}` },
      ]);
      return;
    }
    if (kind === "input_settled") {
      let inputId = "";
      let outcome = "settled";
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        if (typeof obj.inputId === "string") inputId = obj.inputId;
        if (typeof obj.outcome === "string") outcome = obj.outcome;
      } catch {
        // keep defaults
      }
      if (inputId.length > 0) {
        setInputRequests((cur) =>
          cur.filter((r) => !(r.session_id === sid && r.input_id === inputId)),
        );
      }
      pushLog(sid, [
        { id: newId(), ts: Date.now(), role: "system", text: `Input ${outcome}` },
      ]);
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
    // US-10: `item/started` paints before the first delta. Ensure a visible
    // open block even when no chunk has landed yet (no system-line noise,
    // and other open items keep streaming).
    if (isItemStartKind(kind)) {
      ensureSessionRow(sid, null);
      let itemId: string | undefined;
      let agentId: string | undefined;
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        const rawId = obj.itemId ?? obj.id;
        if (typeof rawId === "string" && rawId.length > 0) itemId = rawId;
        const rawKind = obj.itemKind ?? obj.kind;
        if (typeof rawKind === "string" && isSubagentItemKind(rawKind)) {
          agentId = itemId ?? "agent";
        }
      } catch {
        // unparseable payload: still show the reflexive phase
      }
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
      ensurePlaceholder(sid, itemId, agentId);
      return;
    }
    // status (and any future kinds): record + reflect liveness.
    ensureSessionRow(sid, null);
    if (isRunningKind(kind)) {
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: true } : s)),
      );
      // A (re)start must never blank the stream: keep/paint the reflexive
      // placeholder instead of closing it (US-10).
      ensurePlaceholder(sid);
    } else if (isStoppedKind(kind)) {
      setSessions((cur) =>
        cur.map((s) => (s.session_id === sid ? { ...s, running: false } : s)),
      );
    }
    if (payload) {
      pushLog(sid, [{ id: newId(), ts: Date.now(), role: "system", text: `[${kind}] ${payload}` }]);
    }
    // Closing a (re)start would kill the just-painted placeholder; only
    // settle blocks for other statuses (turn end, approvals, …).
    if (!isRunningKind(kind)) closeOpenBlocks(sid);
  }

  const setWorkspace = useCallback((path: string) => {
    setWorkspaceState(path);
    saveWorkspace(path);
    // Rust holds the pick as source of truth too (fire-and-forget: a stale
    // start_session arg can then still resolve server-side).
    void invoke<string>("set_workspace", { path }).catch(() => {});
  }, []);

  const setActive = useCallback((id: string | null) => setActiveId(id), []);

  // Shared session creation (US-4 `newFromSummary` reuses it so the fresh
  // thread goes through the exact same backend + state path as `+ New`).
  const startSessionRow = useCallback(async (): Promise<string | null> => {
    try {
      setError(null);
      // Live React state first: localStorage writes are best-effort and may
      // silently fail, which previously enabled the buttons while sending
      // workspace_path=null ("no workspace selected" from the backend).
      const ws = workspace ?? loadWorkspace() ?? undefined;
      if (ws === undefined) {
        setError("Pick a workspace folder first.");
        return null;
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
      return meta.session_id;
    } catch (e) {
      setError(`start_session failed: ${String(e)}`);
      return null;
    }
  }, [workspace]);

  const startSession = useCallback(async () => {
    await startSessionRow();
  }, [startSessionRow]);

  const sendInput = useCallback(
    async (sessionId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // US-4: `/compact` is intercepted at send time and never reaches the
      // model — it builds the local extractive summary of this thread.
      if (isCompactCommand(trimmed)) {
        doCompact(sessionId);
        return;
      }
      // US-7: `/fanout <n> "<task>"` never reaches the model as typed —
      // it becomes one parent-turn prompt instructing N parallel
      // subagents. A FIFO note is logged when n exceeds the lanes.
      let outgoing = trimmed;
      const fanout = parseFanoutCommand(trimmed);
      if (fanout !== null) {
        outgoing = buildFanoutPrompt(fanout);
        const note = fanoutQueueNote(fanout.count);
        if (note !== null) {
          pushLog(sessionId, [{ id: newId(), ts: Date.now(), role: "system", text: note }]);
        }
      }
      closeOpenBlocks(sessionId);
      pushLog(sessionId, [{ id: newId(), ts: Date.now(), role: "user", text: outgoing }]);
      // US-10: reflexive indicator synchronously (<200ms), before the first
      // delta or even `item/started` can arrive. The first chunk coalesces
      // into this entry, so no catch-up burst ever paints.
      ensurePlaceholder(sessionId);
      setSessions((cur) =>
        cur.map((s) =>
          s.session_id === sessionId
            ? {
                ...s,
                title: s.title.startsWith("Session ") ? shortTitle(fanout !== null ? fanout.task : trimmed) : s.title,
                running: true,
              }
            : s,
        ),
      );
      try {
        setError(null);
        await invoke("send_input", { sessionId, text: outgoing });
        // Drain immediately: the next slow tick could be ~1s away, which
        // would delay the first tokens and dump them as one catch-up burst.
        kickPoll();
      } catch (e) {
        setError(`send_input failed: ${String(e)}`);
        // The turn never started: withdraw the reflexive placeholder.
        dropPlaceholder(sessionId);
        setSessions((cur) =>
          cur.map((s) => (s.session_id === sessionId ? { ...s, running: false } : s)),
        );
      }
    },
    [kickPoll, doCompact],
  );

  /**
   * US-4: open a fresh thread pre-filled with the source thread's summary.
   * The summary must exist (manual `/compact`, Compacter button, or auto at
   * the entry cap). The composer receives the formatted text as prefill —
   * nothing is sent to the model until the user presses Send.
   */
  const newFromSummary = useCallback(
    async (sourceId: string) => {
      const summary =
        summaries[sourceId] ?? loadSummary(sourceId);
      if (!summary) {
        setError(
          `no summary for thread ${sourceId.slice(0, 8)}: compact it first (/compact).`,
        );
        return;
      }
      const id = await startSessionRow();
      if (id === null) return;
      setSessions((cur) =>
        cur.map((s) =>
          s.session_id === id ? { ...s, title: `Suite ${sourceId.slice(0, 8)}` } : s,
        ),
      );
      setPrefill(formatSummaryText(summary));
    },
    [startSessionRow, summaries],
  );

  const clearPrefill = useCallback(() => setPrefill(null), []);

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
        // The turn resumes after a decision: drain now, don't wait a tick.
        // US-10: reflexive placeholder synchronously, same as after send.
        ensurePlaceholder(sessionId);
        kickPoll();
      } catch (e) {
        setError(`approve failed: ${String(e)}`);
      }
    },
    [kickPoll],
  );

  // US-15: effective allowlist decision for one pending approval request
  // (badge in the panel; most-restrictive-wins, network default-deny).
  const allowDecisionFor = useCallback(
    (approval: ApprovalRequest): ResolvedApproval =>
      resolveApproval(allowlist, {
        toolName: approval.toolName,
        summary: approval.summary,
        scopes: approval.choices.map((c) => c.scope),
      }),
    [allowlist],
  );

  // US-15 "toujours autoriser": send the decision, then memorize an allow
  // rule (command pattern + the chosen scope) for future requests.
  const rememberApproval = useCallback(
    async (approval: ApprovalRequest, choiceId: string) => {
      await approve(approval.session_id, approval.request_id, choiceId);
      const choice = approval.choices.find((c) => c.choiceId === choiceId);
      setAllowlist((cur) =>
        addAllowRule(cur, {
          pattern: defaultPatternFor(approval.toolName, approval.summary),
          scope: choice?.scope ?? "",
          decision: "allow",
        }),
      );
    },
    [approve],
  );

  const revokeAllowRule = useCallback((id: string) => {
    setAllowlist((cur) => removeAllowRule(cur, id));
  }, []);

  const setAllowRuleDecisionCb = useCallback((id: string, decision: AllowDecision) => {
    setAllowlist((cur) => setAllowRuleDecision(cur, id, decision));
  }, []);

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
      if (tombstoned.current === null) tombstoned.current = new Set();
      tombstoned.current.add(sessionId);
      saveTombstones([...tombstoned.current]);
      setSessions((cur) => cur.filter((s) => s.session_id !== sessionId));
      setLogs((cur) => {
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      dropLog(sessionId);
      setApprovals((cur) => cur.filter((a) => a.session_id !== sessionId));
      setInputRequests((cur) => cur.filter((r) => r.session_id !== sessionId));
      // US-4: a killed thread takes its summary with it.
      dropSummary(sessionId);
      setSummaries((cur) => {
        if (!(sessionId in cur)) return cur;
        const next = { ...cur };
        delete next[sessionId];
        return next;
      });
      setActiveId((cur) => {
        if (cur !== sessionId) return cur;
        const remaining = loadSessions().filter(
          (s) => s.session_id !== sessionId && s.archived !== true,
        );
        return remaining[0]?.session_id ?? null;
      });
    },
    [],
  );

  // US-5: archive/restore flip the persisted `archived` flag (the
  // sessions write-through effect persists it); archiving the active
  // thread moves selection to the first remaining active thread.
  const archiveSession = useCallback(
    (sessionId: string) => {
      setSessions((cur) => withArchivedFlag(cur, sessionId, true));
      if (activeId === sessionId) {
        const fallback =
          sessions.find((s) => s.session_id !== sessionId && s.archived !== true)
            ?.session_id ?? null;
        setActiveId(fallback);
      }
    },
    [sessions, activeId],
  );

  const restoreSession = useCallback((sessionId: string) => {
    setSessions((cur) => withArchivedFlag(cur, sessionId, false));
  }, []);

  const activeLog = (activeId !== null && logs[activeId]) || [];
  const activeApprovals = approvals.filter((a) => a.session_id === activeId);
  const activeInputRequests = inputRequests.filter((r) => r.session_id === activeId);

  const answerInput = useCallback(
    async (sessionId: string, inputId: string, answers: InputAnswer[]) => {
      try {
        setError(null);
        await invoke("answer_input", {
          sessionId,
          userInputId: inputId,
          answers,
        });
        // Panel removal arrives via input_settled; on success the turn
        // resumes. On error (-32057) the panel stays for a corrected answer.
        // Drain now so the resumed turn paints from its first tokens.
        // US-10: reflexive placeholder synchronously, same as after send.
        ensurePlaceholder(sessionId);
        kickPoll();
      } catch (e) {
        setError(`answer_input failed: ${String(e)}`);
      }
    },
    [kickPoll],
  );

  const cancelInput = useCallback(async (sessionId: string, inputId: string) => {
    try {
      setError(null);
      await invoke("cancel_input", { sessionId, userInputId: inputId });
    } catch (e) {
      setError(`cancel_input failed: ${String(e)}`);
    }
  }, []);

  // US-6 sub-agent controls: each method invokes exactly one `subagent/*`
  // Tauri command (one MSP method), then kicks the poll loop so the effect
  // paints from its first events instead of waiting for the next tick.
  const subagentFireAndForget = useCallback(
    async (command: string, sessionId: string, agentId: string, extra?: Record<string, string>) => {
      try {
        setError(null);
        await invoke(command, { sessionId, agentId, ...extra });
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: `Subagent ${agentId}: ${command} sent.` },
        ]);
        kickPoll();
      } catch (e) {
        setError(`${command} failed: ${String(e)}`);
      }
    },
    [kickPoll],
  );

  const subagentInterrupt = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_interrupt", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentStop = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_stop", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentResume = useCallback(
    (sessionId: string, agentId: string) =>
      subagentFireAndForget("subagent_resume", sessionId, agentId),
    [subagentFireAndForget],
  );

  const subagentFollowup = useCallback(
    async (sessionId: string, agentId: string, task: string) => {
      const trimmed = task.trim();
      if (!trimmed) {
        setError("subagent_followup failed: task must not be empty");
        return;
      }
      await subagentFireAndForget("subagent_followup", sessionId, agentId, { task: trimmed });
    },
    [subagentFireAndForget],
  );

  const subagentReadResult = useCallback(
    async (sessionId: string, agentId: string): Promise<string | null> => {
      try {
        setError(null);
        const res = await invoke<unknown>("subagent_read_result", { sessionId, agentId });
        const text = formatSubagentResult(res);
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: `Subagent ${agentId} result:\n${text}` },
        ]);
        kickPoll();
        return text;
      } catch (e) {
        setError(`subagent_read_result failed: ${String(e)}`);
        return null;
      }
    },
    [kickPoll],
  );

  const subagentDrilldown = useCallback(
    async (sessionId: string, childSessionId: string | undefined): Promise<string | null> => {
      if (!childSessionId) {
        // Explicit error, never a silent empty view: without an id there is
        // nothing `session/read` could open.
        setError("subagent drill-down unavailable: this block carries no child session id");
        return null;
      }
      try {
        setError(null);
        const res = await invoke<unknown>("subagent_drilldown", {
          sessionId,
          childSessionId,
        });
        const text = formatDrilldown(res);
        pushLog(sessionId, [
          { id: newId(), ts: Date.now(), role: "system", text: `Child session ${childSessionId}:\n${text}` },
        ]);
        kickPoll();
        return text;
      } catch (e) {
        setError(`subagent drill-down failed: ${String(e)}`);
        return null;
      }
    },
    [kickPoll],
  );

  // Updated every render; the poll loop reads it for cadence.
  runningRef.current = sessions.some((s) => s.running);
  // Latest event handler for the render-detached poll drain.
  handleEventRef.current = handleEvent;

  return {
    sessions,
    activeId,
    logs,
    activeLog,
    approvals,
    activeApprovals,
    inputRequests,
    activeInputRequests,
    workspace,
    backendMissing,
    setWorkspace,
    setActive,
    startSession,
    sendInput,
    approve,
    allowlist,
    allowDecisionFor,
    rememberApproval,
    revokeAllowRule,
    setAllowRuleDecision: setAllowRuleDecisionCb,
    answerInput,
    cancelInput,
    cancelSession,
    killSession,
    archiveSession,
    restoreSession,
    subagentInterrupt,
    subagentStop,
    subagentResume,
    subagentFollowup,
    subagentReadResult,
    subagentDrilldown,
    summaries,
    compactSession: doCompact,
    newFromSummary,
    prefill,
    clearPrefill,
    error,
    evtCount,
  };
}
