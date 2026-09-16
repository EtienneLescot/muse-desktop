import { useEffect, useMemo, useState } from "react";
import {
  shortRepoName,
  statusCode,
  type GitDiffScope,
  type GitReviewState,
  type GitStatusSnapshot,
} from "../lib/git";
import {
  anchorMatchesDiff,
  createReviewAnchor,
  patchLinesForFile,
  type ReviewAnchor,
  type ReviewPatchLine,
} from "../lib/reviewComments";

interface Props {
  sessionId: string;
  review: GitReviewState;
  onRefreshStatus: (sessionId: string) => Promise<GitStatusSnapshot | null>;
  onLoadDiff: (
    sessionId: string,
    scope: GitDiffScope,
    baseRef?: string,
  ) => Promise<GitReviewState["diff"]>;
  onSendComment: (anchor: ReviewAnchor, body: string) => Promise<boolean>;
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
  onSendComment,
}: Props) {
  const [scope, setScope] = useState<GitDiffScope>("unstaged");
  const [baseRef, setBaseRef] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentSending, setCommentSending] = useState(false);
  const [commentSent, setCommentSent] = useState(false);

  useEffect(() => {
    setSelectedPath(null);
    setSelectedLineKey(null);
    setCommentDraft("");
    setCommentError(null);
    setCommentSent(false);
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
  const selectedRows = useMemo(
    () =>
      review.diff && selectedDiff
        ? patchLinesForFile(review.diff.patch, selectedDiff)
        : [],
    [review.diff, selectedDiff],
  );
  const selectedLine = useMemo(
    () => selectedRows.find((row) => row.key === selectedLineKey) ?? null,
    [selectedRows, selectedLineKey],
  );

  useEffect(() => {
    const first = review.diff?.files[0]?.path ?? null;
    setSelectedPath((current) => current ?? first);
  }, [review.diff]);

  useEffect(() => {
    setSelectedLineKey(null);
    setCommentError(null);
    setCommentSent(false);
  }, [selectedPath, review.diff?.observedAt]);

  async function loadDiff(): Promise<void> {
    if (scope === "branch" && resolvedBase.length === 0) return;
    await onLoadDiff(
      sessionId,
      scope,
      scope === "branch" ? resolvedBase : undefined,
    );
  }

  async function sendComment(): Promise<void> {
    if (
      !selectedLine ||
      !selectedDiff ||
      !review.status ||
      !review.diff ||
      commentDraft.trim().length === 0
    ) {
      return;
    }
    const anchor = createReviewAnchor(
      review.status,
      review.diff,
      selectedDiff,
      selectedLine,
    );
    setCommentSending(true);
    setCommentError(null);
    setCommentSent(false);
    try {
      const latestStatus = await onRefreshStatus(sessionId);
      if (
        latestStatus === null ||
        !anchorMatchesDiff(anchor, latestStatus, review.diff)
      ) {
        setCommentError("This diff changed. Refresh and select the line again.");
        return;
      }
      const latestDiff = await onLoadDiff(
        sessionId,
        anchor.scope,
        anchor.scope === "branch" ? anchor.baseRef ?? undefined : undefined,
      );
      if (
        latestDiff === null ||
        !anchorMatchesDiff(anchor, latestStatus, latestDiff)
      ) {
        setCommentError("This diff changed. Refresh and select the line again.");
        return;
      }
      const sent = await onSendComment(anchor, commentDraft);
      if (!sent) {
        setCommentError("The comment could not be sent. The draft is preserved.");
        return;
      }
      setCommentDraft("");
      setCommentSent(true);
    } finally {
      setCommentSending(false);
    }
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
                  setSelectedLineKey(null);
                  setCommentSent(false);
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
              {selectedDiff !== null && selectedRows.length > 0 ? (
                <div className="review-code" aria-label={`Patch for ${selectedDiff.path}`} role="list">
                  {selectedRows.map((row: ReviewPatchLine) => (
                    <button
                      key={row.key}
                      type="button"
                      role="listitem"
                      className={`review-code-line review-code-${row.prefix === "+" ? "add" : row.prefix === "-" ? "delete" : "context"}${selectedLineKey === row.key ? " selected" : ""}`}
                      onClick={() => {
                        setSelectedLineKey(row.key);
                        setCommentError(null);
                        setCommentSent(false);
                      }}
                      title={`Comment on ${row.side} line ${row.side === "old" ? row.oldLine : row.newLine}`}
                    >
                      <span className="review-line-number">{row.oldLine ?? ""}</span>
                      <span className="review-line-number">{row.newLine ?? ""}</span>
                      <code><span className="review-line-prefix">{row.prefix}</span>{row.text || " "}</code>
                    </button>
                  ))}
                </div>
              ) : (
                <pre className="review-patch">{review.diff.patch || "No changes in this scope."}</pre>
              )}
              {selectedLine !== null && selectedDiff !== null && (
                <form
                  className="review-comment-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void sendComment();
                  }}
                >
                  <div className="review-comment-head">
                    <strong>
                      Comment on {selectedDiff.path}:{selectedLine.side === "old" ? selectedLine.oldLine : selectedLine.newLine}
                    </strong>
                    <span className="muted">{selectedLine.side} side</span>
                  </div>
                  <textarea
                    value={commentDraft}
                    onChange={(event) => {
                      setCommentDraft(event.target.value);
                      setCommentSent(false);
                    }}
                    placeholder="Explain what should change…"
                    rows={3}
                    aria-label="Review comment"
                  />
                  <div className="review-comment-actions">
                    {commentError && <span className="review-comment-error" role="alert">{commentError}</span>}
                    {commentSent && <span className="review-comment-sent">Sent to conversation</span>}
                    <button type="submit" className="review-send-comment" disabled={commentSending || commentDraft.trim().length === 0}>
                      {commentSending ? "Checking diff…" : "Send comment"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
