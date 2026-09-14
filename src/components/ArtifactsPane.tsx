import { useMemo, useState } from "react";
import {
  buildThreadRecap,
  type Artifact,
  type ArtifactLogEntry,
} from "../lib/artifacts";

interface Props {
  sessionId: string;
  log: ArtifactLogEntry[];
  artifacts: Artifact[];
  /** 1-click restore: the hook copies the version text via US-4 prefill. */
  onRestore: (sessionId: string, artifactId: string, v: number) => void;
  /** Anchored per-version comment (persisted by the hook). */
  onComment: (
    sessionId: string,
    artifactId: string,
    v: number,
    comment: string,
  ) => void;
}

type Tab = "summary" | "artifacts";

/**
 * US-12 + US-21 right-side pane, per thread.
 *
 * - Summary tab: auto recap from the log (counts, files mentioned,
 *   decisions) — no model call.
 * - Artifacts tab: code/doc blocks extracted from assistant messages as
 *   versions v1..vN, each restorable into the composer in 1 click and
 *   carrying its own persisted comment.
 */
export function ArtifactsPane({
  sessionId,
  log,
  artifacts,
  onRestore,
  onComment,
}: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const recap = useMemo(
    () => buildThreadRecap(sessionId, log),
    [sessionId, log],
  );

  return (
    <aside
      className="artifacts-pane"
      aria-label="Résumé et contenus de la conversation"
    >
      <div
        className="artifacts-tabs"
        role="tablist"
        aria-label="Contenus de la conversation"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "summary"}
          className={
            tab === "summary"
              ? "artifacts-tab artifacts-tab-active"
              : "artifacts-tab"
          }
          onClick={() => setTab("summary")}
        >
          Résumé
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "artifacts"}
          className={
            tab === "artifacts"
              ? "artifacts-tab artifacts-tab-active"
              : "artifacts-tab"
          }
          onClick={() => setTab("artifacts")}
        >
          Contenus{artifacts.length > 0 ? ` (${artifacts.length})` : ""}
        </button>
      </div>

      {tab === "summary" ? (
        <div className="artifacts-body">
          <section>
            <h3>Conversation</h3>
            <p className="muted">
              {recap.total} message(s) — {recap.counts.user} vous,{" "}
              {recap.counts.assistant} assistant, {recap.counts.subagent}{" "}
              sous-agent, {recap.counts.tool} outil, {recap.counts.system}{" "}
              système.
            </p>
          </section>
          <section>
            <h3>Fichiers évoqués</h3>
            {recap.filesMentioned.length === 0 ? (
              <p className="muted">Aucun fichier détecté pour l’instant.</p>
            ) : (
              <ul className="artifacts-list">
                {recap.filesMentioned.map((f) => (
                  <li key={f} className="artifacts-file" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>Décisions</h3>
            {recap.decisions.length === 0 ? (
              <p className="muted">
                Aucune décision enregistrée pour l’instant.
              </p>
            ) : (
              <ul className="artifacts-list">
                {recap.decisions.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <div className="artifacts-body">
          {artifacts.length === 0 ? (
            <p className="muted">
              Les extraits de code et les documents des réponses de Muse
              apparaîtront ici.
            </p>
          ) : (
            artifacts.map((a) => {
              const current =
                selected[a.id] ?? a.versions[a.versions.length - 1]?.v ?? 1;
              const ver =
                a.versions.find((x) => x.v === current) ?? a.versions[0];
              if (ver === undefined) return null;
              const draftKey = `${a.id}:${ver.v}`;
              const draft = drafts[draftKey] ?? ver.comment;
              return (
                <section key={a.id} className="artifact-card">
                  <header className="artifact-head">
                    <span
                      className="artifact-kind"
                      title={`${a.kind} · ${a.lang !== "" ? a.lang : "plain"}`}
                    >
                      {a.kind === "code"
                        ? a.lang !== ""
                          ? a.lang
                          : "code"
                        : "doc"}
                    </span>
                    <span className="artifact-title" title={a.title}>
                      {a.title}
                    </span>
                  </header>
                  <div
                    className="artifact-versions"
                    role="group"
                    aria-label={`Versions of ${a.title}`}
                  >
                    {a.versions.map((x) => (
                      <button
                        key={x.v}
                        type="button"
                        aria-pressed={x.v === ver.v}
                        className={
                          x.v === ver.v
                            ? "artifact-ver artifact-ver-active"
                            : "artifact-ver"
                        }
                        onClick={() =>
                          setSelected((cur) => ({ ...cur, [a.id]: x.v }))
                        }
                        title={x.comment !== "" ? x.comment : `Version ${x.v}`}
                      >
                        v{x.v}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="artifact-restore"
                      onClick={() => onRestore(sessionId, a.id, ver.v)}
                      title="Insérer cette version dans votre brouillon"
                    >
                      Réutiliser v{ver.v}
                    </button>
                  </div>
                  <pre className="artifact-code">{ver.text}</pre>
                  <label className="artifact-comment-label">
                    Note v{ver.v}
                    <input
                      type="text"
                      className="artifact-comment"
                      value={draft}
                      placeholder="Commentaire ancré à cette version…"
                      onChange={(e) =>
                        setDrafts((cur) => ({
                          ...cur,
                          [draftKey]: e.target.value,
                        }))
                      }
                      onBlur={() => {
                        if (draft !== ver.comment)
                          onComment(sessionId, a.id, ver.v, draft);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                  </label>
                </section>
              );
            })
          )}
        </div>
      )}
    </aside>
  );
}
