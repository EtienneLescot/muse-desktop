import type { ReviewItem } from "../lib/schedules";

interface Props {
  items: ReviewItem[];
  /** Resolve a recorded session id to a display title (fallback: short id). */
  sessionTitle: (sessionId: string) => string;
  onApprove: (id: string) => void;
  onDiscard: (id: string) => void;
}

function targetLabel(item: ReviewItem, sessionTitle: (id: string) => string): string {
  const r = item.threadReuse;
  if (r.kind === "active") return "active thread";
  if (r.kind === "new") return "new thread";
  return sessionTitle(r.sessionId);
}

/**
 * US-9 review queue: due schedules land here and wait — nothing auto-sends.
 * Approve sends the instructions as normal turn input into the recorded
 * target thread; Discard drops the entry.
 */
export function ReviewQueuePanel({ items, sessionTitle, onApprove, onDiscard }: Props) {
  if (items.length === 0) return null;
  return (
    <section className="review-queue" aria-label="Automation review queue">
      <header className="review-head">
        Review queue
        <span className="schedules-count" title={`${items.length} pending`}>
          {items.length}
        </span>
      </header>
      {items.map((item) => (
        <div key={item.id} className="review-item">
          <div className="review-text">
            <strong>{item.scheduleName}</strong>{" "}
            <span className="muted">
              → {targetLabel(item, sessionTitle)} ·{" "}
              {new Date(item.createdAt).toLocaleString()}
            </span>
            <pre>{item.instructions}</pre>
          </div>
          <div className="review-actions">
            <button
              type="button"
              className="review-approve"
              onClick={() => onApprove(item.id)}
              title="Send as turn input into the target thread"
            >
              Approve &amp; send
            </button>
            <button
              type="button"
              onClick={() => onDiscard(item.id)}
              title="Drop this entry"
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
