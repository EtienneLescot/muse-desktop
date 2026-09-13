/**
 * US-4 thread compaction: local extractive summaries, no model call.
 *
 * The muse token threshold is unsourced ([TROU] spec §3.1 US-4), so
 * compaction is driven by persisted-log entry counts instead:
 * - COMPACT_WARN_ENTRIES (1500): the UI suggests compacting.
 * - COMPACT_AUTO_ENTRIES (2000): the persisted-log cap (persist.ts
 *   MAX_LOG_ENTRIES) — the hook auto-builds a summary at this point.
 *
 * `/compact` typed in the composer is intercepted at send time (hook
 * `sendInput`) and never forwarded to the model. The summary is stored
 * per source session in localStorage; a compacted thread is any thread
 * with a stored summary, and `New From Summary` opens a fresh thread
 * pre-filled with the formatted summary text.
 */
import type { LogEntry } from "./persist";

/** Composer command intercepted at send time (never sent to the model). */
export const COMPACT_COMMAND = "/compact";

/** Suggest manual compaction once the log reaches this many entries. */
export const COMPACT_WARN_ENTRIES = 1500;

/** Auto-build a summary once the log reaches this many entries. */
export const COMPACT_AUTO_ENTRIES = 2000;

/** Max items kept per summary section (keeps the prefill small). */
export const MAX_SUMMARY_ITEMS = 8;

/** Max chars kept per extracted line. */
export const MAX_SUMMARY_LINE = 200;

/** Max chars for the first-user / last-assistant excerpts. */
export const MAX_SUMMARY_EXCERPT = 500;

export interface ThreadSummary {
  sourceSessionId: string;
  createdAt: number;
  /** Persisted-log length at compaction time. */
  entryCount: number;
  /** Decisions/outcomes (approvals, input answers, decided lines). */
  decisions: string[];
  /** What the user asked (user entries, newest-relevant first kept in order). */
  context: string[];
  /** Open action items found in the log. */
  todos: string[];
  /** First user message (thread intent). */
  firstUser: string;
  /** Last assistant message (where the thread stands). */
  lastAssistant: string;
}

/**
 * True when the composer text is a `/compact` invocation: the command
 * alone (any casing/outer whitespace) or followed by whitespace + args.
 * Never matches `/compacted`, `/foo`, or an embedded occurrence.
 */
export function isCompactCommand(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < COMPACT_COMMAND.length) return false;
  if (trimmed.slice(0, COMPACT_COMMAND.length).toLowerCase() !== COMPACT_COMMAND) {
    return false;
  }
  const rest = trimmed.slice(COMPACT_COMMAND.length);
  return rest.length === 0 || /^\s/.test(rest);
}

/** True once the log is long enough to suggest manual compaction. */
export function needsCompaction(entryCount: number): boolean {
  return entryCount >= COMPACT_WARN_ENTRIES;
}

/** True once the log hit the persisted cap: auto-build the summary. */
export function needsAutoCompaction(entryCount: number): boolean {
  return entryCount >= COMPACT_AUTO_ENTRIES;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Lines that read as a decision or recorded outcome. */
function isDecisionLike(e: LogEntry): boolean {
  if (e.role === "tool" || e.role === "system") return e.text.trim().length > 0;
  return /décision|decision|decided|décidé|approved|approuv|conclu|retenu|choisi|choice|outcome/i.test(
    e.text,
  );
}

/** Lines that read as an open action item. */
function todoLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (
      /^\s*[-*]\s+\[[ xX]\]/.test(raw) ||
      /^(☐|☑|☐)/.test(line) ||
      /\bTODO\b/i.test(line)
    ) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Build a structured extractive summary of a thread log. Pure and local:
 * no model call, only truncation + keyword/role extraction.
 */
export function buildSummary(sourceSessionId: string, log: LogEntry[]): ThreadSummary {
  const decisions: string[] = [];
  const context: string[] = [];
  const todos: string[] = [];
  let firstUser = "";
  let lastAssistant = "";

  for (const e of log) {
    const text = e.text.trim();
    if (text.length === 0) continue;
    if (e.role === "user") {
      if (firstUser === "") firstUser = clip(text, MAX_SUMMARY_EXCERPT);
      if (context.length < MAX_SUMMARY_ITEMS) {
        context.push(clip(text, MAX_SUMMARY_LINE));
      }
    } else if (e.role === "assistant") {
      lastAssistant = clip(text, MAX_SUMMARY_EXCERPT);
    }
    if (decisions.length < MAX_SUMMARY_ITEMS && isDecisionLike(e)) {
      decisions.push(clip(text, MAX_SUMMARY_LINE));
    }
    if (todos.length < MAX_SUMMARY_ITEMS) {
      for (const t of todoLines(e.text)) {
        if (todos.length >= MAX_SUMMARY_ITEMS) break;
        const clipped = clip(t, MAX_SUMMARY_LINE);
        if (!todos.includes(clipped)) todos.push(clipped);
      }
    }
  }

  return {
    sourceSessionId,
    createdAt: Date.now(),
    entryCount: log.length,
    decisions,
    context,
    todos,
    firstUser,
    lastAssistant,
  };
}

/** Render a summary as prefill markdown for a fresh thread. */
export function formatSummaryText(s: ThreadSummary): string {
  const lines: string[] = [
    `Suite du thread ${s.sourceSessionId.slice(0, 8)} (résumé local, ${s.entryCount} entrées) :`,
    "",
  ];
  if (s.firstUser !== "") {
    lines.push("Demande initiale :", s.firstUser, "");
  }
  if (s.context.length > 0) {
    lines.push("Contexte :");
    for (const c of s.context) lines.push(`- ${c}`);
    lines.push("");
  }
  if (s.decisions.length > 0) {
    lines.push("Décisions :");
    for (const d of s.decisions) lines.push(`- ${d}`);
    lines.push("");
  }
  if (s.todos.length > 0) {
    lines.push("À faire :");
    for (const t of s.todos) lines.push(`- ${t}`);
    lines.push("");
  }
  if (s.lastAssistant !== "") {
    lines.push("Dernier état :", s.lastAssistant);
  }
  return lines.join("\n").trimEnd();
}

const summaryKey = (sessionId: string) => `muse-desktop.summary.v1.${sessionId}`;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort like persist.ts: the live session keeps working in memory
  }
}

function isValidSummary(s: unknown): s is ThreadSummary {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.sourceSessionId === "string" &&
    typeof r.createdAt === "number" &&
    typeof r.entryCount === "number" &&
    Array.isArray(r.decisions) &&
    Array.isArray(r.context) &&
    Array.isArray(r.todos) &&
    typeof r.firstUser === "string" &&
    typeof r.lastAssistant === "string"
  );
}

export function loadSummary(sessionId: string): ThreadSummary | null {
  const raw = read<unknown>(summaryKey(sessionId), null);
  return isValidSummary(raw) ? raw : null;
}

export function saveSummary(summary: ThreadSummary): void {
  write(summaryKey(summary.sourceSessionId), summary);
}

export function dropSummary(sessionId: string): void {
  try {
    localStorage.removeItem(summaryKey(sessionId));
  } catch {
    // best-effort
  }
}
