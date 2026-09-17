import { useEffect, useMemo, useState } from "react";
import {
  shortRepoName,
  statusCode,
  type GitDiffScope,
  type GitReviewState,
} from "../lib/git";

interface Props {
  sessionId: string;
  review: GitReviewState;
  onRefreshStatus: (sessionId: string) => Promise<void>;
  onLoadDiff: (
    sessionId: string,
    scope: GitDiffScope,
    baseRef?: string,
  ) => Promise<void>;
}

const SCOPES: Array<[GitDiffScope, string]> = [
  ["unstaged", "Unstaged"],
  ["staged", "Staged"],
  ["branch", "Branch"],
];

/**
 * M1-01 read-only review surface. Every value comes from the session-scoped
 * Rust Git service; the panel never infers changes from assistant text.
 */
export function ReviewPanel({
  sessionId,
  review,
  onRefreshStatus,
  onLoadDiff,
}: Props) {
  const [scope, setScope] = useState<GitDiffScope>("unstaged");
  const [baseRef, setBaseRef] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPath(null);
    setScope("unstaged");
    setBaseRef("");
    void onRefreshStatus(sessionId);
  }, [sessionId, onRefreshStatus]);

  const branchRef = review.status?.upstream ?? "";
  const resolvedBase = baseRef.trim() || branchRef;
  const changedCount = review.status?.files.length ?? 0;
  const selectedDiff = useMemo(
    () =>
      review.diff?.files.find((file) => file.path === selectedPath) ?? null,
    [review.diff, selectedPath],
  );

  async function loadDiff(): Promise<void> {
    if (scope === "branch" && resolvedBase.length === 0) return;
    await onLoadDiff(
      sessionId,
      scope,
      scope === "branch" ? resolvedBase : undefined,
    );
  }

  return (
    <section className="review-panel" aria-label="Git review">
      <header className="review-panel-head">
        <div>
          <span className="eyebrow">REPOSITORY REVIEW</span>
          <h2>{review.status ? shortRepoName(review.status.repoRoot) : "Git review"}</h2>
        </div>
        <button
          type="button"
          className="review-refresh"
          onClick={() => void onRefreshStatus(sessionId)}
          disabled={review.loading}
        >
          {review.loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {review.error !== null && (
        <div className="review-error" role="alert">
          Git review unavailable: {review.error}
        </div>
      )}

      {review.status === null ? (
        <p className="muted review-empty">
          Refresh to inspect the real repository state for this conversation.
        </p>
      ) : (
        <>
          <div className="review-repo-meta">
            <span>
              <strong>{review.status.branch ?? "Detached HEAD"}</strong>
              {review.status.upstream && ` · tracks ${review.status.upstream}`}
            </span>
            <span className="review-count">
              {changedCount} changed file{changedCount === 1 ? "" : "s"}
            </span>
            {(review.status.ahead > 0 || review.status.behind > 0) && (
              <span className="muted">
                {review.status.ahead} ahead · {review.status.behind} behind
              </span>
            )}
          </div>

          {review.status.files.length === 0 ? (
            <p className="muted review-empty">Working tree clean.</p>
          ) : (
            <ul className="review-files" aria-label="Changed files">
              {review.status.files.map((file) => (
                <li key={`${file.path}:${file.originalPath ?? ""}`}>
                  <button
                    type="button"
                    className={selectedPath === file.path ? "selected" : undefined}
                    onClick={() => setSelectedPath(file.path)}
                    title={file.originalPath ? `Renamed from ${file.originalPath}` : file.path}
                  >
                    <code className="review-status-code">{statusCode(file)}</code>
                    <span className="review-file-name">{file.path}</span>
                    {file.binary && <span className="review-binary">binary</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="review-diff-controls" aria-label="Diff scope">
            {SCOPES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={scope === value ? "active" : undefined}
                aria-pressed={scope === value}
                onClick={() => {
                  setScope(value);
                  setSelectedPath(null);
                }}
              >
                {label}
              </button>
            ))}
            {scope === "branch" && (
              <input
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                placeholder={branchRef || "base ref (required)"}
                aria-label="Branch diff base ref"
              />
            )}
            <button
              type="button"
              className="review-load"
              disabled={review.loading || (scope === "branch" && resolvedBase.length === 0)}
              onClick={() => void loadDiff()}
            >
              {review.loading ? "Loading…" : "Load diff"}
            </button>
          </div>

          {review.diff !== null && (
            <div className="review-diff" aria-label={`${review.diff.scope} diff`}>
              <div className="review-diff-meta">
                <span>
                  {review.diff.files.length} file{review.diff.files.length === 1 ? "" : "s"} · {review.diff.scope}
                </span>
                {review.diff.patchTruncated && (
                  <span className="muted">Patch truncated for safety</span>
                )}
              </div>
              {selectedDiff !== null && (
                <div className="review-selected-file">
                  <strong>{selectedDiff.path}</strong>
                  <span className="muted">
                    {selectedDiff.binary
                      ? "Binary file"
                      : `${selectedDiff.hunks.length} hunk${selectedDiff.hunks.length === 1 ? "" : "s"} · +${selectedDiff.additions} −${selectedDiff.deletions}`}
                  </span>
                </div>
              )}
              <pre className="review-patch">{review.diff.patch || "No changes in this scope."}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
