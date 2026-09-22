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
import type { LogEntry, RichContent } from "./persist";

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

const TERMINAL_ITEM_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "stopped",
  "cancelled",
  "canceled",
  "retracted",
  "failed",
  "error",
  "failure",
  "success",
  "succeeded",
  "aborted",
  "interrupted",
  "timeout",
  "timed_out",
  "terminated",
  "rejected",
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
    base === "item_updated" ||
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

/**
 * Host-internal child items (`reminderchild`) are housekeeping the model never
 * asked for. They keep their own lane so their text cannot merge into the
 * answer, but they are **not** controllable sub-agents: the host publishes no
 * `subagent/*` identity for them and `session/read` on their child session
 * answers `sessionNotFound`. Rendering the interactive control console for them
 * produced blocks whose buttons could only fail, so they are hidden.
 *
 * Kind is the only discriminator available today: the supervisor announces
 * `agent_id` = item id for every sub-agent kind, so a genuine identity cannot be
 * told from an internal one on the wire. If the host later exposes a distinct
 * sub-agent id for such items, refine this to "internal unless identified".
 */
const INTERNAL_SUBAGENT_ITEM_KINDS = new Set(["reminderchild"]);

export function isInternalSubagentItemKind(itemKind: string): boolean {
  return INTERNAL_SUBAGENT_ITEM_KINDS.has(
    itemKind.toLowerCase().replace(/[\s_-]+/g, ""),
  );
}

/** True for reasoning item kinds emitted by the host. */
export function isThinkingItemKind(itemKind: string): boolean {
  return THINKING_ITEM_KINDS.has(normalizeKind(itemKind));
}

/** True for additive item snapshot statuses that close a transcript lane. */
export function isTerminalItemStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_ITEM_STATUSES.has(normalizeKind(status));
}

export type ItemSnapshotLane = "assistant" | "thinking" | "tool";

