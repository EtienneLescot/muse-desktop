export interface SearchSession {
  session_id: string;
  title: string;
  workspace: string;
  archived?: boolean;
}

export interface SearchLogEntry {
  text: string;
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

/** Search conversation metadata and persisted message text without mutating state. */
export function searchConversations(
  sessions: SearchSession[],
  logs: Record<string, SearchLogEntry[]>,
  rawQuery: string,
): ConversationSearchHit[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return sessions.map((session) => ({ session, excerpt: null }));
  }
  return sessions.flatMap((session) => {
    const metadata = `${session.title} ${session.workspace}`.toLocaleLowerCase();
    const message = (logs[session.session_id] ?? []).find((entry) =>
      entry.text.toLocaleLowerCase().includes(query),
    );
    if (!metadata.includes(query) && message === undefined) return [];
    return [{ session, excerpt: message ? excerptFor(message.text, query) : null }];
  });
}
