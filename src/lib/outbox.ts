/**
 * M0-03 lossless send: client-side outbox for outgoing turns.
 *
 * Every logical send carries a stable `clientMessageId` plus a persisted
 * server `commandId` idempotency key that survive retries, conversation
 * switches and app restarts. An entry
 * walks sending → accepted (acknowledged: it leaves the outbox) or failed
 * (kept durably, retryable). A failure is `ambiguous` when no definitive
 * server answer arrived (ack timeout, restart mid-flight): retrying such
 * an entry must verify the server conversation by identifier before retransmitting, so
 * one logical send can never become two accepted turns.
 *
 * Pure and dependency-free, unit-tested in test/outbox.test.ts.
 */

export type OutboxState = "sending" | "accepted" | "failed";

export interface OutboxEntry {
  /** Idempotency key: one logical send, stable across retries. */
  clientMessageId: string;
  /**
   * Stable UUIDv7 command id sent to the supervisor.  It is derived once
   * from the client id and persisted so an ambiguous retry is idempotent at
   * the protocol boundary.  Entries written by pre-M0-03 builds may omit it
   * and cannot be verified automatically.
   */
  serverCommandId?: string;
  /** Target session — a retry never routes by the selected conversation. */
  sessionId: string;
  /** Original composer text (what the user typed). */
  text: string;
  /**
   * Expanded text actually sent (skill/fanout/project instructions).
   * Retries resend this byte-identical expansion instead of re-expanding.
   */
  outgoingText: string;
  state: OutboxState;
  /** Last failure reason; null while sending. */
  error: string | null;
  /**
   * True when the last attempt ended without a definitive server answer
   * (ack timeout or restart mid-flight): verify before retransmitting.
   */
  ambiguous: boolean;
  createdAt: number;
  updatedAt: number;
  /** Send attempts so far (the first send included). */
  attempts: number;
}

/** Explicit result of one send attempt (M0-03: sends never vanish). */
export interface SendResult {
  /** True when the supervisor acknowledged the send (admission ack). */
  ok: boolean;
  /** Echoed idempotency key; null when nothing was sent (e.g. empty input). */
  clientMessageId: string | null;
  /** Failure reason; null on success. */
  error: string | null;
}

export function sendAccepted(clientMessageId: string): SendResult {
  return { ok: true, clientMessageId, error: null };
}

export function sendFailed(
  clientMessageId: string | null,
  error: string,
): SendResult {
  return { ok: false, clientMessageId, error };
}

export function createOutboxEntry(init: {
  clientMessageId: string;
  serverCommandId?: string;
  sessionId: string;
  text: string;
  outgoingText: string;
  now: number;
}): OutboxEntry {
  return {
    clientMessageId: init.clientMessageId,
    ...(init.serverCommandId !== undefined
      ? { serverCommandId: init.serverCommandId }
      : {}),
    sessionId: init.sessionId,
    text: init.text,
    outgoingText: init.outgoingText,
    state: "sending",
    error: null,
    ambiguous: false,
    createdAt: init.now,
    updatedAt: init.now,
    attempts: 1,
  };
}

/**
 * Derive a protocol-valid, stable UUIDv7 command id from a logical client
 * message id.  The timestamp is fixed at first-send time; retries reuse the
 * persisted result, so this function is called at most once per send.
 */
export function commandIdFromClientMessageId(
  clientMessageId: string,
  now = Date.now(),
): string | undefined {
  const source = clientMessageId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(source)) return undefined;
  const timestamp = Math.max(0, Math.floor(now))
    .toString(16)
    .padStart(12, "0")
    .slice(-12);
  const chars = (timestamp + source.slice(12)).split("");
  chars[12] = "7"; // UUID version 7
  chars[16] = "8"; // RFC 9562 variant 10xx
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A retry attempt starts: attempts grow, ambiguity from the past is kept. */
export function markSending(entry: OutboxEntry, now: number): OutboxEntry {
  return { ...entry, state: "sending", error: null, updatedAt: now, attempts: entry.attempts + 1 };
}

export function markAccepted(entry: OutboxEntry, now: number): OutboxEntry {
  return { ...entry, state: "accepted", error: null, ambiguous: false, updatedAt: now };
}

export function markFailed(
  entry: OutboxEntry,
  error: string,
  now: number,
  ambiguous: boolean,
): OutboxEntry {
  return { ...entry, state: "failed", error, ambiguous, updatedAt: now };
}

/** Insert or replace by clientMessageId (newest last). */
export function upsertOutbox(
  list: OutboxEntry[],
  entry: OutboxEntry,
): OutboxEntry[] {
  const i = list.findIndex((e) => e.clientMessageId === entry.clientMessageId);
  if (i < 0) return [...list, entry];
  const next = [...list];
  next[i] = entry;
  return next;
}

export function removeOutbox(
  list: OutboxEntry[],
  clientMessageId: string,
): OutboxEntry[] {
  return list.filter((e) => e.clientMessageId !== clientMessageId);
}

export function findOutbox(
  list: OutboxEntry[],
  clientMessageId: string,
): OutboxEntry | null {
  return list.find((e) => e.clientMessageId === clientMessageId) ?? null;
}

/** Retryable entries only: accepted ones never linger in the outbox. */
export function failedOutbox(list: OutboxEntry[]): OutboxEntry[] {
  return list.filter((e) => e.state === "failed");
}

/** Cap per-session outbox length (oldest pruned, cf. log/tombstone caps). */
export const MAX_OUTBOX_ENTRIES = 50;

export function capOutbox(list: OutboxEntry[]): OutboxEntry[] {
  return list.slice(-MAX_OUTBOX_ENTRIES);
}

/**
 * Boot recovery: an entry still `sending` never received its ack because
 * the app died or reloaded mid-flight. The outcome is unknown — the entry
 * becomes failed/ambiguous so a retry verifies the server first.
 */
export function recoverInterrupted(
  list: OutboxEntry[],
  now: number,
): { entries: OutboxEntry[]; recovered: number } {
  let recovered = 0;
  const entries = list.map((e) => {
    if (e.state !== "sending") return e;
    recovered += 1;
    return markFailed(
      e,
      "the app restarted before the send was acknowledged",
      now,
      true,
    );
  });
  return { entries, recovered };
}
