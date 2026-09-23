import {
  contextPercent,
  formatUsage,
  serverCompactionStatusLabel,
  suggestsServerCompaction,
  type ContextUsage,
  type ServerCompactionState,
} from "../lib/compact";

interface Props {
  /** Host occupancy; null until the first `context_usage` lands. */
  usage: ContextUsage | null;
  serverCompaction: ServerCompactionState;
  /** `session/compact`, only on the user's click. */
  onCompact: () => void;
}

/**
 * Context usage next to the composer, as in Claude Code: a percentage, the
 * exact figures on hover, and compaction one click away. It is emphasised
 * from the host's `warning` pressure up.
 */
export function ContextMeter({ usage, serverCompaction, onCompact }: Props) {
  if (usage === null) return null;
  const percent = contextPercent(usage);
  const busy = serverCompaction.status === "pending" || serverCompaction.status === "accepted";
  const status = serverCompactionStatusLabel(serverCompaction);
  return (
    <button
      type="button"
      className="context-meter"
      data-pressure={suggestsServerCompaction(usage) ? "high" : "normal"}
      onClick={onCompact}
      disabled={busy}
      title={`Context: ${formatUsage(usage)}${status ? ` · ${status}` : ""}. Click to compact.`}
      aria-label={`Context ${percent ?? "?"}% used. Compact the context`}
    >
      {busy ? "Compacting…" : `${percent ?? "?"}% context`}
    </button>
  );
}
