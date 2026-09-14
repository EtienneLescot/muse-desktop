import { describeChannel } from "../lib/sharing";

interface Props {
  experimental: boolean;
}

/**
 * US-28 channel stub: co-editing transport is unspecified ([TROU] SPEC
 * §3.10), so this panel is explicit and honest — experimental flag off by
 * default, "not connected" when on, never a fake live session.
 */
export function ChannelPanel({ experimental }: Props) {
  const ch = describeChannel(experimental);
  return (
    <section className="collab-panel" aria-label="Co-editing channels (experimental)">
      <header className="collab-head">
        <strong>Channels</strong>
        <span className="collab-flag" title="Transport unspecified: no real-time relay implemented">
          experimental
        </span>
      </header>
      <p className="muted" role="status">
        {ch.enabled
          ? `Experimental channel enabled — status: ${ch.status}. Real-time co-editing is not connected.`
          : "Co-editing channels disabled (experimental stub, not connected)."}
      </p>
    </section>
  );
}
