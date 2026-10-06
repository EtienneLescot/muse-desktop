/**
 * Resume-on-open candidate selection (pure, unit-tested).
 *
 * After a desktop restart the native host registry is empty: `restore_sessions`
 * can only admit sessions for already-connected hosts, and sidecar hosts do
 * not survive the restart. The renderer therefore re-establishes the native
 * route itself by resuming a stored session the backend did not admit —
 * otherwise the Terminal/Files panels keep failing with
 * "conversation workspace is unavailable" until the user clicks Reconnect.
 *
 * Only the open conversation is resumed. A host keeps at most 32 sessions
 * loaded (measured on Muse 1.3: the 33rd `session/start` is rejected with
 * `-32030 host loaded-session capacity is exhausted`), and there is no client
 * unload, so resuming every stored row at boot left no room to start a new
 * conversation once a user had about thirty of them.
 */
import type { StoredSession } from "./persist.ts";

export interface ResumeInput {
  stored: StoredSession[];
  restoredIds: ReadonlySet<string> | readonly string[];
  tombstonedIds: ReadonlySet<string> | readonly string[] | null | undefined;
  activeId: string | null | undefined;
}

function toSet(ids: ReadonlySet<string> | readonly string[] | null | undefined): ReadonlySet<string> {
  if (ids instanceof Set) return ids;
  return new Set(ids ?? []);
}

/** Sessions no resume attempt may touch: already admitted, user-deleted, archived, ephemeral, or workspace-less. */
function isResumeEligible(
  session: StoredSession,
  restored: ReadonlySet<string>,
  tombstoned: ReadonlySet<string>,
): boolean {
  if (session.session_id.length === 0) return false;
  if (session.archived === true) return false;
  if (restored.has(session.session_id)) return false;
  if (tombstoned.has(session.session_id)) return false;
  if (session.session_durability?.toLowerCase() === "ephemeral") return false;
  if (session.workspace.length === 0) return false;
  return true;
}

/**
 * The restored conversations that count as connected. After a window reload
 * the live hosts list every conversation they can read, loaded or not, and
 * one they have not loaded refuses session commands (-32024 on
 * setApprovalMode, M0-06). Only a loaded one is connected; resume-on-open
 * loads the others. No status (older host) keeps the old behaviour.
 */
export function connectedRestoredIds(
  restored: readonly { session_id: string; loaded?: boolean }[],
): string[] {
  return restored.filter((meta) => meta.loaded !== false).map((meta) => meta.session_id);
}

/** The open conversation, when it still needs a silent resume; otherwise null. */
export function selectResumeOnOpen(input: ResumeInput): string | null {
  if (typeof input.activeId !== "string" || input.activeId.length === 0) return null;
  const active = input.stored.find((s) => s.session_id === input.activeId);
  if (active === undefined) return null;
  return isResumeEligible(active, toSet(input.restoredIds), toSet(input.tombstonedIds))
    ? active.session_id
    : null;
}
