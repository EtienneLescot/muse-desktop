import {
  COMPACT_AUTO_ENTRIES,
  COMPACT_WARN_ENTRIES,
  needsAutoCompaction,
  needsCompaction,
  type ThreadSummary,
} from "../lib/compact";

interface Props {
  entryCount: number;
  summary: ThreadSummary | null;
  onCompact: () => void;
  onNewFromSummary: () => void;
}

/**
 * US-4 compaction strip, rendered between the stream and the composer.
 *
 * - Below the warn threshold: nothing (no noise on short threads).
 * - At/after the warn threshold (1500 entries): suggest manual compaction.
 * - At/after the auto threshold (2000 entries): the summary was built
 *   automatically — offer to reopen it in a fresh thread.
 * - Whenever a summary exists: show its shape + « New From Summary ».
 */
export function CompactBar({ entryCount, summary, onCompact, onNewFromSummary }: Props) {
  const warn = needsCompaction(entryCount);
  if (!warn && summary === null) return null;
  const auto = needsAutoCompaction(entryCount);

  return (
    <div className="compact-bar" role="status" aria-label="Thread compaction">
      {summary === null ? (
        <>
          <span className="compact-text">
            Long thread — {entryCount} / {COMPACT_AUTO_ENTRIES} entrées. Compactez pour
            continuer léger.
          </span>
          <button type="button" onClick={onCompact} title="Résumer ce thread en local (aucun appel modèle)">
            Compacter
          </button>
        </>
      ) : (
        <>
          <span className="compact-flag" title={`Résumé du ${new Date(summary.createdAt).toLocaleString()}`}>
            compacté
          </span>
          <span className="compact-text">
            {auto ? "Résumé automatique" : "Résumé prêt"} — {summary.entryCount} entrées :{" "}
            {summary.decisions.length} décision(s), {summary.context.length} contexte,{" "}
            {summary.todos.length} à-faire.
            {entryCount >= COMPACT_WARN_ENTRIES && (
              <> (log actuel : {entryCount} / {COMPACT_AUTO_ENTRIES})</>
            )}
          </span>
          <button type="button" onClick={onCompact} title="Reconstruire le résumé local">
            Recompacter
          </button>
          <button
            type="button"
            className="compact-primary"
            onClick={onNewFromSummary}
            title="Ouvrir un thread neuf pré-rempli de ce résumé"
          >
            New From Summary
          </button>
        </>
      )}
    </div>
  );
}
