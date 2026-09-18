import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../lib/persist";
import type { ItemOutputChunk } from "../hooks/useMuseSessions";
import { REFLEXIVE_LABEL } from "../lib/phase";
import { subagentSummary } from "../lib/subagent";
import {
  initialStreamWindowStart,
  maxStreamWindowStart,
  nextStreamWindowStart,
  prependStreamWindowStart,
  shouldWindowStream,
  streamWindowEnd,
  streamWindowPadding,
} from "../lib/streamWindow";
import {
  classifyStreamHealth,
  formatElapsed,
  streamEventLabel,
  streamHealthLabel,
  type RetryScheduled,
  type StreamHealth,
} from "../lib/streamHealth";
import {
  cycleTranscriptHit,
  searchTranscript,
  type TranscriptHit,
} from "../lib/transcriptSearch";
import { streamEntryA11y, streamWindowAnnouncement } from "../lib/streamA11y";
import { streamNavigationTarget } from "../lib/streamNavigation";
import {
  isTerminalSubagentStatus,
  subagentStatusLabel,
} from "../lib/subagent";
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
  onReadOutput: (entry: LogEntry, offsetBytes?: number) => Promise<ItemOutputChunk | null>;
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
  /** Host-provided retry backoff shown while the next attempt is pending. */
  retryScheduled?: RetryScheduled | null;
  pendingApprovals?: number;
  pendingInputs?: number;
  reconnecting?: boolean;
  onReconnect?: () => void;
  reconciling?: boolean;
  onReconcile?: () => void;
  onCancel?: () => void;
  /** Close a conversation when a stop was accepted but never confirmed. */
  onForceStop?: () => void;
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

/** Measure the mounted message including its vertical margins. The window
 * uses this value only for entries outside the DOM; an unmeasured entry keeps
 * the conservative estimate from streamWindow.ts. */
