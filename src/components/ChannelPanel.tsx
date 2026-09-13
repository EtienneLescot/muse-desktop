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
        <span className="collab-flag" title="Transport non spécifié : aucun relais temps réel implémenté">
          expérimental
        </span>
      </header>
      <p className="muted" role="status">
        {ch.enabled
          ? `Canal expérimental activé — état : ${ch.status}. La co-édition temps réel n'est pas connectée.`
          : "Canaux co-édition désactivés (stub expérimental, non connecté)."}
      </p>
    </section>
  );
}
