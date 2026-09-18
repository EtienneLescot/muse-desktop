/**
 * US-4 thread compaction, two halves:
 *
 * - Local extractive summaries, no model call. Entry counts drive the
 *   recap UI (the token threshold now has a real source — see below):
 *   COMPACT_WARN_ENTRIES (1500) suggests, COMPACT_AUTO_ENTRIES (2000,
 *   the persist.ts cap) auto-builds a summary.
 * - Server context compaction (`session/compact`, admission-only `accepted`
 *   / `noop`): frees the host context window for real. The host reports
 *   occupancy via `session/contextUsage` (windowTokens/usedTokens/pressure
 *   triple, emitted on change) — the UI surfaces it and suggests the
 *   server gesture from `warning` pressure up. The server gesture never
 *   runs automatically: it is async host work, the user clicks.
 *
 * `/compact` typed in the composer is intercepted at send time (hook
 * `sendInput`) and never forwarded to the model. The summary is stored
 * per source session in localStorage; a compacted thread is any thread
 * with a stored summary, and `New From Summary` opens a fresh thread
 * pre-filled with the formatted summary text.
 */
import type { LogEntry } from "./persist";
import { readStorageJson, removeStorageKey, writeStorageJson } from "./storage.ts";

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

/**
 * Provider-reported context occupancy for one session
 * (`session/contextUsage` triple). `pressure` is the host-computed level
 * (`normal`/`warning`/`blocked`, open enum — unknown levels pass through);
 * token counts are null when the host omits them.
 */
export interface ContextUsage {
  pressure: string;
  usedTokens: number | null;
  windowTokens: number | null;
  /** Latest provider counters, when the host emits session/tokenUsage. */
  tokenUsage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  turnId?: string;
}

/** Renderer-only state for the asynchronous host compaction gesture. */
export type ServerCompactionStatus = "idle" | "pending" | "accepted" | "noop" | "error";

export interface ServerCompactionState {
  status: ServerCompactionStatus;
  /** Bounded friendly detail for the error state only. */
  message?: string;
}

/** Stable copy for the compact-bar status; no wire terminology leaks into UI. */
export function serverCompactionStatusLabel(state: ServerCompactionState): string {
  switch (state.status) {
    case "pending":
      return "Compacting engine context…";
    case "accepted":
      return "Compaction accepted — waiting for the engine…";
    case "noop":
      return "Engine context is already compact.";
    case "error":
      return state.message?.trim() || "Engine compaction could not be completed.";
    default:
      return "";
  }
}

/** Parse a `context_usage` poll payload; null when it is not an object. */
export function parseContextUsage(raw: unknown): ContextUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pressure =
    typeof o["pressure"] === "string" && o["pressure"].length > 0
      ? o["pressure"]
      : "unknown";
  const num = (k: string): number | null =>
    typeof o[k] === "number" && Number.isFinite(o[k])
      ? (o[k] as number)
      : null;
  return {
    pressure,
    usedTokens: num("usedTokens"),
    windowTokens: num("windowTokens"),
  };
}

/**
 * True when the host pressure warrants suggesting the server gesture
 * (`warning` and up; `unknown` never suggests — no data, no nag).
 */
export function suggestsServerCompaction(usage: ContextUsage | null): boolean {
  if (usage === null) return false;
  return usage.pressure === "warning" || usage.pressure === "blocked";
}

/** Human occupancy line for the bar (`1.2M / 2.0M tokens · warning`). */
export function formatUsage(usage: ContextUsage): string {
  const fmt = (n: number | null): string =>
    n === null
      ? "?"
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(0)}k`
          : `${n}`;
  return `${fmt(usage.usedTokens)} / ${fmt(usage.windowTokens)} tokens · ${usage.pressure}`;
}

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
    `Continuation of thread ${s.sourceSessionId.slice(0, 8)} (local summary, ${s.entryCount} entries):`,
    "",
  ];
  if (s.firstUser !== "") {
    lines.push("Initial request:", s.firstUser, "");
  }
  if (s.context.length > 0) {
    lines.push("Context:");
    for (const c of s.context) lines.push(`- ${c}`);
    lines.push("");
  }
  if (s.decisions.length > 0) {
    lines.push("Decisions:");
    for (const d of s.decisions) lines.push(`- ${d}`);
    lines.push("");
  }
  if (s.todos.length > 0) {
    lines.push("To do:");
    for (const t of s.todos) lines.push(`- ${t}`);
    lines.push("");
  }
  if (s.lastAssistant !== "") {
    lines.push("Last state:", s.lastAssistant);
  }
  return lines.join("\n").trimEnd();
}

const summaryKey = (sessionId: string) => `muse-desktop.summary.v1.${sessionId}`;

function read<T>(key: string, fallback: T): T {
  return readStorageJson(key, fallback);
}

/** Parse the host's session/tokenUsage projection without re-deriving totals. */
export function parseTokenUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const cumulative = typeof o.cumulative === "object" && o.cumulative !== null
    ? o.cumulative as Record<string, unknown>
    : null;
  const usage = typeof o.usage === "object" && o.usage !== null
    ? o.usage as Record<string, unknown>
    : null;
  const num = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return typeof value === "number" ? value : null;
  };
  const promptTokens = num(o.promptTokens, cumulative?.promptTokens);
  const outputTokens = num(usage?.outputTokens, cumulative?.outputTokens);
  const totalTokens = num(o.totalTokens, cumulative?.totalTokens);
  if (promptTokens === null && outputTokens === null && totalTokens === null) return null;
  const turnId = typeof o.turnId === "string" && o.turnId.trim().length > 0 ? o.turnId : undefined;
  return { promptTokens, outputTokens, totalTokens, ...(turnId ? { turnId } : {}) };
}

function write(key: string, value: unknown): void {
  writeStorageJson(key, value);
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
  removeStorageKey(summaryKey(sessionId));
}
