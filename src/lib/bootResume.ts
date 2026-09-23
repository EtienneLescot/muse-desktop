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

/** The open conversation, when it still needs a silent resume; otherwise null. */
export function selectResumeOnOpen(input: ResumeInput): string | null {
  if (typeof input.activeId !== "string" || input.activeId.length === 0) return null;
  const active = input.stored.find((s) => s.session_id === input.activeId);
  if (active === undefined) return null;
  return isResumeEligible(active, toSet(input.restoredIds), toSet(input.tombstonedIds))
    ? active.session_id
    : null;
}