function nestedItemValue(snapshot: Record<string, unknown>, key: string): unknown {
  const direct = snapshot[key];
  if (direct !== undefined) return direct;
  const nested = snapshot.item;
  if (typeof nested === "object" && nested !== null) {
    return (nested as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Resolve the renderer lane from both the bridge's flat shape and the raw
 * MSP-style `{ item: { kind } }` shape. Hosts may omit the derived `lane`
 * while still identifying reasoning or user-shell items by kind.
 */
export function itemSnapshotLane(snapshot: Record<string, unknown>): ItemSnapshotLane {
  const explicit = typeof snapshot.lane === "string"
    ? snapshot.lane.trim().toLowerCase()
    : "";
  if (explicit === "thinking" || explicit === "reasoning") return "thinking";
  if (explicit === "tool" || explicit === "shell_output" || explicit === "shell-output") return "tool";
  const kindValue = nestedItemValue(snapshot, "itemKind") ?? nestedItemValue(snapshot, "kind") ?? nestedItemValue(snapshot, "type");
  if (typeof kindValue === "string") {
    if (isThinkingItemKind(kindValue)) return "thinking";
    const normalized = kindValue.toLowerCase().replace(/[\s_-]+/g, "");
    if (normalized === "usershell" || normalized === "shell") return "tool";
  }
  return "assistant";
}

/** True when a full item snapshot represents a terminal state. */
export function itemSnapshotIsTerminal(snapshot: Record<string, unknown>): boolean {
  if (
    snapshot.open === false ||
    snapshot.completed === true ||
    nestedItemValue(snapshot, "open") === false ||
    nestedItemValue(snapshot, "completed") === true
  ) return true;
  return isTerminalItemStatus(nestedItemValue(snapshot, "status"));
}

export interface PlaceholderStamp {
  id: string;
  ts: number;
}

export interface ItemSnapshotUpdate {
  itemId: string;
  role: "assistant" | "thinking" | "tool";
  text: string;
  turnId?: string;
  commandText?: string;
  outputRef?: string;
  richContent?: RichContent[];
  revision?: number;
  open?: boolean;
  stamp: PlaceholderStamp;
}

/**
 * Apply an MSP `item/updated` full snapshot to one transcript lane.
 *
 * Updates replace the text for the same item instead of appending it as a
 * delta. A revision, when supplied by the host, makes the operation
 * idempotent across polling/reconnect races. The helper is pure so the hook
 * remains the single state owner while tests can exercise the reconciliation
 * contract without a renderer.
 */
export function applyItemSnapshotUpdate(
  log: LogEntry[],
  update: ItemSnapshotUpdate,
): LogEntry[] {
  const itemId = update.itemId.trim();
  if (itemId.length === 0) return log;
  const matched = lastIndex(log, (entry) => entry.itemId === itemId && entry.role === update.role);
  // An approval/input decision paints a send-time placeholder before the host
  // can reveal its item id. Promote that empty lane instead of appending a
  // second assistant entry when the first progress event is `item/updated`.
  const index = matched >= 0
    ? matched
    : lastIndex(log, (entry) =>
        entry.open === true &&
        entry.role === update.role &&
        entry.itemId === undefined &&
        entry.text === "",
      );
  const existing = index >= 0 ? log[index] : undefined;
  if (
    existing !== undefined &&
    update.revision !== undefined &&
    existing.itemRevision !== undefined &&
    update.revision <= existing.itemRevision
  ) {
    return log;
  }
  // Some hosts emit a terminal full snapshot with no visible text. Keep the
  // last rendered content, bind the authoritative item id and close the lane
  // instead of leaving an already-visible thinking placeholder open forever.
  // An empty snapshot for an unknown item carries no user-visible state and
  // must not create a phantom transcript row.
  if (update.text.length === 0) {
    if (existing === undefined) return log;
    if (update.open !== false) return log;
    const nextEntry: LogEntry = {
      ...existing,
      itemId,
      ...(update.turnId === undefined ? {} : { turnId: update.turnId }),
      ...(update.revision === undefined ? {} : { itemRevision: update.revision }),
      ...(update.outputRef === undefined ? {} : { outputRef: update.outputRef }),
      ...(update.richContent === undefined ? {} : { richContent: update.richContent.map((item) => ({ ...item })) }),
      open: false,
    };
    return [...log.slice(0, index), nextEntry, ...log.slice(index + 1)];
  }
  const command = update.commandText?.trim();
  const text = update.role === "tool" && command !== undefined && command.length > 0
    ? `$ ${command}\n${update.text}`
    : update.text;
  const nextEntry: LogEntry = {
    ...(existing ?? { id: update.stamp.id, ts: update.stamp.ts }),
    role: update.role,
    text,
    itemId,
    ...(update.turnId === undefined ? {} : { turnId: update.turnId }),
    ...(update.revision === undefined ? {} : { itemRevision: update.revision }),
    ...(update.outputRef === undefined ? {} : { outputRef: update.outputRef }),
    ...(update.richContent === undefined ? {} : { richContent: update.richContent.map((item) => ({ ...item })) }),
    open: update.open ?? true,
  };
  if (index >= 0) {
    return [...log.slice(0, index), nextEntry, ...log.slice(index + 1)];
  }
  return [...log, nextEntry];
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
    role?: "assistant" | "thinking" | "tool";
    /** Optional visible seed (for example `$ command` in a user-shell item). */
    initialText?: string;
    richContent?: RichContent[];
    /** Host-internal child lane: created but never rendered as a sub-agent. */
    internal?: boolean;
    stamp: PlaceholderStamp;
  },
): LogEntry[] {
  const { itemId, turnId, agentId, role = "assistant", initialText = "", richContent, internal, stamp } = opts;
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
        ...(internal ? { subagentInternal: true } : {}),
        ...(turnId ? { turnId } : {}),
        ...(richContent === undefined ? {} : { richContent: richContent.map((item) => ({ ...item })) }),
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
      { id: stamp.id, ts: stamp.ts, role: "thinking", text: "", itemId, ...(turnId ? { turnId } : {}), ...(richContent === undefined ? {} : { richContent: richContent.map((item) => ({ ...item })) }), open: true },
    ];
  }
  if (role === "tool") {
    // A user-shell request can paint its local command before the host emits
    // item/started. Bind that open entry to the authoritative item id when it
    // arrives instead of creating a duplicate tool bubble.
    const unbound = lastIndex(
      log,
      (e) => e.open === true && e.role === "tool" && e.itemId === undefined,
    );
    if (unbound >= 0 && itemId !== undefined) {
      return log.map((e, j) =>
        j === unbound ? { ...e, itemId, ...(turnId ? { turnId } : {}) } : e,
      );
    }
    const live = lastIndex(
      log,
      (e) => e.open === true && e.role === "tool" && (itemId === undefined || e.itemId === itemId),
    );
    if (live >= 0) return log;
    return [
      ...log,
      {
        id: stamp.id,
        ts: stamp.ts,
        role: "tool",
        text: initialText,
        itemId,
        ...(turnId ? { turnId } : {}),
        ...(richContent === undefined ? {} : { richContent: richContent.map((item) => ({ ...item })) }),
        open: true,
      },
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
    { id: stamp.id, ts: stamp.ts, role: "assistant", text: initialText, itemId, ...(turnId ? { turnId } : {}), ...(richContent === undefined ? {} : { richContent: richContent.map((item) => ({ ...item })) }), open: true },
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
        (e.role === "assistant" || e.role === "thinking" || e.role === "subagent" || e.role === "tool")
      ),
  );
}
