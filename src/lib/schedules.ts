/**
 * US-9 automations/scheduled + review queue: pure schedule logic.
 *
 * NOTE: no workflow/* MSP endpoint exists, so scheduling remains a bounded
 * client-side timer. A due schedule captures a durable review/run context;
 * ask mode waits for review while workspace and YOLO modes dispatch through
 * the normal turn path. A native background scheduler is still a follow-up.
 *
 * The scheduling rules remain dependency-light and are covered under
 * `node:test`; persistence is routed through the shared defensive facade.
 */

import { readStorageJson, writeStorageJson } from "./storage.ts";

/** One-shot trigger: fires once when `at` (epoch ms) is reached. */
export interface OneShotTrigger {
  kind: "once";
  at: number;
}

/** Recurring trigger: 5-field cron (`minute hour dom month dow`). */
export interface CronTrigger {
  kind: "cron";
  cron: string;
}

export type ScheduleTrigger = OneShotTrigger | CronTrigger;

/** Where an approved review item is sent as turn input. */
export type ThreadReuse =
  | { kind: "active" }
  | { kind: "new" }
  | { kind: "session"; sessionId: string };

export type ScheduleAuthorizationMode = "ask" | "workspace" | "yolo";

/** Behaviour when the app wakes after more than one cron occurrence. */
export type ScheduleMissedPolicy = "skip" | "latest";

export interface Schedule {
  id: string;
  name: string;
  instructions: string;
  trigger: ScheduleTrigger;
  threadReuse: ThreadReuse;
  /** Captured execution context; never inferred from the active view at tick. */
  workspace?: string;
  projectId?: string;
  model?: string;
  authorizationMode?: ScheduleAuthorizationMode;
  missedPolicy?: ScheduleMissedPolicy;
  /** IANA timezone used to interpret recurring cron wall-clock times. */
  timeZone?: string;
  enabled: boolean;
  createdAt: number;
  /**
   * Last occurrence cursor. For one-shot triggers any defined value means
   * "already fired"; for cron triggers it anchors the next occurrence.
   */
  lastFiredAt?: number;
}

export interface ScheduleInput {
  name: string;
  instructions: string;
  trigger: ScheduleTrigger;
  threadReuse: ThreadReuse;
  workspace?: string;
  projectId?: string;
  model?: string;
  authorizationMode?: ScheduleAuthorizationMode;
  missedPolicy?: ScheduleMissedPolicy;
  /** IANA timezone used to interpret recurring cron wall-clock times. */
  timeZone?: string;
}

export type ReviewStatus = "pending" | "approved" | "discarded";

export interface ReviewItem {
  id: string;
  scheduleId: string;
  scheduleName: string;
  instructions: string;
  threadReuse: ThreadReuse;
  workspace?: string;
  projectId?: string;
  model?: string;
  authorizationMode?: ScheduleAuthorizationMode;
  missedPolicy?: ScheduleMissedPolicy;
  timeZone?: string;
  /** Actual scheduled occurrence represented by this review item. */
  occurrenceAt?: number;
  /** Stable schedule + occurrence key used for idempotency. */
  occurrenceKey?: string;
  /** Enqueue time (epoch ms). */
  createdAt: number;
  status: ReviewStatus;
}

/** localStorage keys (all writes confined to `muse-desktop.*`, like persist.ts). */
export const SCHEDULES_KEY = "muse-desktop.schedules.v1";
export const REVIEW_QUEUE_KEY = "muse-desktop.review-queue.v1";

/** Bounds so a runaway creator stays small (cf. persist.ts caps). */
export const MAX_SCHEDULES = 100;
export const MAX_REVIEW_ITEMS = 200;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/* ---------------- validation ---------------- */

