import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../lib/persist";
import { REFLEXIVE_LABEL } from "../lib/phase";
import { subagentSummary } from "../lib/subagent";
import {
  initialStreamWindowStart,
  maxStreamWindowStart,
  nextStreamWindowStart,
  prependStreamWindowStart,
  shouldWindowStream,
} from "../lib/streamWindow";
import {
  classifyStreamHealth,
  formatElapsed,
  streamEventLabel,
  streamHealthLabel,
  type StreamHealth,
} from "../lib/streamHealth";
import {
  cycleTranscriptHit,
  searchTranscript,
  type TranscriptHit,
} from "../lib/transcriptSearch";
import { MessageContent } from "./MessageContent";

/** US-6 controls for one sub-agent block. Read-result and drill-down resolve
 *  to display text (also logged as system lines by the hook); the rest are
 *  fire-and-forget with errors surfaced in the hook error banner. */
export interface SubagentControls {
  onInterrupt: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onResume: (agentId: string) => void;
  onFollowup: (agentId: string, task: string) => void;
  onReadResult: (agentId: string) => Promise<string | null>;
  onDrilldown: (entry: LogEntry) => Promise<string | null>;
}

interface Props {
  entries: LogEntry[];
  sessionId: string | null;
  running?: boolean;
  stopping?: boolean;
  lastEventAt?: number | null;
  /** Last transport event observed, used only for a compact progress hint. */
  lastEventKind?: string | null;
  /** A permission/input decision was accepted; awaiting the next host event. */
  resumePendingAt?: number | null;
  pendingApprovals?: number;
  pendingInputs?: number;
  reconnecting?: boolean;
  onReconnect?: () => void;
  onCancel?: () => void;
  /** Retry the last user message when the host marks a turn retryable. */
  onRetryFailedTurn?: (entry: LogEntry) => Promise<void>;
  /** Start a server-side branch from this completed turn. */
  onForkFromEntry?: (turnId: string) => void;
  controls?: SubagentControls;
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function roleLabel(e: LogEntry): string {
  switch (e.role) {
    case "user":
      return "You";
    case "assistant":
      return "Muse";
    case "thinking":
      return "Muse · Thinking";
    case "subagent":
      return `Agent ${e.agentId ?? ""}`;
    case "tool":
      return "Tool";
    case "system":
      return "Information";
  }
}

function agentOf(e: LogEntry): string {
  return e.agentId ?? e.itemId ?? "agent";
}

/**
 * Conversation stream for one session. Consecutive assistant chunks are
 * coalesced by the hook into a single entry; sub-agent entries render as
 * collapsible blocks grouped by agent id, each with its US-6 controls
 * (interrupt/stop/resume/follow-up/read-result/drill-down).
 */
export function StreamView({
  entries,
  sessionId,
  running = false,
  stopping = false,
  lastEventAt = null,
  lastEventKind = null,
  resumePendingAt = null,
  pendingApprovals = 0,
  pendingInputs = 0,
  reconnecting = false,
  onReconnect,
  onCancel,
  onRetryFailedTurn,
  onForkFromEntry,
  controls,
}: Props) {
  const streamRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollTopsRef = useRef<Record<string, number>>({});
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const stickRef = useRef(true);
  const [followupFor, setFollowupFor] = useState<string | null>(null);
  const [followupText, setFollowupText] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [retryingFailure, setRetryingFailure] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findTarget, setFindTarget] = useState<number | null>(null);
  const [findSelection, setFindSelection] = useState<number | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [windowStart, setWindowStart] = useState(() =>
    initialStreamWindowStart(entries.length),
  );
  const windowStartsRef = useRef<Record<string, number>>({});
  const windowSessionRef = useRef<string | null>(sessionId);
  const previousEntryCountRef = useRef(entries.length);
  const prependScrollRef = useRef<{ top: number; height: number } | null>(null);
  const jumpLatestRef = useRef(false);
  const loadingOlderRef = useRef(false);

  const streamWindowed = shouldWindowStream(entries.length);
  const maxWindowStart = maxStreamWindowStart(entries.length);
  const safeWindowStart = streamWindowed
    ? Math.min(Math.max(0, windowStart), maxWindowStart)
    : 0;
  const visibleEntries = streamWindowed ? entries.slice(safeWindowStart) : entries;
  const findHits = useMemo(
    () => searchTranscript(entries, findQuery),
    [entries, findQuery],
  );

