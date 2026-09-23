export interface SearchSession {
  session_id: string;
  title: string;
  workspace: string;
  archived?: boolean;
  createdAt?: number;
}

export interface SearchLogEntry {
  text: string;
  ts?: number;
}

export interface ConversationSearchHit {
  session: SearchSession;
  excerpt: string | null;
}

function excerptFor(text: string, query: string): string {
  const normalized = text.toLocaleLowerCase();
  const at = normalized.indexOf(query);
  if (at < 0) return text.slice(0, 96);
  const start = Math.max(0, at - 36);
  const end = Math.min(text.length, at + query.length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Most recently active first, as in Claude Code and Codex: last message, else creation. Stable. */
function byRecency(sessions: SearchSession[], logs: Record<string, SearchLogEntry[]>): SearchSession[] {
  const lastActivity = (session: SearchSession): number => {
    const log = logs[session.session_id];
    return log?.[log.length - 1]?.ts ?? session.createdAt ?? 0;
  };
  return [...sessions].sort((a, b) => lastActivity(b) - lastActivity(a));
}

/** Search conversation metadata and persisted message text without mutating state. */
export function searchConversations(
  sessions: SearchSession[],
  logs: Record<string, SearchLogEntry[]>,
  rawQuery: string,
): ConversationSearchHit[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return byRecency(sessions, logs).map((session) => ({ session, excerpt: null }));
  }
  return byRecency(sessions, logs).flatMap((session) => {
    const metadata = `${session.title} ${session.workspace}`.toLocaleLowerCase();
    const message = (logs[session.session_id] ?? []).find((entry) =>
      entry.text.toLocaleLowerCase().includes(query),
    );
    if (!metadata.includes(query) && message === undefined) return [];
    return [{ session, excerpt: message ? excerptFor(message.text, query) : null }];
  });
}