/** Human-readable error for a bad schedule form, null when valid. */
export function validateScheduleInput(input: ScheduleInput): string | null {
  if (input.name.trim().length === 0) return "name must not be empty";
  if (input.instructions.trim().length === 0) return "instructions must not be empty";
  const t = input.trigger;
  if (t.kind === "once") {
    if (!Number.isFinite(t.at)) return "one-shot time must be a valid date";
  } else if (t.kind === "cron") {
    if (parseCron(t.cron) === null) return `invalid cron expression: ${t.cron}`;
  } else {
    return "unknown trigger kind";
  }
  if (input.threadReuse.kind === "session" && input.threadReuse.sessionId.length === 0) {
    return "target thread must be selected";
  }
  if (input.missedPolicy !== undefined && input.missedPolicy !== "skip" && input.missedPolicy !== "latest") {
    return "unknown missed-run policy";
  }
  if (input.timeZone !== undefined && !isValidTimeZone(input.timeZone)) {
    return `invalid timezone: ${input.timeZone}`;
  }
  return null;
}

/** Return whether a string is a supported IANA timezone identifier. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

/* ---------------- cron ---------------- */

interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseCronField(raw: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  const parts = raw.split(",");
  if (parts.length === 0) return null;
  for (const part of parts) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo = min;
    let hi = max;
    if (range !== "" && range !== "*") {
      const dash = range.indexOf("-");
      if (dash >= 0) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = Number(range);
        hi = lo;
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      // Sunday may be written 7 (normalized to 0 for the dow field).
      if (max === 6) {
        if (lo === 7) lo = 0;
        if (hi === 7) hi = 0;
      }
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression (`minute hour dom month dow`). Supports
 * `*`, `*\/n`, ranges, `a-b/n`, lists and `7` for Sunday. Null when invalid.
 */
export function parseCron(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed: Array<number[] | null> = fields.map((f, i) =>
    parseCronField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]),
  );
  if (parsed.some((p) => p === null)) return null;
  const [minute, hour, dom, month, dow] = parsed as number[][];
  return { minute, hour, dom, month, dow };
}

function cronMatches(fields: CronFields, d: Date): boolean {
  const min = fields.minute.includes(d.getMinutes());
  const hr = fields.hour.includes(d.getHours());
  const mon = fields.month.includes(d.getMonth() + 1);
  const domAll = fields.dom.length === 31;
  const dowAll = fields.dow.length === 7;
  const dom = fields.dom.includes(d.getDate());
  // Standard cron semantics: when both dom and dow are restricted, either
  // may match; otherwise the restricted one (or both when unrestricted).
  const day =
    domAll && dowAll ? true : domAll ? fields.dow.includes(d.getDay()) : dowAll ? dom : dom || fields.dow.includes(d.getDay());
  return min && hr && mon && day;
}

/**
 * Next cron occurrence strictly after `fromTs` (epoch ms, local timezone),
 * or null when invalid / none within ~2 years.
 */
