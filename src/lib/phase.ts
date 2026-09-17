/**
 * US-10 reflexive phase: event-kind mapping + placeholder helpers.
 *
 * After a send the turn reflects before the first token lands. The UI must
 * show that reflexive phase immediately (<200ms, synchronously on send) and
 * keep it visible when `item/started` arrives without any delta yet.
 *
 * The placeholder entry carries empty text while open: the first delta
 * coalesces into it, so no label ever leaks into the streamed content. The
 * "thinking…" label is rendered by StreamView, never stored in the log.
 */
import type { LogEntry } from "./persist";

/** Label rendered (never stored) for an open entry with no text yet. */
export const REFLEXIVE_LABEL = "thinking…";

/** Item kinds routed to the subagent lane (mirrors main.rs routing). */
const SUBAGENT_ITEM_KINDS = new Set(["subagent", "workflow", "reminderchild"]);

/** Item kinds that carry model reasoning in the collapsible thinking lane. */
const THINKING_ITEM_KINDS = new Set([
  "reasoning",
  "thinking",
  "analysis",
  "reasoning_summary",
  "reasoningsummary",
]);

/**
 * Lowercase + strip the `turn/`-style namespace: `turn/started` -> `started`,
 * `ITEM/STARTED` -> `started`. Bare kinds (`turn_start`) pass through.
 */
export function normalizeKind(kind: string): string {
  const lower = kind.toLowerCase();
  const slash = lower.lastIndexOf("/");
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/** True for `item/started` in either separator style (never for turn kinds). */
export function isItemStartKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "item_started" || k === "item/started";
}

/** True while the child is (still) reflecting/streaming: paint liveness. */
export function isRunningKind(kind: string): boolean {
  if (isItemStartKind(kind)) return true;
  const base = normalizeKind(kind);
  return (
    base === "started" ||
    base === "running" ||
    base === "created" ||
    base === "turn_start"
  );
}

/** True when the child is no longer producing output. */
export function isStoppedKind(kind: string): boolean {
  const base = normalizeKind(kind);
  return (
    base === "cancelled" ||
    base === "retracted" ||
    base === "completed" ||
    base === "stopped" ||
    base === "exited" ||
    base === "host_exited" ||
    base === "error" ||
    base === "failed" ||
    base === "failure" ||
    base === "success" ||
    base === "succeeded" ||
    base === "done" ||
    base === "aborted" ||
    base === "interrupted" ||
    base === "timeout" ||
    base === "timed_out" ||
    base === "terminated" ||
    base === "rejected" ||
    base === "turn_end" ||
    base === "idle"
  );
}

export type StreamPhase = "reflexive" | "streaming" | "stopped" | "other";

/**
 * Map a backend event kind to its stream phase. `reflexive` covers both the
 * turn start and the item start (pre-first-token); `streaming` covers live
 * chunk lanes plus per-item completion.
 */
export function phaseForKind(kind: string): StreamPhase {
  if (isItemStartKind(kind) || isRunningKind(kind)) return "reflexive";
  if (isStoppedKind(kind)) return "stopped";
  const base = normalizeKind(kind);
  if (
    base === "output" ||
    isThinkingItemKind(kind) ||
    base === "subagent_event" ||
    base === "item_done"
  ) {
    return "streaming";
  }
  return "other";
}

/** True for MSP item kinds that belong in the subagent lane. */
export function isSubagentItemKind(itemKind: string): boolean {
  return SUBAGENT_ITEM_KINDS.has(itemKind.toLowerCase());
}

/** True for reasoning item kinds emitted by the host. */
export function isThinkingItemKind(itemKind: string): boolean {
  return THINKING_ITEM_KINDS.has(normalizeKind(itemKind));
}

export interface PlaceholderStamp {
  id: string;
  ts: number;
}

function lastIndex(
  log: LogEntry[],
  pred: (e: LogEntry) => boolean,
): number {
  for (let i = log.length - 1; i >= 0; i--) {
    if (pred(log[i])) return i;
  }
  return -1;
}

/**
 * Ensure a visible open entry for the reflexive phase. Reuses the live entry
 * when one exists (stamping the item id onto a send-time placeholder that
 * has none yet); otherwise appends an empty open entry. Returns the input
 * array unchanged when nothing had to change.
 */
export function upsertReflexivePlaceholder(
  log: LogEntry[],
  opts: {
    itemId?: string;
    turnId?: string;
    agentId?: string;
    role?: "assistant" | "thinking";
    stamp: PlaceholderStamp;
  },
): LogEntry[] {
  const { itemId, turnId, agentId, role = "assistant", stamp } = opts;
  if (agentId !== undefined) {
    const i = lastIndex(
      log,
      (e) => e.open === true && e.role === "subagent" && e.agentId === agentId,
    );
    if (i >= 0) return log;
    return [
      ...log,
      {
        id: stamp.id,
        ts: stamp.ts,
        role: "subagent",
        text: "",
        agentId,
        itemId,
        ...(turnId ? { turnId } : {}),
        open: true,
      },
    ];
  }
  if (role === "thinking") {
    // The send path paints an assistant-shaped placeholder before item/started
    // identifies the item. Promote it to avoid two stacked indicators.
    const unbound = lastIndex(
      log,
      (e) =>
        e.open === true &&
        e.role === "assistant" &&
        e.text === "" &&
        e.itemId === undefined,
    );
    if (unbound >= 0) {
      return log.map((e, j) =>
        j === unbound ? { ...e, role: "thinking", itemId, ...(turnId ? { turnId } : {}) } : e,
      );
    }
    const live = lastIndex(
      log,
      (e) =>
        e.open === true &&
        e.role === "thinking" &&
        (itemId === undefined || e.itemId === itemId),
    );
    if (live >= 0) return log;
    return [
      ...log,
      { id: stamp.id, ts: stamp.ts, role: "thinking", text: "", itemId, ...(turnId ? { turnId } : {}), open: true },
    ];
  }
  const i = lastIndex(log, (e) => e.open === true && e.role === "assistant");
  if (i >= 0) {
    if (itemId !== undefined && log[i].itemId === undefined) {
      return log.map((e, j) => (j === i ? { ...e, itemId, ...(turnId ? { turnId } : {}) } : e));
    }
    return log;
  }
  return [
    ...log,
    { id: stamp.id, ts: stamp.ts, role: "assistant", text: "", itemId, ...(turnId ? { turnId } : {}), open: true },
  ];
}

/**
 * Drop still-empty reflexive placeholders (e.g. the send failed before any
 * delta could land). Entries that already carry text are never touched.
 */
export function dropEmptyPlaceholders(log: LogEntry[]): LogEntry[] {
  if (!log.some((e) => e.open === true && e.text === "")) return log;
  return log.filter(
    (e) =>
      !(
        e.open === true &&
        e.text === "" &&
        (e.role === "assistant" || e.role === "thinking" || e.role === "subagent")
      ),
  );
}
