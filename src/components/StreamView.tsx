import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { LogEntry } from "../lib/persist";
import { isTauriRuntime } from "../lib/env";
import type { ItemOutputChunk } from "../hooks/useMuseSessions";
import { REFLEXIVE_LABEL } from "../lib/phase";
import { childSessionLabel, subagentControlAvailability, subagentSummary } from "../lib/subagent";
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
  streamRecoveryDetail,
  streamHealthLabel,
  type RetryScheduled,
  type StreamRecoveryNotice,
  type StreamHealth,
} from "../lib/streamHealth";
import {
  cycleTranscriptHit,
  searchTranscript,
  type TranscriptHit,
} from "../lib/transcriptSearch";
import { streamEntryA11y, streamWindowAnnouncement } from "../lib/streamA11y";
import { streamNavigationTarget } from "../lib/streamNavigation";
import { subagentStatusLabel } from "../lib/subagent";
import { officePreviewForFile, type OfficePreview } from "../lib/officePreview";
import { MessageContent } from "./MessageContent";
import { loadStreamPosition, saveStreamPosition } from "../lib/streamPosition";

const MAX_INLINE_RICH_PDF_BYTES = 5 * 1024 * 1024;

function outputDownloadName(entry: LogEntry, mediaType?: string): string {
  const source = entry.richContent?.[0]?.path ?? "muse-output";
  const basename = source.split(/[\\/]/).pop() ?? "muse-output";
  const safe = basename.replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 120) || "muse-output";
  if (safe.includes(".")) return safe;
  const extension = mediaTypeExtension(mediaType);
  return extension ? `${safe}.${extension.replace(/[^a-z0-9.+-]/gi, "")}` : `${safe}.txt`;
}

function mediaTypeExtension(mediaType?: string): string | undefined {
  const normalized = mediaType?.toLowerCase().split(";", 1)[0];
  if (!normalized) return undefined;
  if (normalized.startsWith("image/")) return normalized.slice(6);
  const known: Record<string, string> = {
    "application/pdf": "pdf",
    "application/json": "json",
    "text/csv": "csv",
    "text/markdown": "md",
    "text/plain": "txt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
    "application/rtf": "rtf",
    "text/rtf": "rtf",
  };
  return known[normalized];
}

function isWorkspaceRelativePath(value: string): boolean {
  const path = value.trim();
  return path.length > 0
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    && !/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(path);
}