function measureEntryBlockHeight(node: HTMLElement): number {
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  const marginTop = Number.parseFloat(style.marginTop) || 0;
  const marginBottom = Number.parseFloat(style.marginBottom) || 0;
  return Math.max(1, Math.round(rect.height + marginTop + marginBottom));
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
  retryScheduled = null,
  pendingApprovals = 0,
  pendingInputs = 0,
  reconnecting = false,
  onReconnect,
  reconciling = false,
  onReconcile,
  onCancel,
  onForceStop,
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
  const [loadedOutputs, setLoadedOutputs] = useState<Record<string, {
    content: string;
    nextOffsetBytes: number;
    byteLen: number;
    eof: boolean;
    loading: boolean;
  }>>({});
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
  const [measuredHeights, setMeasuredHeights] = useState<Record<number, number | undefined>>({});
  const windowStartsRef = useRef<Record<string, number>>({});
  const measuredPaddingRef = useRef<{
    start: number;
    end: number;
    top: number;
    bottom: number;
  } | null>(null);
  const windowSessionRef = useRef<string | null>(sessionId);
  const previousEntryCountRef = useRef(entries.length);
  const prependScrollRef = useRef<{
    index: number;
    offset: number;
    top: number;
    height: number;
  } | null>(null);
  const jumpLatestRef = useRef(false);
  const loadingOlderRef = useRef(false);

  const streamWindowed = shouldWindowStream(entries.length);
  const maxWindowStart = maxStreamWindowStart(entries.length);
  const safeWindowStart = streamWindowed
    ? Math.min(Math.max(0, windowStart), maxWindowStart)
    : 0;
  const safeWindowEnd = streamWindowed
    ? streamWindowEnd(entries.length, safeWindowStart)
    : entries.length;
  const visibleEntries = streamWindowed
    ? entries.slice(safeWindowStart, safeWindowEnd)
    : entries;
  const windowPadding = streamWindowed
    ? streamWindowPadding(entries.length, safeWindowStart, safeWindowEnd, undefined, measuredHeights)
    : { top: 0, bottom: 0 };
  const windowAnnouncement = streamWindowAnnouncement(
    safeWindowStart,
    safeWindowEnd,
    entries.length,
  );
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
    measuredPaddingRef.current = null;
    setMeasuredHeights({});
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
      const anchorEntry = stream.querySelector<HTMLElement>(
        `[data-entry-index="${anchor.index}"]`,
      );
      if (anchorEntry !== null) {
        const streamRect = stream.getBoundingClientRect();
        const nextOffset = anchorEntry.getBoundingClientRect().top - streamRect.top;
        stream.scrollTop += nextOffset - anchor.offset;
      } else {
        // Keep the previous height-based fallback for an unexpected page
        // replacement where the original entry is no longer mounted.
        stream.scrollTop = anchor.top + (stream.scrollHeight - anchor.height);
      }
      prependScrollRef.current = null;
      loadingOlderRef.current = false;
    }
    if (jumpLatestRef.current && stream !== null) {
      jumpLatestRef.current = false;
      stream.scrollTop = stream.scrollHeight;
    }
  }, [safeWindowStart, windowStart]);

  useLayoutEffect(() => {
    if (!streamWindowed) {
      measuredPaddingRef.current = null;
      return;
    }
    const stream = streamRef.current;
    const previous = measuredPaddingRef.current;
    if (
      stream !== null &&
      previous !== null &&
      previous.start === safeWindowStart &&
      previous.end === safeWindowEnd
    ) {
      const topDelta = windowPadding.top - previous.top;
      if (Math.abs(topDelta) > 0.5) stream.scrollTop += topDelta;
    }
    measuredPaddingRef.current = {
      start: safeWindowStart,
      end: safeWindowEnd,
      top: windowPadding.top,
      bottom: windowPadding.bottom,
    };
  }, [safeWindowEnd, safeWindowStart, streamWindowed, windowPadding.bottom, windowPadding.top]);

  useLayoutEffect(() => {
    if (!streamWindowed) return;
    const stream = streamRef.current;
    if (stream === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((observations) => {
      const updates = new Map<number, number>();
      for (const observation of observations) {
        const node = observation.target as HTMLElement;
        const rawIndex = node.dataset.entryIndex;
        if (rawIndex === undefined) continue;
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) continue;
        updates.set(index, measureEntryBlockHeight(node));
      }
      if (updates.size === 0) return;
      setMeasuredHeights((current) => {
        let next = current;
        let changed = false;
        for (const [index, height] of updates) {
          if (Math.abs((current[index] ?? 0) - height) <= 0.5) continue;
          if (!changed) next = { ...current };
          next[index] = height;
          changed = true;
        }
        return changed ? next : current;
      });
    });
    const nodes = stream.querySelectorAll<HTMLElement>("[data-entry-index]");
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [safeWindowEnd, safeWindowStart, streamWindowed, visibleEntries.length]);

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
      const anchorEntry = stream.querySelector<HTMLElement>(
        `[data-entry-index="${safeWindowStart}"]`,
      );
      const streamRect = stream.getBoundingClientRect();
      prependScrollRef.current = {
        index: safeWindowStart,
        offset: anchorEntry === null
          ? stream.scrollTop
          : anchorEntry.getBoundingClientRect().top - streamRect.top,
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

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    // The transcript itself is focusable so keyboard users can navigate a
    // long conversation without first finding an individual message.
    if (e.target !== e.currentTarget) return;
    const target = streamNavigationTarget(
      e.key,
      e.currentTarget.clientHeight,
      e.currentTarget.scrollTop,
      e.currentTarget.scrollHeight - e.currentTarget.clientHeight,
    );
    if (target === null) return;
    e.preventDefault();
    if (e.key === "End") {
      jumpToLatest();
      return;
    }
    e.currentTarget.scrollTo({ top: target, behavior: "auto" });
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

  async function runOutput(entry: LogEntry): Promise<void> {
    if (!controls || !entry.outputRef) return;
    const previous = loadedOutputs[entry.id];
    if (previous?.loading || previous?.eof) return;
    setLoadedOutputs((cur) => ({
      ...cur,
      [entry.id]: { ...(cur[entry.id] ?? { content: "", nextOffsetBytes: 0, byteLen: 0, eof: false }), loading: true },
    }));
    try {
      const chunk = await controls.onReadOutput(entry, previous?.nextOffsetBytes ?? 0);
      if (!chunk) return;
      setLoadedOutputs((cur) => {
        const current = cur[entry.id];
        const append = current !== undefined && chunk.offsetBytes >= current.nextOffsetBytes;
        return {
          ...cur,
          [entry.id]: {
            content: append ? `${current.content}${chunk.content}` : chunk.content,
            nextOffsetBytes: chunk.nextOffsetBytes,
            byteLen: (append ? current.byteLen : 0) + chunk.byteLen,
            eof: chunk.eof || chunk.byteLen === 0,
            loading: false,
          },
        };
      });
    } finally {
      setLoadedOutputs((cur) => {
        const current = cur[entry.id];
        return current?.loading ? { ...cur, [entry.id]: { ...current, loading: false } } : cur;
      });
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
    retryScheduled,
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
      case "retrying": {
        if (retryScheduled === null || retryScheduled === undefined) {
          return "The host scheduled another attempt.";
        }
        const remaining = Math.max(
          0,
          retryScheduled.delayMs - Math.max(0, now - retryScheduled.scheduledAt),
        );
        const countdown = remaining > 0
          ? `Next attempt in ${formatElapsed(remaining)}.`
          : "The next attempt is due now.";
        const attempt = retryScheduled.attempt !== null && retryScheduled.maxAttempts !== null
          ? ` Attempt ${retryScheduled.attempt} of ${retryScheduled.maxAttempts}.`
          : retryScheduled.attempt !== null
            ? ` Attempt ${retryScheduled.attempt}.`
            : "";
        const reason = retryScheduled.reason === null ? "" : ` ${retryScheduled.reason}`;
        return `${countdown}${attempt}${reason}`;
      }
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
        return `${stopping
          ? "The desktop host did not confirm the stop. Reconnect or close this conversation to clear it."
          : `No host event for ${elapsed ?? "a while"}. Muse may still be working.`}${
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
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="log"
      aria-live="off"
      aria-label="Conversation messages"
      aria-keyshortcuts="Home End PageUp PageDown"
      aria-busy={running || reconciling}
      data-entry-count={entries.length}
      data-window-start={safeWindowStart}
      data-window-end={safeWindowEnd}
    >
      {streamWindowed && (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {windowAnnouncement}
        </span>
      )}
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
      {streamWindowed && windowPadding.top > 0 && (
        <div
          className="stream-window-spacer"
          aria-hidden="true"
          style={{ height: `${windowPadding.top}px` }}
        />
      )}
      {streamWindowed && safeWindowStart > 0 && (
        <div className="stream-window-notice" role="status" aria-live="polite">
          <button type="button" onClick={loadOlderMessages}>
            Load older messages
          </button>
          <span>
            Showing messages {safeWindowStart + 1}–{safeWindowEnd} of {entries.length}.
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
        const entryA11y = streamEntryA11y(roleLabel(e), entryIndex, entries.length);
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
              role={entryA11y.role}
              aria-posinset={entryA11y.position}
              aria-setsize={entryA11y.setSize}
              aria-label={entryA11y.label}
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
        const subagentStatus = e.subagentStatus ?? (e.open === true ? "running" : "completed");
        const subagentTerminal = isTerminalSubagentStatus(subagentStatus);
        const subagentResumable =
          subagentStatus === "interrupted" ||
          subagentStatus === "stopped" ||
          subagentStatus === "paused";
        return e.role === "subagent" ? (
          <details
            key={e.id}
            className={`msg subagent subagent-${subagentStatus}`}
            data-entry-index={entryIndex}
          >
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
              <span className="subagent-status" data-status={subagentStatus}>
                {subagentStatusLabel(subagentStatus)}
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
                  disabled={busy === e.id || subagentTerminal}
                  onClick={() => controls.onInterrupt(agentOf(e))}
                  title="subagent/interrupt"
                >
                  Interrupt
                </button>
                <button
                  type="button"
                  disabled={busy === e.id || subagentTerminal}
                  onClick={() => controls.onStop(agentOf(e))}
                  title="subagent/stop"
                >
                  Stop
                </button>
                <button
                  type="button"
                  disabled={busy === e.id || !subagentResumable}
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
          <div
            key={e.id}
            className={`msg ${e.role}`}
            data-entry-index={entryIndex}
            role={entryA11y.role}
            aria-posinset={entryA11y.position}
            aria-setsize={entryA11y.setSize}
            aria-label={entryA11y.label}
          >
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
            {e.role === "tool" && e.outputRef && (
              <div className="tool-output-loader">
                <button
                  type="button"
                  className="tool-output-button"
                  onClick={() => void runOutput(e)}
                  disabled={loadedOutputs[e.id]?.loading || loadedOutputs[e.id]?.eof}
                >
                  {loadedOutputs[e.id]?.loading
                    ? "Loading output…"
                    : loadedOutputs[e.id]?.eof
                      ? "Output loaded"
                      : loadedOutputs[e.id]
                        ? "Load more output"
                        : "Load full output"}
                </button>
                {loadedOutputs[e.id] && (
                  <>
                    <span className="tool-output-meta">
                      {loadedOutputs[e.id].byteLen.toLocaleString()} bytes loaded
                      {loadedOutputs[e.id].eof ? " · complete" : " · more available"}
                    </span>
                    <pre className="tool-output-content">{loadedOutputs[e.id].content}</pre>
                  </>
                )}
              </div>
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
      {streamWindowed && windowPadding.bottom > 0 && (
        <div
          className="stream-window-spacer"
          aria-hidden="true"
          style={{ height: `${windowPadding.bottom}px` }}
        />
      )}
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
          {(health === "stalled" || health === "waiting-host" || health === "retrying") && (
            <span className="stream-health-actions">
              {onReconcile && (
                <button type="button" onClick={onReconcile} disabled={reconciling}>
                  {reconciling ? "Syncing…" : "Sync now"}
                </button>
              )}
              {onReconnect && (
                <button type="button" onClick={onReconnect} disabled={reconnecting}>
                  {reconnecting ? "Reconnecting…" : "Reconnect"}
                </button>
              )}
              {onCancel && (
                stopping && health === "stalled" && onForceStop ? (
                  <button type="button" className="quiet" onClick={onForceStop}>
                    Close conversation
                  </button>
                ) : (
                  <button type="button" className="quiet" onClick={onCancel}>
                    {health === "retrying" ? "Stop retry" : "Stop"}
                  </button>
                )
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