export function cronNextRun(cron: string, fromTs: number): number | null {
  const fields = parseCron(cron);
  if (fields === null || !Number.isFinite(fromTs)) return null;
  // Start at the next whole minute strictly after fromTs.
  let t = Math.floor(fromTs / 60000) * 60000 + 60000;
  const limit = t + 2 * 366 * 24 * 60 * 60000;
  while (t <= limit) {
    if (cronMatches(fields, new Date(t))) return t;
    t += 60000;
  }
  return null;
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

function formatterForTimeZone(timeZone: string): Intl.DateTimeFormat | null {
  if (!isValidTimeZone(timeZone)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function formatZonedParts(formatter: Intl.DateTimeFormat, ts: number): ZonedParts | null {
  const values: Partial<ZonedParts> = {};
  for (const part of formatter.formatToParts(new Date(ts))) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute") {
      values[part.type] = Number(part.value);
    }
  }
  if (![values.year, values.month, values.day, values.hour, values.minute].every((value) => Number.isFinite(value))) {
    return null;
  }
  return values as ZonedParts;
}

function wallClockMatches(fields: CronFields, wallTs: number): boolean {
  const d = new Date(wallTs);
  const min = fields.minute.includes(d.getUTCMinutes());
  const hr = fields.hour.includes(d.getUTCHours());
  const mon = fields.month.includes(d.getUTCMonth() + 1);
  const domAll = fields.dom.length === 31;
  const dowAll = fields.dow.length === 7;
  const dom = fields.dom.includes(d.getUTCDate());
  const day = domAll && dowAll
    ? true
    : domAll
      ? fields.dow.includes(d.getUTCDay())
      : dowAll
        ? dom
        : dom || fields.dow.includes(d.getUTCDay());
  return min && hr && mon && day;
}

/** Resolve a local wall-clock minute to every matching UTC instant. */
function wallClockCandidates(formatter: Intl.DateTimeFormat, wallTs: number): number[] {
  const wall = new Date(wallTs);
  let guess = wallTs;
  for (let i = 0; i < 4; i += 1) {
    const parts = formatZonedParts(formatter, guess);
    if (!parts) return [];
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess -= representedAsUtc - wallTs;
  }
  const candidates = new Set<number>();
  for (const offsetProbe of [guess - 3_600_000, guess, guess + 3_600_000]) {
    const parts = formatZonedParts(formatter, offsetProbe);
    if (!parts) continue;
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const candidate = offsetProbe - (representedAsUtc - wallTs);
    const exact = formatZonedParts(formatter, candidate);
    if (exact && exact.year === wall.getUTCFullYear() && exact.month === wall.getUTCMonth() + 1 &&
      exact.day === wall.getUTCDate() && exact.hour === wall.getUTCHours() && exact.minute === wall.getUTCMinutes()) {
      candidates.add(candidate);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

/**
 * Next cron occurrence strictly after `fromTs` using local wall-clock time
 * in an IANA timezone. DST gaps are skipped and fall-back duplicates resolve
 * to the first instant after the anchor.
 */
export function cronNextRunInTimeZone(cron: string, fromTs: number, timeZone: string): number | null {
  const fields = parseCron(cron);
  const formatter = formatterForTimeZone(timeZone);
  if (fields === null || formatter === null || !Number.isFinite(fromTs)) return null;
  const fromParts = formatZonedParts(formatter, fromTs);
  if (fromParts === null) return null;
  let wallTs = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day, fromParts.hour, fromParts.minute);
  wallTs = Math.floor(wallTs / 60000) * 60000 + 60000;
  const limit = wallTs + 2 * 366 * 24 * 60 * 60000;
  while (wallTs <= limit) {
    if (wallClockMatches(fields, wallTs)) {
      const next = wallClockCandidates(formatter, wallTs).find((candidate) => candidate > fromTs);
      if (next !== undefined) return next;
    }
    wallTs += 60000;
  }
  return null;
}

/* ---------------- schedules: CRUD ---------------- */

/** Build a new (enabled) schedule; caller must validate first. */
export function buildSchedule(input: ScheduleInput, nowTs: number): Schedule {
  return {
    id: makeId("sched"),
    name: input.name.trim(),
    instructions: input.instructions.trim(),
    trigger: input.trigger,
    threadReuse: input.threadReuse,
    ...(input.workspace?.trim() ? { workspace: input.workspace.trim() } : {}),
    ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.authorizationMode ? { authorizationMode: input.authorizationMode } : {}),
    ...(input.missedPolicy ? { missedPolicy: input.missedPolicy } : {}),
    ...(input.timeZone?.trim() ? { timeZone: input.timeZone.trim() } : {}),
    enabled: true,
    createdAt: nowTs,
  };
}

/** Append a validated schedule (no-op when invalid or over the cap). */
export function createSchedule(
  schedules: Schedule[],
  input: ScheduleInput,
  nowTs: number,
): Schedule[] {
  if (validateScheduleInput(input) !== null) return schedules;
  if (schedules.length >= MAX_SCHEDULES) return schedules;
  return [...schedules, buildSchedule(input, nowTs)];
}

/** Enable/disable one schedule; unknown ids leave the list untouched. */
export function setScheduleEnabled(
  schedules: Schedule[],
  id: string,
  enabled: boolean,
): Schedule[] {
  return schedules.map((s) => (s.id === id ? { ...s, enabled } : s));
}

/** Delete one schedule; unknown ids leave the list untouched. */
export function deleteSchedule(schedules: Schedule[], id: string): Schedule[] {
  return schedules.filter((s) => s.id !== id);
}

/* ---------------- due → review queue / automatic dispatch ---------------- */

/** True when an enabled schedule owes a review entry at `nowTs`. */
export function isScheduleDue(s: Schedule, nowTs: number): boolean {
  if (!s.enabled) return false;
  const t = s.trigger;
  if (t.kind === "once") {
    return t.at <= nowTs && s.lastFiredAt === undefined;
  }
  const anchor = s.lastFiredAt ?? s.createdAt;
  const next = s.timeZone ? cronNextRunInTimeZone(t.cron, anchor, s.timeZone) : cronNextRun(t.cron, anchor);
  return next !== null && next <= nowTs;
}

/**
 * Return the next occurrence represented by a schedule's durable cursor.
 * A past value is intentional: it means the schedule is currently due and
 * lets the UI explain a missed occurrence instead of hiding it behind a
 * future countdown. Disabled or completed one-shot schedules return null.
 */
export function nextScheduleOccurrence(s: Schedule): number | null {
  if (!s.enabled) return null;
  if (s.trigger.kind === "once") {
    return s.lastFiredAt === undefined && Number.isFinite(s.trigger.at)
      ? s.trigger.at
      : null;
  }
  const anchor = s.lastFiredAt ?? s.createdAt;
  return s.timeZone
    ? cronNextRunInTimeZone(s.trigger.cron, anchor, s.timeZone)
    : cronNextRun(s.trigger.cron, anchor);
}

/** Enabled schedules that owe a review entry at `nowTs`. */
export function dueSchedules(schedules: Schedule[], nowTs: number): Schedule[] {
  return schedules.filter((s) => isScheduleDue(s, nowTs));
}

export function scheduleOccurrenceKey(scheduleId: string, occurrenceAt: number): string {
  return `${scheduleId}:${occurrenceAt}`;
}

function buildReviewItem(s: Schedule, nowTs: number, occurrenceAt: number): ReviewItem {
  return {
    id: makeId("rev"),
    scheduleId: s.id,
    scheduleName: s.name,
    instructions: s.instructions,
    threadReuse: s.threadReuse,
    ...(s.workspace ? { workspace: s.workspace } : {}),
    ...(s.projectId ? { projectId: s.projectId } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.authorizationMode ? { authorizationMode: s.authorizationMode } : {}),
    ...(s.missedPolicy ? { missedPolicy: s.missedPolicy } : {}),
    ...(s.timeZone ? { timeZone: s.timeZone } : {}),
    occurrenceAt,
    occurrenceKey: scheduleOccurrenceKey(s.id, occurrenceAt),
    createdAt: nowTs,
    status: "pending",
  };
}

const MAX_CATCH_UP_OCCURRENCES = 512;

/** List the cron/one-shot occurrences that are due at `nowTs`, bounded. */
export function dueOccurrenceTimes(s: Schedule, nowTs: number): number[] {
  if (!s.enabled || !Number.isFinite(nowTs)) return [];
  if (s.trigger.kind === "once") {
    return s.trigger.at <= nowTs && s.lastFiredAt === undefined ? [s.trigger.at] : [];
  }
  const out: number[] = [];
  let anchor = s.lastFiredAt ?? s.createdAt;
  while (out.length < MAX_CATCH_UP_OCCURRENCES) {
    const next = s.timeZone
      ? cronNextRunInTimeZone(s.trigger.cron, anchor, s.timeZone)
      : cronNextRun(s.trigger.cron, anchor);
    if (next === null || next > nowTs) break;
    out.push(next);
    anchor = next;
  }
  return out;
}

/**
 * Enqueue one review/run context per due schedule and advance those schedules
 * (one-shot: marked fired; cron: anchored at `nowTs` so the same occurrence
 * never enqueues twice). Pure: the caller decides whether the captured item
 * waits for approval or is dispatched automatically.
 */
export function enqueueDue(
  schedules: Schedule[],
  queue: ReviewItem[],
  nowTs: number,
): { schedules: Schedule[]; queue: ReviewItem[]; added: ReviewItem[] } {
  const due = schedules
    .map((schedule) => ({ schedule, occurrences: dueOccurrenceTimes(schedule, nowTs) }))
    .filter(({ occurrences }) => occurrences.length > 0);
  const dueIds = new Set(due.map(({ schedule }) => schedule.id));
  if (dueIds.size === 0) return { schedules, queue, added: [] };
  const added: ReviewItem[] = [];
  const existingKeys = new Set(queue.map((item) => item.occurrenceKey ??
    (item.occurrenceAt === undefined ? null : scheduleOccurrenceKey(item.scheduleId, item.occurrenceAt)))
    .filter((key): key is string => key !== null));
  const next = schedules.map((s) => {
    if (!dueIds.has(s.id)) return s;
    const occurrences = due.find(({ schedule }) => schedule.id === s.id)?.occurrences ?? [];
    const latest = occurrences[occurrences.length - 1];
    // `skip` advances over all missed cron slots when more than one is due;
    // it still runs a single occurrence when exactly one slot is due.
    const shouldRun = s.missedPolicy !== "skip" || occurrences.length === 1;
    if (shouldRun) {
      const key = scheduleOccurrenceKey(s.id, latest);
      if (!existingKeys.has(key)) {
        const item = buildReviewItem(s, nowTs, latest);
        added.push(item);
        existingKeys.add(key);
      }
    }
    return { ...s, lastFiredAt: latest };
  });
  return {
    schedules: next,
    queue: [...queue, ...added].slice(-MAX_REVIEW_ITEMS),
    added,
  };
}

/**
 * "Run now" button: enqueue a review entry for one schedule immediately,
 * even when disabled, and advance it (so a due one-shot does not enqueue
 * again on the next timer tick). Null for unknown ids.
 */
export function enqueueRunNow(
  schedules: Schedule[],
  queue: ReviewItem[],
  id: string,
  nowTs: number,
): { schedules: Schedule[]; queue: ReviewItem[]; added: ReviewItem } | null {
  const s = schedules.find((x) => x.id === id);
  if (!s) return null;
  const added = buildReviewItem(s, nowTs, nowTs);
  return {
    schedules: schedules.map((x) => (x.id === id ? { ...x, lastFiredAt: nowTs } : x)),
    queue: [...queue, added].slice(-MAX_REVIEW_ITEMS),
    added,
  };
}

/* ---------------- review queue ---------------- */

/** Pending entries (oldest first), the only ones Approve/Discard act on. */
export function pendingReviews(queue: ReviewItem[]): ReviewItem[] {
  return queue.filter((r) => r.status === "pending");
}

/** Settle one pending entry as approved; null when missing/already settled. */
export function approveReview(
  queue: ReviewItem[],
  id: string,
): { queue: ReviewItem[]; item: ReviewItem } | null {
  const cur = queue.find((r) => r.id === id);
  if (!cur || cur.status !== "pending") return null;
  const item: ReviewItem = { ...cur, status: "approved" };
  return { queue: queue.map((r) => (r.id === id ? item : r)), item };
}

/** Settle one pending entry as discarded; null when missing/already settled. */
export function discardReview(
  queue: ReviewItem[],
  id: string,
): { queue: ReviewItem[]; item: ReviewItem } | null {
  const cur = queue.find((r) => r.id === id);
  if (!cur || cur.status !== "pending") return null;
  const item: ReviewItem = { ...cur, status: "discarded" };
  return { queue: queue.map((r) => (r.id === id ? item : r)), item };
}

/**
 * Resolve where an approved review item goes: a live session id, `"new"`
 * for a fresh thread, or null when the recorded target thread is gone
 * (the hook then reports an error instead of sending anywhere).
 */
export function resolveReviewTarget(
  reuse: ThreadReuse,
  activeId: string | null,
  knownSessionIds: string[],
): string | "new" | null {
  if (reuse.kind === "new") return "new";
  if (reuse.kind === "active") {
    if (activeId !== null && knownSessionIds.includes(activeId)) return activeId;
    return knownSessionIds.length > 0 ? knownSessionIds[0] : "new";
  }
  return knownSessionIds.includes(reuse.sessionId) ? reuse.sessionId : null;
}

/* ---------------- persistence (localStorage, best-effort) ---------------- */

function readRaw(key: string): unknown {
  return readStorageJson<unknown>(key, []);
}

function writeRaw(key: string, value: unknown): void {
  writeStorageJson(key, value);
}

function isValidTrigger(t: unknown): t is ScheduleTrigger {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  if (o.kind === "once") return typeof o.at === "number" && Number.isFinite(o.at);
  if (o.kind === "cron") return typeof o.cron === "string" && parseCron(o.cron) !== null;
  return false;
}

function isValidReuse(r: unknown): r is ThreadReuse {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  if (o.kind === "active" || o.kind === "new") return true;
  return o.kind === "session" && typeof o.sessionId === "string" && o.sessionId.length > 0;
}

function isValidSchedule(s: unknown): s is Schedule {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.instructions === "string" &&
    isValidTrigger(o.trigger) &&
    isValidReuse(o.threadReuse) &&
    typeof o.enabled === "boolean" &&
    typeof o.createdAt === "number" &&
    (o.lastFiredAt === undefined || typeof o.lastFiredAt === "number") &&
    (o.workspace === undefined || typeof o.workspace === "string") &&
    (o.projectId === undefined || typeof o.projectId === "string") &&
    (o.model === undefined || typeof o.model === "string") &&
    (o.authorizationMode === undefined || o.authorizationMode === "ask" || o.authorizationMode === "workspace" || o.authorizationMode === "yolo") &&
    (o.missedPolicy === undefined || o.missedPolicy === "skip" || o.missedPolicy === "latest") &&
    (o.timeZone === undefined || (typeof o.timeZone === "string" && isValidTimeZone(o.timeZone)))
  );
}

function isValidReview(r: unknown): r is ReviewItem {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.scheduleId === "string" &&
    typeof o.scheduleName === "string" &&
    typeof o.instructions === "string" &&
    isValidReuse(o.threadReuse) &&
    typeof o.createdAt === "number" &&
    (o.status === "pending" || o.status === "approved" || o.status === "discarded") &&
    (o.workspace === undefined || typeof o.workspace === "string") &&
    (o.projectId === undefined || typeof o.projectId === "string") &&
    (o.model === undefined || typeof o.model === "string") &&
    (o.authorizationMode === undefined || o.authorizationMode === "ask" || o.authorizationMode === "workspace" || o.authorizationMode === "yolo") &&
    (o.missedPolicy === undefined || o.missedPolicy === "skip" || o.missedPolicy === "latest") &&
    (o.timeZone === undefined || (typeof o.timeZone === "string" && isValidTimeZone(o.timeZone))) &&
    (o.occurrenceAt === undefined || typeof o.occurrenceAt === "number") &&
    (o.occurrenceKey === undefined || typeof o.occurrenceKey === "string")
  );
}

export function loadSchedules(): Schedule[] {
  const raw = readRaw(SCHEDULES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidSchedule).slice(-MAX_SCHEDULES);
}

export function saveSchedules(schedules: Schedule[]): void {
  writeRaw(SCHEDULES_KEY, schedules.slice(-MAX_SCHEDULES));
}

export function loadReviewQueue(): ReviewItem[] {
  const raw = readRaw(REVIEW_QUEUE_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidReview).slice(-MAX_REVIEW_ITEMS);
}

export function saveReviewQueue(queue: ReviewItem[]): void {
  writeRaw(REVIEW_QUEUE_KEY, queue.slice(-MAX_REVIEW_ITEMS));
}