function downloadLoadedOutput(entry: LogEntry, loaded: { content: string; base64Data?: string; mediaType?: string }): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return;
  let blob: Blob;
  if (loaded.base64Data !== undefined) {
    if (typeof atob !== "function") return;
    try {
      const binary = atob(loaded.base64Data);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      blob = new Blob([bytes], { type: loaded.mediaType ?? "application/octet-stream" });
    } catch {
      return;
    }
  } else {
    blob = new Blob([loaded.content], { type: "text/plain;charset=utf-8" });
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = outputDownloadName(entry, loaded.mediaType);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function saveLoadedOutput(
  entry: LogEntry,
  loaded: { content: string; base64Data?: string; mediaType?: string },
): Promise<void> {
  const filename = outputDownloadName(entry, loaded.mediaType);
  if (!isTauriRuntime()) {
    downloadLoadedOutput(entry, loaded);
    return;
  }
  const target = await save({
    title: "Save Muse output",
    defaultPath: filename,
  });
  if (typeof target !== "string" || target.trim() === "") return;
  const data = loaded.base64Data ?? utf8Base64(loaded.content);
  await invoke("output_export", { path: target, data });
}

function RichOfficeTable({ preview }: { preview: OfficePreview }) {
  return (
    <div className="file-structured-preview" role="region" aria-label={preview.format.toUpperCase() + " output preview"}>
      <div className="file-structured-meta">
        <span>{preview.format.toUpperCase()} · {preview.rows.length} rows</span>
        {preview.truncated && <span>Preview limited for safety</span>}
      </div>
      <div className="file-structured-scroll">
        <table>
          <caption className="sr-only">Structured preview of rich output</caption>
          <thead>
            <tr>
              {preview.columns.map((column, index) => <th scope="col" key={column + "-" + index}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={"output-row-" + rowIndex}>
                {preview.columns.map((_, columnIndex) => (
                  <td key={"output-cell-" + rowIndex + "-" + columnIndex}>{row[columnIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** US-6 controls for one sub-agent block. Read-result and drill-down resolve
 *  to display text (also logged as system lines by the hook); the rest are
 *  fire-and-forget with errors surfaced in the hook error banner. */
export interface SubagentControls {
  /** `subagent/close`: the host carries an optional owner reason. */
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
  /** Bounded result of a host recovery read, kept outside the transcript. */
  recoveryNotice?: StreamRecoveryNotice | null;
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
  /** Open a verified workspace output with the system default application. */
  onOpenWorkspacePath?: (path: string) => Promise<void>;
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
  recoveryNotice = null,
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
  onOpenWorkspacePath,
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
    base64Data?: string;
    mediaType?: string;
    nextOffsetBytes: number;
    byteLen: number;
    eof: boolean;
    loading: boolean;
  }>>({});
  const [outputError, setOutputError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A control's failure belongs to its block, not to the page. The banner still
  // carries the host's exact words; this says which agent and which action.
  const [failed, setFailed] = useState<Record<string, string>>({});
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
  const persistViewportTimerRef = useRef<number | null>(null);

  function scheduleViewportPersistence(id: string | null, top: number, start: number): void {
    if (id === null || !Number.isFinite(top) || !Number.isFinite(start)) return;
    if (persistViewportTimerRef.current !== null) {
      window.clearTimeout(persistViewportTimerRef.current);
    }
    persistViewportTimerRef.current = window.setTimeout(() => {
      persistViewportTimerRef.current = null;
      saveStreamPosition(id, top, start);
    }, 180);
  }

  function appendBase64(first: string | undefined, second: string): string {
    if (!first) return second;
    if (typeof atob !== "function" || typeof btoa !== "function") return `${first}${second}`;
    try {
      const left = atob(first);
      const right = atob(second);
      const bytes = new Uint8Array(left.length + right.length);
      for (let i = 0; i < left.length; i++) bytes[i] = left.charCodeAt(i);
      for (let i = 0; i < right.length; i++) bytes[left.length + i] = right.charCodeAt(i);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
      }
      return btoa(binary);
    } catch {
      return `${first}${second}`;
    }
  }

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
  const visibleEntrySignature = useMemo(
    () => visibleEntries.map((entry) => entry.id).join("\u001f"),
    [visibleEntries],
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
    const persisted = loadStreamPosition(sessionId);
    const next = initialStreamWindowStart(entries.length, saved ?? persisted?.windowStart);
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
    if (sessionId !== null && scrollTopsRef.current[key] === undefined && persisted !== null) {
      scrollTopsRef.current[key] = persisted.scrollTop;
    }
  }, [sessionId]);

  useEffect(() => () => {
    if (persistViewportTimerRef.current !== null) {
      window.clearTimeout(persistViewportTimerRef.current);
      persistViewportTimerRef.current = null;
    }
    if (sessionId === null) return;
    const key = sessionId;
    const top = scrollTopsRef.current[key];
    const start = windowStartsRef.current[key] ?? 0;
    if (top !== undefined) saveStreamPosition(key, top, start);
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
      if (event.key === "Escape") {
        // Escape closes the finder from anywhere inside the transcript.
        //
        // The input takes focus when the bar opens and then loses it to some
        // other control, so an Escape handler bound to the input alone never
        // fires in practice: measured, focus lands on the input at +80ms and is
        // gone by +200ms. Closing the shortcut's own UI has to work whatever
        // holds focus, or Ctrl/Cmd+F opens a bar the user cannot dismiss from
        // the keyboard.
        setFindOpen((open) => {
          if (!open) return false;
          setFindQuery("");
          setFindSelection(null);
          return false;
        });
        return;
      }
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
  }, [safeWindowEnd, safeWindowStart, streamWindowed, visibleEntrySignature]);

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
    if (sessionId === null || streamRef.current === null) return;
    scheduleViewportPersistence(sessionId, streamRef.current.scrollTop, safeWindowStart);
  }, [safeWindowStart, sessionId]);

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
    scheduleViewportPersistence(sessionId, el.scrollTop, safeWindowStart);
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
      if (text !== null) {
        setShown((cur) => ({ ...cur, [entry.id]: text }));
      } else {
        setFailed((cur) => ({
          ...cur,
          [entry.id]:
            kind === "result"
              ? "The host returned no result for this agent."
              : "The host returned no conversation for this agent.",
        }));
      }
    } catch (error) {
      setFailed((cur) => ({
        ...cur,
        [entry.id]: error instanceof Error ? error.message : String(error),
      }));
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
        const binary = chunk.base64Data !== undefined;
        return {
          ...cur,
          [entry.id]: {
            content: binary ? (append ? current.content : "") : (append ? `${current.content}${chunk.content}` : chunk.content),
            ...(binary
              ? { base64Data: appendBase64(append ? current?.base64Data : undefined, chunk.base64Data!) }
              : current?.base64Data === undefined ? {} : { base64Data: current.base64Data }),
            ...((chunk.mediaType ?? entry.richContent?.[0]?.mediaType) === undefined
              ? {}
              : { mediaType: chunk.mediaType ?? entry.richContent?.[0]?.mediaType }),
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
      {/*
        Find-in-conversation, on demand. The persistent trigger was removed: it
        occupied a 42px band plus a full-width backdrop at all times — 10% of the
        transcript's visible height — and, being a 760px card in a ~1034px stream,
        read as a widget floating over the conversation. Ctrl/Cmd+F opens it; the
        dock is not rendered at all otherwise, so nothing takes space when the
        user has not asked for it.

        Measured before the change: docs/evidence/2026-09-21-ux/find-bar-flottante.md
      */}
      {findOpen && (
        <div className="stream-find-dock">
          <div className="stream-find" aria-label="Find in conversation">
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
          </div>
          {findHits.length > 0 && (
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
      )}
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
        const loadedOutput = loadedOutputs[e.id];
        const richPath = e.richContent?.[0]?.path ?? "";
        const richMediaType = loadedOutput?.mediaType ?? e.richContent?.[0]?.mediaType ?? "";
        const richOfficePreview = loadedOutput?.eof && loadedOutput.base64Data &&
          (richMediaType.startsWith("application/vnd.openxmlformats")
            || richMediaType.startsWith("application/vnd.oasis.opendocument")
            || richMediaType === "application/rtf"
            || richMediaType === "text/rtf")
          ? officePreviewForFile(richPath, loadedOutput.base64Data)
          : null;
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
        // One table decides what each control may do, and says why when it may
        // not. The previous ad-hoc booleans left every button enabled on a
        // finished agent, where each click could only fail.
        const subagentActions = subagentControlAvailability(subagentStatus, {
          busy: busy === e.id,
          hasChildSession: typeof e.childSessionId === "string" && e.childSessionId !== "",
        });
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
              <div className="muted subagent-child" title={e.childSessionId}>
                child: {childSessionLabel(e.childSessionId)}
              </div>
            )}
            {controls && (
              <div className="subagent-controls">
                <button
                  type="button"
                  disabled={!subagentActions.interrupt.enabled}
                  onClick={() => controls.onInterrupt(agentOf(e))}
                  title={subagentActions.interrupt.reason ?? "subagent/interrupt"}
                >
                  Interrupt
                </button>
                <button
                  type="button"
                  disabled={!subagentActions.stop.enabled}
                  onClick={() => controls.onStop(agentOf(e))}
                  title={subagentActions.stop.reason ?? "subagent/stop"}
                >
                  Stop
                </button>
                <button
                  type="button"
                  disabled={!subagentActions.resume.enabled}
                  onClick={() => controls.onResume(agentOf(e))}
                  title={subagentActions.resume.reason ?? "subagent/resume"}
                >
                  Resume
                </button>
                <button
                  type="button"
                  disabled={!subagentActions.followup.enabled}
                  onClick={() => {
                    setFollowupFor(followupFor === e.id ? null : e.id);
                    setFollowupText("");
                  }}
                  title={subagentActions.followup.reason ?? "subagent/followupTask"}
                >
                  Follow up
                </button>
                <button
                  type="button"
                  disabled={!subagentActions.readResult.enabled}
                  onClick={() => void runResult(e, "result")}
                  title={subagentActions.readResult.reason ?? "subagent/readResult"}
                >
                  Read result
                </button>
                {e.childSessionId && (
                  <button
                    type="button"
                    disabled={!subagentActions.drilldown.enabled}
                    onClick={() => void runResult(e, "drilldown")}
                    title={subagentActions.drilldown.reason ?? "session/read"}
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
            {failed[e.id] && (
              <p className="subagent-failure" role="alert">
                {failed[e.id]}
              </p>
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
            {e.richContent && e.richContent.length > 0 && (
              <div className="rich-content-list" aria-label="Rich output">
                {e.richContent.map((content, index) => (
                  <div className="rich-content-meta" key={`${content.path}-${index}`}>
                    <strong>{content.type}</strong>
                    <span>{content.mediaType}</span>
                    <span title={content.path}>{content.path}</span>
                    <small>from {content.sourceToolName}</small>
                    {(content.width !== undefined && content.height !== undefined) && (
                      <small>{content.width}×{content.height}</small>
                    )}
                  </div>
                ))}
              </div>
            )}
            {e.outputRef && (e.role === "tool" || (e.richContent?.length ?? 0) > 0) && (
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
                        : e.richContent && e.richContent.length > 0
                          ? "Preview output"
                          : "Load full output"}
                </button>
                {loadedOutput && (
                  <>
                    <span className="tool-output-meta">
                      {loadedOutput.byteLen.toLocaleString()} bytes loaded
                      {loadedOutput.eof ? " · complete" : " · more available"}
                    </span>
                    {loadedOutput.eof && (loadedOutput.content.length > 0 || loadedOutput.base64Data) && (
                      <button
                        type="button"
                        className="tool-output-button"
                        onClick={() => {
                          setOutputError(null);
                          void saveLoadedOutput(e, loadedOutput).catch((error) => {
                            setOutputError(error instanceof Error ? error.message : String(error));
                          });
                        }}
                      >
                        Save output
                      </button>
                    )}
                    {loadedOutput.eof && onOpenWorkspacePath && e.richContent?.[0]?.path && isWorkspaceRelativePath(e.richContent[0].path) && (
                      <button
                        type="button"
                        className="tool-output-button"
                        onClick={() => void onOpenWorkspacePath(e.richContent![0].path)}
                        title="Open the verified workspace output with the system default application"
                      >
                        Open in app
                      </button>
                    )}
                    {outputError && <span className="error">{outputError}</span>}
                    {loadedOutput.base64Data && loadedOutput.mediaType?.startsWith("image/") && loadedOutput.eof ? (
                      <img
                        className="rich-content-preview"
                        src={"data:" + loadedOutput.mediaType + ";base64," + loadedOutput.base64Data}
                        alt="Muse rich output preview"
                      />
                    ) : loadedOutput.base64Data && loadedOutput.mediaType === "application/pdf" && loadedOutput.eof && loadedOutput.byteLen <= MAX_INLINE_RICH_PDF_BYTES ? (
                      <object
                        className="rich-content-pdf-preview"
                        data={"data:application/pdf;base64," + loadedOutput.base64Data}
                        type="application/pdf"
                        aria-label="Muse PDF output preview"
                      >
                        <p className="muted">This WebView cannot render the PDF. Use Download output.</p>
                      </object>
                    ) : richOfficePreview ? (
                      <RichOfficeTable preview={richOfficePreview} />
                    ) : loadedOutput.content.length > 0 ? (
                      <pre className="tool-output-content">{loadedOutput.content}</pre>
                    ) : loadedOutput.base64Data ? (
                      <p className="muted">Binary output is still loading; preview appears when complete.</p>
                    ) : null}
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
      {recoveryNotice !== null && (
        <div className="stream-recovery-note" role="status" aria-live="polite">
          <span>{streamRecoveryDetail(recoveryNotice)}</span>
          {onReconcile && (
            <button type="button" onClick={onReconcile} disabled={reconciling}>
              {reconciling ? "Checking…" : "Try again"}
            </button>
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
