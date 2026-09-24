import {
  contextPercent,
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

function tokens(n: number | null): string {
  if (n === null) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

const PRESSURE_COPY: Record<string, string> = {
  normal: "Plenty of room left in the window.",
  warning: "The window is filling up — compacting keeps the thread responsive.",
  blocked: "The window is full. Compact before sending more.",
};

/**
 * Context usage next to the model picker, as in Claude Code. The percentage
 * alone read as decoration and doubled as the compact trigger, so the reading
 * and the action are split: a filled bar states occupancy, and the numbers plus
 * an explicit Compact button live one click away in the popover.
 *
 * The host reports one occupancy figure (`session/contextUsage`), not a
 * per-category breakdown, so the popover shows used/free rather than inventing
 * a split it cannot measure.
 */
export function ContextMeter({ usage, serverCompaction, onCompact }: Props) {
  if (usage === null) return null;
  const percent = contextPercent(usage);
  const busy = serverCompaction.status === "pending" || serverCompaction.status === "accepted";
  const status = serverCompactionStatusLabel(serverCompaction);
  const high = suggestsServerCompaction(usage);
  const free =
    usage.windowTokens !== null && usage.usedTokens !== null
      ? Math.max(0, usage.windowTokens - usage.usedTokens)
      : null;
  return (
    <details className="context-meter" data-pressure={high ? "high" : "normal"} data-popover>
      <summary
        className="context-meter-trigger"
        aria-label={`Context ${percent ?? "?"}% used. Open context details`}
        title={`Context: ${tokens(usage.usedTokens)} of ${tokens(usage.windowTokens)} tokens`}
      >
        <span className="context-meter-bar" aria-hidden="true">
          <span style={{ width: `${percent ?? 0}%` }} />
        </span>
        {busy ? "Compacting…" : `${percent ?? "?"}%`}
      </summary>
      <div className="context-meter-popover">
        <p className="context-meter-title">
          Context window
          <strong>
            {tokens(usage.usedTokens)} / {tokens(usage.windowTokens)}
            {percent !== null ? ` (${percent}%)` : ""}
          </strong>
        </p>
        <p className="context-meter-note">
          {PRESSURE_COPY[usage.pressure] ??
            "The engine did not report how much pressure the window is under."}
          {free !== null ? ` About ${tokens(free)} tokens free.` : ""}
        </p>
        {usage.tokenUsage && (
          <p className="context-meter-note">
            Last turn: {tokens(usage.tokenUsage.promptTokens)} in ·{" "}
            {tokens(usage.tokenUsage.outputTokens)} out.
          </p>
        )}
        <button
          type="button"
          className="context-meter-compact"
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onCompact();
          }}
          disabled={busy}
        >
          {busy ? "Compacting…" : "Compact now"}
        </button>
        <p className="context-meter-note">
          {status ||
            "Compacting asks the engine to summarise the thread so far and free room, keeping this conversation."}
        </p>
      </div>
    </details>
  );
}
