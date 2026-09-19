/**
 * Boot auto-resume candidate selection (pure, unit-tested).
 *
 * After a desktop restart the native host registry is empty: `restore_sessions`
 * can only admit sessions for already-connected hosts, and sidecar hosts do
 * not survive the restart. The renderer therefore re-establishes the native
 * route itself by resuming the stored sessions the backend did not admit —
 * otherwise the Terminal/Files panels keep failing with
 * "conversation workspace is unavailable" until the user clicks Reconnect.
 *
 * This module only selects *which* stored sessions need that silent resume.
 * The active session comes first so the visible conversation (and its panels)
 * recovers before the background rows.
 */
import type { StoredSession } from "./persist.ts";

export interface BootResumeInput {
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

export function selectBootResumeCandidates(input: BootResumeInput): string[] {
  const restored = toSet(input.restoredIds);
  const tombstoned = toSet(input.tombstonedIds);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  if (typeof input.activeId === "string" && input.activeId.length > 0) {
    const active = input.stored.find((s) => s.session_id === input.activeId);
    if (active !== undefined && isResumeEligible(active, restored, tombstoned)) {
      push(active.session_id);
    }
  }
  for (const session of input.stored) {
    if (isResumeEligible(session, restored, tombstoned)) push(session.session_id);
  }
  return out;
}