  // Keep the quiet-stream message current without making the transcript
  // itself reflow. The interval only exists while the host reports a live
  // turn and is automatically cleaned up when it settles.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const key = sessionId ?? "";
    const saved = windowStartsRef.current[key];
    const next = initialStreamWindowStart(entries.length, saved);
    windowSessionRef.current = sessionId;
    previousEntryCountRef.current = entries.length;
    prependScrollRef.current = null;
    jumpLatestRef.current = false;
    loadingOlderRef.current = false;
    setWindowStart(next);
    setFindOpen(false);
    setFindQuery("");
    setFindTarget(null);
    setFindSelection(null);
  }, [sessionId]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    setFindSelection((current) => {
      if (findHits.length === 0) return null;
      return current !== null && current < findHits.length ? current : 0;
    });
  }, [findQuery, findHits.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      const target = event.target as HTMLElement | null;
      if (target !== null && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (windowSessionRef.current !== sessionId) return;
    const previousLength = previousEntryCountRef.current;
    previousEntryCountRef.current = entries.length;
    setWindowStart((current) => {
      const next = nextStreamWindowStart(current, previousLength, entries.length);
      if (sessionId !== null) windowStartsRef.current[sessionId] = next;
      return next;
    });
  }, [entries.length, sessionId]);

  useLayoutEffect(() => {
    const anchor = prependScrollRef.current;
    const stream = streamRef.current;
    if (anchor !== null && stream !== null) {
      stream.scrollTop = anchor.top + (stream.scrollHeight - anchor.height);
      prependScrollRef.current = null;
      loadingOlderRef.current = false;
    }
    if (jumpLatestRef.current && stream !== null) {
      jumpLatestRef.current = false;
      stream.scrollTop = stream.scrollHeight;
    }
  }, [safeWindowStart, windowStart]);

  useLayoutEffect(() => {
    if (findTarget === null) return;
    const frame = window.requestAnimationFrame(() => {
      const target = streamRef.current?.querySelector<HTMLElement>(
        `[data-entry-index="${findTarget}"]`,
      );
      if (target === null || target === undefined) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("stream-find-target");
      window.setTimeout(() => target.classList.remove("stream-find-target"), 1200);
      setFindTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [findTarget, safeWindowStart, windowStart]);

  useEffect(() => {
    stickRef.current = true;
    setAwayFromBottom(false);
    const savedTop = scrollTopsRef.current[sessionId ?? ""];
    const frame = window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (!stream || savedTop === undefined) return;
      stream.scrollTop = savedTop;
      const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
      stickRef.current = atBottom;
      setAwayFromBottom(!atBottom);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionId]);

  useEffect(() => {
    // Streaming can update this list many times per second. Instant
    // alignment avoids stacking smooth-scroll animations and keeps the
    // latest token visible without starving input/paint work.
    if (stickRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    }
  }, [entries, safeWindowStart]);

  function loadOlderMessages(): void {
    if (!streamWindowed || safeWindowStart <= 0 || loadingOlderRef.current) return;
    const stream = streamRef.current;
    if (stream !== null) {
      prependScrollRef.current = {
        top: stream.scrollTop,
        height: stream.scrollHeight,
      };
    }
    const next = prependStreamWindowStart(safeWindowStart);
    loadingOlderRef.current = true;
    if (sessionId !== null) windowStartsRef.current[sessionId] = next;
    setWindowStart(next);
  }

  function jumpToLatest(): void {
    if (streamWindowed && safeWindowStart !== maxWindowStart) {
      jumpLatestRef.current = true;
      if (sessionId !== null) windowStartsRef.current[sessionId] = maxWindowStart;
      setWindowStart(maxWindowStart);
    }
    stickRef.current = true;
    setAwayFromBottom(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }

  function revealHit(hit: TranscriptHit): void {
    const visible = hit.index >= safeWindowStart && hit.index < safeWindowStart + visibleEntries.length;
    if (!visible && streamWindowed) {
      const next = Math.min(Math.max(0, hit.index - 12), maxWindowStart);
      if (sessionId !== null) windowStartsRef.current[sessionId] = next;
      setWindowStart(next);
    }
    setFindTarget(hit.index);
  }

  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (streamWindowed && el.scrollTop < 120) loadOlderMessages();
    if (streamWindowed && stickRef.current && safeWindowStart !== maxWindowStart) {
      if (sessionId !== null) windowStartsRef.current[sessionId] = maxWindowStart;
      setWindowStart(maxWindowStart);
    }
    if (sessionId !== null) scrollTopsRef.current[sessionId] = el.scrollTop;
    setAwayFromBottom(!stickRef.current);
  }

  async function runResult(
    entry: LogEntry,
    kind: "result" | "drilldown",
  ): Promise<void> {
    if (!controls || busy === entry.id) return;
    setBusy(entry.id);
    try {
      const text =
        kind === "result"
          ? await controls.onReadResult(agentOf(entry))
          : await controls.onDrilldown(entry);
      if (text !== null) setShown((cur) => ({ ...cur, [entry.id]: text }));
    } finally {
      setBusy(null);
    }
  }

  function sendFollowup(entry: LogEntry): void {
    if (!controls) return;
    const task = followupText.trim();
    if (!task) return;
    controls.onFollowup(agentOf(entry), task);
    setFollowupFor(null);
    setFollowupText("");
  }

  if (sessionId === null) return null;

  const health = classifyStreamHealth({
    running,
    stopping,
    lastEventAt,
    resumePendingAt,
    pendingApprovals,
    pendingInputs,
    now,
  });
  const elapsed = lastEventAt === null ? null : formatElapsed(now - lastEventAt);
  const eventLabel = streamEventLabel(lastEventKind);

  function healthDetail(status: StreamHealth): string {
    switch (status) {
      case "working":
        return `${elapsed === null ? "Live updates are arriving." : `Last update ${elapsed} ago.`}${
          eventLabel ? ` · ${eventLabel}.` : ""
        }`;
      case "resuming":
        return `Your decision was accepted; waiting for the host to continue the turn.${
          eventLabel ? ` Last event: ${eventLabel}.` : ""
        }`;
      case "stopping":
        return "The stop request was accepted; waiting for the desktop host to confirm it.";
      case "waiting-approval":
        return "Choose an authorization option above to continue this conversation.";
      case "waiting-input":
        return "Muse needs your answer before it can continue.";
      case "waiting-host":
        return "The turn is marked active, but no host event has reached this window yet.";
      case "stalled":
        return `No host event for ${elapsed ?? "a while"}. Muse may still be working.${
          eventLabel ? ` Last event: ${eventLabel}.` : ""
        }`;
      case "idle":
        return "";
    }
  }

  return (
    <div
      ref={streamRef}
      className="stream"
      onScroll={onScroll}
      role="log"
      aria-live="off"
      aria-label="Conversation messages"
      data-entry-count={entries.length}
    >
      <div className="stream-find" aria-label="Find in conversation">
        {!findOpen ? (
          <button type="button" onClick={() => setFindOpen(true)}>
            Find in conversation <kbd>Ctrl/Cmd F</kbd>
          </button>
        ) : (
          <>
            <input
              ref={findInputRef}
              type="search"
              value={findQuery}
              onChange={(event) => setFindQuery(event.target.value)}
              placeholder="Search messages…"
              aria-label="Search messages"
              aria-controls="conversation-search-results"
              aria-activedescendant={
                findSelection === null ? undefined : `conversation-search-hit-${findSelection}`
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFindOpen(false);
                  setFindQuery("");
                  setFindSelection(null);
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setFindSelection((current) =>
                    cycleTranscriptHit(current, event.key === "ArrowDown" ? 1 : -1, findHits.length),
                  );
                  return;
                }
                if (event.key === "Enter" && findSelection !== null) {
                  const hit = findHits[findSelection];
                  if (hit !== undefined) {
                    event.preventDefault();
                    revealHit(hit);
                  }
                }
              }}
            />
            <span className="stream-find-count" role="status">
              {findQuery.trim() === ""
                ? "Type to search the full conversation"
                : `${findHits.length}${findHits.length === 80 ? "+" : ""} match${findHits.length === 1 ? "" : "es"}`}
            </span>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setFindOpen(false);
                setFindQuery("");
                setFindSelection(null);
              }}
            >
              Close
            </button>
          </>
        )}
        {findOpen && findHits.length > 0 && (
          <div
            id="conversation-search-results"
            className="stream-find-hits"
            role="listbox"
            aria-label="Conversation matches"
          >
            {findHits.map((hit, index) => (
              <button
                type="button"
                key={`${hit.entryId}-${hit.index}`}
                id={`conversation-search-hit-${index}`}
                role="option"
                aria-selected={findSelection === index}
                className={findSelection === index ? "is-active" : undefined}
                onMouseEnter={() => setFindSelection(index)}
                onClick={() => {
                  setFindSelection(index);
                  revealHit(hit);
                }}
              >
                <span>{hit.role}</span>
                <strong>{hit.excerpt}</strong>
              </button>
            ))}
          </div>
        )}
      </div>
      {streamWindowed && safeWindowStart > 0 && (
        <div className="stream-window-notice" role="status" aria-live="polite">
          <button type="button" onClick={loadOlderMessages}>
            Load older messages
          </button>
          <span>
            Showing messages {safeWindowStart + 1}–{entries.length} of {entries.length}.
            Scroll to the top to load more.
          </span>
        </div>
      )}
      {entries.length === 0 && (
        <p className="muted">
          Start a conversation. Your history is saved locally.
        </p>
      )}
      {visibleEntries.map((e, visibleIndex) => {
        const entryIndex = safeWindowStart + visibleIndex;
        // US-10 reflexive phase: an open entry with no text yet (send just
        // happened, or `item/started` arrived before the first delta) shows
        // a plain muted label. The label is rendered, never stored: the
        // first delta coalesces into the empty text.
        const reflexive = e.open === true && e.text === "";
        if (e.role === "thinking") {
          const thinkingElapsed = e.open ? formatElapsed(Math.max(0, now - e.ts)) : null;
          return (
            <details
              key={e.id}
              className={`msg thinking${e.open ? " is-live" : ""}`}
              data-entry-index={entryIndex}
              // Keep live reasoning visible while tokens arrive. Once the
              // item closes, leaving `open` undefined hands disclosure back
              // to the user instead of forcing it shut.
              open={e.open === true ? true : undefined}
            >
              <summary>
                <span className="role">{roleLabel(e)}</span>
                <span className="msg-summary">
                  {reflexive ? REFLEXIVE_LABEL : "Thinking"}
                  {thinkingElapsed ? ` · ${thinkingElapsed}` : ""}
                </span>
                <span className="ts">{timeOf(e.ts)}</span>
              </summary>
              <div className="thinking-content">
                {reflexive ? (
                  <span className="muted">{REFLEXIVE_LABEL}</span>
                ) : (
                  <MessageContent text={e.text} />
                )}
                {e.open && <span className="caret" aria-hidden="true" />}
              </div>
            </details>
          );
        }
        return e.role === "subagent" ? (
          <details key={e.id} className="msg subagent" data-entry-index={entryIndex}>
            <summary>
              <span className="role">{roleLabel(e)}</span>
              <span className="msg-summary">
                {reflexive
                  ? REFLEXIVE_LABEL
                  : subagentSummary({
                      objective: e.objective,
                      subagentRole: e.subagentRole,
                      depth: e.depth,
                      text: e.text,
                    })}
              </span>
              <span className="ts">{timeOf(e.ts)}</span>
            </summary>
            <pre>
              {reflexive ? (
                <span className="muted">{REFLEXIVE_LABEL}</span>
              ) : (
                e.text
              )}
              {e.open && <span className="caret" aria-hidden="true" />}
            </pre>
            {e.childSessionId && (
              <div className="muted subagent-child">
                child: {e.childSessionId}
              </div>
            )}
            {controls && (
              <div className="subagent-controls">
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => controls.onInterrupt(agentOf(e))}
                  title="subagent/interrupt"
                >
                  Interrupt
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => controls.onStop(agentOf(e))}
                  title="subagent/stop"
                >
                  Stop
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => controls.onResume(agentOf(e))}
                  title="subagent/resume"
                >
                  Resume
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => {
                    setFollowupFor(followupFor === e.id ? null : e.id);
                    setFollowupText("");
                  }}
                  title="subagent/followupTask"
                >
                  Follow up
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => void runResult(e, "result")}
                  title="subagent/readResult"
                >
                  Read result
                </button>
                {e.childSessionId && (
                  <button
                    type="button"
                    disabled={busy === e.id}
                    onClick={() => void runResult(e, "drilldown")}
                    title="session/read"
                  >
                    Agent conversation
                  </button>
                )}
              </div>
            )}
            {followupFor === e.id && controls && (
              <div className="subagent-followup">
                <input
                  type="text"
                  value={followupText}
                  placeholder="Your instruction for this agent…"
                  onChange={(ev) => setFollowupText(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") sendFollowup(e);
                    if (ev.key === "Escape") {
                      setFollowupFor(null);
                      setFollowupText("");
                    }
                  }}
                  aria-label="Follow-up instruction"
                />
                <button type="button" onClick={() => sendFollowup(e)}>
                  Send
                </button>
              </div>
            )}
            {shown[e.id] && (
              <pre className="subagent-result">{shown[e.id]}</pre>
            )}
          </details>
        ) : (
          <div key={e.id} className={`msg ${e.role}`} data-entry-index={entryIndex}>
            <span className="role">{roleLabel(e)}</span>
            {e.engineError ? (
              <details className="engine-error" open>
                <summary>
                  <strong>{e.engineError.retryable ? "Turn failed · retryable" : "Turn failed"}</strong>
                  <span className="engine-error-kind">{e.engineError.kind}</span>
                </summary>
                <p>{e.engineError.message}</p>
                {e.engineError.reason && e.engineError.reason !== e.engineError.message && (
                  <p className="engine-error-reason">{e.engineError.reason}</p>
                )}
                <dl>
                  <div><dt>Retryable</dt><dd>{e.engineError.retryable ? "Yes" : "No"}</dd></div>
                  {e.engineError.durationMs !== undefined && (
                    <div><dt>Duration</dt><dd>{Math.round(e.engineError.durationMs / 1000)}s</dd></div>
                  )}
                </dl>
                {e.engineError.retryable && onRetryFailedTurn && (
                  <button
                    type="button"
                    className="engine-error-retry"
                    disabled={retryingFailure === e.id}
                    onClick={async () => {
                      if (retryingFailure !== null) return;
                      setRetryingFailure(e.id);
                      try {
                        await onRetryFailedTurn(e);
                      } finally {
                        setRetryingFailure(null);
                      }
                    }}
                  >
                    {retryingFailure === e.id ? "Retrying…" : "Retry turn"}
                  </button>
                )}
              </details>
            ) : e.role === "assistant" && !reflexive ? (
              <>
                <MessageContent text={e.text} />
                {e.open && <span className="caret" aria-hidden="true" />}
              </>
            ) : (
              <pre>
                {reflexive ? (
                  <span className="muted">{REFLEXIVE_LABEL}</span>
                ) : (
                  e.text
                )}
                {e.open && e.role === "assistant" && (
                  <span className="caret" aria-hidden="true" />
                )}
              </pre>
            )}
            <div className="msg-footer">
              <span className="ts">{timeOf(e.ts)}</span>
              {onForkFromEntry && e.turnId && !e.open && (e.role === "user" || e.role === "assistant") && (
                <button
                  type="button"
                  className="msg-fork"
                  onClick={() => onForkFromEntry(e.turnId!)}
                  title="Fork conversation from this completed turn"
                >
                  Fork from here
                </button>
              )}
            </div>
          </div>
        );
      })}
      {health !== "idle" && (
        <div
          className={`stream-health stream-health-${health}`}
          role="status"
          aria-live="polite"
        >
          <span className="stream-health-indicator" aria-hidden="true" />
          <span className="stream-health-copy">
            <strong>{streamHealthLabel(health)}</strong>
            <span>{healthDetail(health)}</span>
          </span>
          {(health === "stalled" || health === "waiting-host") && (
            <span className="stream-health-actions">
              {onReconnect && (
                <button type="button" onClick={onReconnect} disabled={reconnecting}>
                  {reconnecting ? "Reconnecting…" : "Reconnect"}
                </button>
              )}
              {onCancel && (
                <button type="button" className="quiet" onClick={onCancel}>
                  Stop
                </button>
              )}
            </span>
          )}
        </div>
      )}
      <div ref={bottomRef} />
      {awayFromBottom && (
        <button
          className="jump-to-latest"
          onClick={jumpToLatest}
        >
          ↓ Latest messages
        </button>
      )}
    </div>
  );
}
