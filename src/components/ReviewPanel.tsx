import { useEffect, useMemo, useState } from "react";
import {
  shortRepoName,
  statusCode,
  type GitCommitResult,
  type GitMutationExpectation,
  type GitDiffScope,
  type GitPrResult,
  type GitPushResult,
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
  onStageFiles: (
    sessionId: string,
    paths: string[],
    expected: GitMutationExpectation,
  ) => Promise<GitStatusSnapshot | null>;
  onRestoreFiles: (
    sessionId: string,
    paths: string[],
    scope: "staged" | "unstaged",
    expected: GitMutationExpectation,
  ) => Promise<GitStatusSnapshot | null>;
  onApplyHunk: (
    sessionId: string,
    path: string,
    scope: "staged" | "unstaged",
    action: "stage" | "unstage" | "discard",
    hunkHeader: string,
    expected: GitMutationExpectation,
  ) => Promise<GitStatusSnapshot | null>;
  onCommit: (
    sessionId: string,
    message: string,
    expected: GitMutationExpectation,
  ) => Promise<GitCommitResult | null>;
  onPush: (
    sessionId: string,
    remote: string,
    branch: string,
    expectedHead: string | null,
  ) => Promise<GitPushResult | null>;
  onCreatePr: (
    sessionId: string,
    title: string,
    body: string,
    base: string,
    head: string,
  ) => Promise<GitPrResult | null>;
  onSendComment: (anchor: ReviewAnchor, body: string) => Promise<boolean>;
}

const SCOPES: Array<[GitDiffScope, string]> = [
  ["unstaged", "Unstaged"],
  ["staged", "Staged"],
  ["branch", "Branch"],
];

/**
 * M1-01/M1-03 review surface. Every value comes from the session-scoped Rust
 * Git service; the panel never infers changes from assistant text.
 */
export function ReviewPanel({
  sessionId,
  review,
  onRefreshStatus,
  onLoadDiff,
  onStageFiles,
  onRestoreFiles,
  onApplyHunk,
  onCommit,
  onPush,
  onCreatePr,
  onSendComment,
}: Props) {
  const [scope, setScope] = useState<GitDiffScope>("unstaged");
  const [baseRef, setBaseRef] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentSending, setCommentSending] = useState(false);
  const [commentSent, setCommentSent] = useState(false);
  const [mutationBusy, setMutationBusy] = useState<"stage" | "unstage" | "discard" | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmBulkDiscard, setConfirmBulkDiscard] = useState(false);
  const [hunkBusy, setHunkBusy] = useState<string | null>(null);
  const [confirmHunk, setConfirmHunk] = useState<string | null>(null);
  const [selectedHunkHeader, setSelectedHunkHeader] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [pushRemote, setPushRemote] = useState("");
  const [pushBranch, setPushBranch] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("main");
  const [shipBusy, setShipBusy] = useState<"commit" | "push" | "pr" | null>(null);
  const [commitResult, setCommitResult] = useState<GitCommitResult | null>(null);
  const [pushResult, setPushResult] = useState<GitPushResult | null>(null);
  const [prResult, setPrResult] = useState<GitPrResult | null>(null);

  useEffect(() => {
    setSelectedPath(null);
    setSelectedPaths([]);
    setSelectedLineKey(null);
    setCommentDraft("");
    setCommentError(null);
    setCommentSent(false);
    setMutationBusy(null);
    setMutationError(null);
    setConfirmDiscard(false);
    setConfirmBulkDiscard(false);
    setHunkBusy(null);
    setConfirmHunk(null);
    setSelectedHunkHeader(null);
    setCommitMessage("");
    setPushRemote("");
    setPushBranch("");
    setPrTitle("");
    setPrBody("");
    setPrBase("main");
    setShipBusy(null);
    setCommitResult(null);
    setPushResult(null);
    setPrResult(null);
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
  const selectedHunk = useMemo(
    () =>
      selectedDiff?.hunks.find((hunk) => hunk.header === selectedHunkHeader) ??
      selectedDiff?.hunks[0] ??
      null,
    [selectedDiff, selectedHunkHeader],
  );
  const selectedStatus = useMemo(
    () =>
      review.status?.files.find((file) => file.path === selectedPath) ?? null,
    [review.status, selectedPath],
  );
  const selectedFileRows = useMemo(
    () => review.status?.files.filter((file) => selectedPaths.includes(file.path)) ?? [],
    [review.status, selectedPaths],
  );
  const bulkStageCount = selectedFileRows.filter((file) => file.unstaged || file.untracked).length;
  const bulkUnstageCount = selectedFileRows.filter((file) => file.staged).length;
  const bulkDiscardCount = selectedFileRows.filter((file) => file.unstaged && !file.untracked).length;

  useEffect(() => {
    const first = review.diff?.files[0]?.path ?? null;
    setSelectedPath((current) => current ?? first);
  }, [review.diff]);

  useEffect(() => {
    const firstRemote = review.status?.remotes[0]?.name ?? "";
    if (firstRemote) setPushRemote((current) => current || firstRemote);
    const branch = review.status?.branch ?? "";
    if (branch) {
      setPushBranch((current) => current || branch);
      setPrTitle((current) => current || `Muse changes on ${branch}`);
    }
  }, [review.status?.remotes, review.status?.branch]);

  useEffect(() => {
    setSelectedLineKey(null);
    setCommentError(null);
    setCommentSent(false);
    setMutationError(null);
    setConfirmDiscard(false);
    setConfirmBulkDiscard(false);
    setHunkBusy(null);
    setConfirmHunk(null);
    setSelectedHunkHeader(null);
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

  function expectationFor(scope: "staged" | "unstaged"): GitMutationExpectation | null {
    if (!review.status) return null;
    const patch =
      review.diff?.scope === scope && review.diff.patchTruncated === false
        ? review.diff.patch
        : null;
    return {
      head: review.status.head,
      statusFingerprint: review.status.fingerprint,
      patch,
    };
  }

  async function runMutation(action: "stage" | "unstage" | "discard"): Promise<void> {
    if (!selectedStatus || !review.status) return;
    const scope = action === "stage" ? "unstaged" : action === "unstage" ? "staged" : "unstaged";
    const expected = expectationFor(scope);
    if (!expected) return;
    setMutationBusy(action);
    setMutationError(null);
    try {
      const next =
        action === "stage"
          ? await onStageFiles(sessionId, [selectedStatus.path], expected)
          : await onRestoreFiles(sessionId, [selectedStatus.path], scope, expected);
      if (next === null) {
        setMutationError("Action not applied. Refresh the repository and try again.");
        return;
      }
      setSelectedLineKey(null);
      setCommentDraft("");
      setCommentSent(false);
      setConfirmDiscard(false);
    } finally {
      setMutationBusy(null);
    }
  }

  async function runBulkMutation(action: "stage" | "unstage" | "discard"): Promise<void> {
    if (!review.status || selectedPaths.length === 0) return;
    const scope = action === "unstage" ? "staged" : "unstaged";
    const paths = review.status.files
      .filter((file) => selectedPaths.includes(file.path))
      .filter((file) =>
        action === "stage"
          ? file.unstaged || file.untracked
          : action === "unstage"
            ? file.staged
            : file.unstaged && !file.untracked,
      )
      .map((file) => file.path);
    if (paths.length === 0) {
      setMutationError(
        action === "discard"
          ? "Only tracked files with unstaged changes can be discarded here."
          : "No selected files match this action.",
      );
      return;
    }
    const expected = expectationFor(scope);
    if (!expected) {
      setMutationError("Load the complete diff before applying a bulk action.");
      return;
    }
    setMutationBusy(action);
    setMutationError(null);
    try {
      const next =
        action === "stage"
          ? await onStageFiles(sessionId, paths, expected)
          : await onRestoreFiles(sessionId, paths, scope, expected);
      if (next === null) {
        setMutationError("Action not applied. Refresh the repository and try again.");
        return;
      }
      setSelectedPaths([]);
      setSelectedLineKey(null);
      setCommentDraft("");
      setCommentSent(false);
      setConfirmBulkDiscard(false);
    } finally {
      setMutationBusy(null);
    }
  }

  async function runHunkMutation(
    action: "stage" | "unstage" | "discard",
    hunkHeader: string,
  ): Promise<void> {
    if (!selectedStatus || !review.status || !review.diff || review.diff.scope === "branch") return;
    if (selectedStatus.untracked || selectedDiff?.binary) return;
    const scope = review.diff.scope;
    if ((action === "stage" || action === "discard") && scope !== "unstaged") return;
    if (action === "unstage" && scope !== "staged") return;
    const expected = expectationFor(scope);
    if (!expected || expected.patch === null) {
      setMutationError("Load the complete diff before applying a hunk.");
      return;
    }
    const busyKey = `${action}:${hunkHeader}`;
    setHunkBusy(busyKey);
    setMutationError(null);
    try {
      const next = await onApplyHunk(
        sessionId,
        selectedStatus.path,
        scope,
        action,
        hunkHeader,
        expected,
      );
      if (next === null) {
        setMutationError("Hunk action not applied. Refresh the repository and try again.");
        return;
      }
      setSelectedLineKey(null);
      setSelectedHunkHeader(null);
      setCommentDraft("");
      setCommentSent(false);
      setConfirmHunk(null);
    } finally {
      setHunkBusy(null);
    }
  }

  async function commitStaged(): Promise<void> {
    const expected = expectationFor("staged");
    if (!expected || commitMessage.trim().length === 0) return;
    setShipBusy("commit");
    setCommitResult(null);
    try {
      const result = await onCommit(sessionId, commitMessage, expected);
      if (result) {
        setCommitResult(result);
        setCommitMessage("");
      }
    } finally {
      setShipBusy(null);
    }
  }

  async function pushBranchNow(): Promise<void> {
    if (!review.status || pushRemote.trim().length === 0 || pushBranch.trim().length === 0) return;
    setShipBusy("push");
    setPushResult(null);
    try {
      const result = await onPush(
        sessionId,
        pushRemote.trim(),
        pushBranch.trim(),
        review.status.head,
      );
      if (result) setPushResult(result);
    } finally {
      setShipBusy(null);
    }
  }

  async function createPullRequest(): Promise<void> {
    if (
      prTitle.trim().length === 0 ||
      prBase.trim().length === 0 ||
      pushBranch.trim().length === 0
    ) {
      return;
    }
    setShipBusy("pr");
    setPrResult(null);
    try {
      const result = await onCreatePr(
        sessionId,
        prTitle,
        prBody,
        prBase.trim(),
        pushBranch.trim(),
      );
      if (result) setPrResult(result);
    } finally {
      setShipBusy(null);
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
                  <label className="review-file-select">
                    <input
                      type="checkbox"
                      checked={selectedPaths.includes(file.path)}
                      onChange={() =>
                        setSelectedPaths((current) =>
                          current.includes(file.path)
                            ? current.filter((path) => path !== file.path)
                            : [...current, file.path],
                        )
                      }
                      aria-label={`Select ${file.path}`}
                    />
                  </label>
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
                  setSelectedPaths([]);
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

          {selectedStatus !== null && (
            <div className="review-file-actions" aria-label="File actions">
              {selectedStatus.unstaged || selectedStatus.untracked ? (
                <button
                  type="button"
                  className="review-action"
                  disabled={mutationBusy !== null}
                  onClick={() => void runMutation("stage")}
                >
                  {mutationBusy === "stage" ? "Staging…" : "Stage file"}
                </button>
              ) : null}
              {selectedStatus.staged ? (
                <button
                  type="button"
                  className="review-action"
                  disabled={mutationBusy !== null}
                  onClick={() => void runMutation("unstage")}
                >
                  {mutationBusy === "unstage" ? "Unstaging…" : "Unstage file"}
                </button>
              ) : null}
              {selectedStatus.unstaged && !selectedStatus.untracked && !confirmDiscard ? (
                <button
                  type="button"
                  className="review-action review-action-danger"
                  disabled={mutationBusy !== null}
                  onClick={() => setConfirmDiscard(true)}
                >
                  Discard changes…
                </button>
              ) : null}
              {selectedStatus.unstaged && !selectedStatus.untracked && confirmDiscard ? (
                <>
                  <span className="review-confirm-label">Discard this file?</span>
                  <button
                    type="button"
                    className="review-action review-action-danger"
                    disabled={mutationBusy !== null}
                    onClick={() => void runMutation("discard")}
                  >
                    {mutationBusy === "discard" ? "Discarding…" : "Confirm discard"}
                  </button>
                  <button
                    type="button"
                    className="review-action"
                    disabled={mutationBusy !== null}
                    onClick={() => setConfirmDiscard(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : null}
              {selectedStatus.untracked && (
                <span className="muted review-action-note">Untracked files are never deleted here.</span>
              )}
              {mutationError && <span className="review-action-error" role="alert">{mutationError}</span>}
            </div>
          )}

          {selectedFileRows.length > 0 && (
            <div className="review-bulk-actions" aria-label="Bulk file actions">
              <span className="muted">{selectedFileRows.length} selected</span>
              <button
                type="button"
                className="review-action"
                disabled={
                  mutationBusy !== null ||
                  bulkStageCount === 0 ||
                  review.diff?.scope !== "unstaged"
                }
                onClick={() => void runBulkMutation("stage")}
              >
                {mutationBusy === "stage" ? "Staging…" : `Stage ${bulkStageCount}`}
              </button>
              <button
                type="button"
                className="review-action"
                disabled={
                  mutationBusy !== null ||
                  bulkUnstageCount === 0 ||
                  review.diff?.scope !== "staged"
                }
                onClick={() => void runBulkMutation("unstage")}
              >
                {mutationBusy === "unstage" ? "Unstaging…" : `Unstage ${bulkUnstageCount}`}
              </button>
              {review.diff?.scope === "unstaged" && bulkDiscardCount > 0 && !confirmBulkDiscard && (
                <button
                  type="button"
                  className="review-action review-action-danger"
                  disabled={mutationBusy !== null}
                  onClick={() => setConfirmBulkDiscard(true)}
                >
                  Discard {bulkDiscardCount}…
                </button>
              )}
              {review.diff?.scope === "unstaged" && bulkDiscardCount > 0 && confirmBulkDiscard && (
                <>
                  <span className="review-confirm-label">Discard selected tracked files?</span>
                  <button
                    type="button"
                    className="review-action review-action-danger"
                    disabled={mutationBusy !== null}
                    onClick={() => void runBulkMutation("discard")}
                  >
                    {mutationBusy === "discard" ? "Discarding…" : "Confirm discard"}
                  </button>
                  <button
                    type="button"
                    className="review-action"
                    disabled={mutationBusy !== null}
                    onClick={() => setConfirmBulkDiscard(false)}
                  >
                    Cancel
                  </button>
                </>
              )}
              {selectedFileRows.some((file) => file.untracked) && (
                <span className="muted review-action-note">Untracked files remain untouched.</span>
              )}
            </div>
          )}

          {selectedDiff !== null &&
            review.diff !== null &&
            review.diff.scope !== "branch" &&
            !selectedDiff.binary &&
            !selectedStatus?.untracked &&
            selectedDiff.hunks.length > 0 && (
              <section className="review-hunk-actions" aria-label="Hunk actions">
                <div className="review-hunk-head">
                  <div>
                    <span className="eyebrow">PARTIAL CHANGE</span>
                    <strong>{review.diff.scope === "staged" ? "Unstage" : "Stage or discard"} one hunk</strong>
                  </div>
                  <span className="muted">Fresh diff required</span>
                </div>
                <div className="review-hunk-list" role="list" aria-label="Diff hunks">
                  {selectedDiff.hunks.map((hunk, index) => {
                    const stats = selectedRows.filter((row) => row.hunk === hunk.header);
                    const active = selectedHunk?.header === hunk.header;
                    return (
                      <button
                        key={hunk.header}
                        type="button"
                        role="listitem"
                        className={`review-hunk${active ? " selected" : ""}`}
                        aria-pressed={active}
                        onClick={() => {
                          setSelectedHunkHeader(hunk.header);
                          setConfirmHunk(null);
                        }}
                      >
                        <span>Hunk {index + 1}</span>
                        <span className="muted">+{stats.filter((row) => row.prefix === "+").length} −{stats.filter((row) => row.prefix === "-").length}</span>
                      </button>
                    );
                  })}
                </div>
                {selectedHunk !== null && (
                  <div className="review-hunk-toolbar">
                    <span className="muted">{selectedHunk.header}</span>
                    {review.diff.scope === "unstaged" && (
                      <button
                        type="button"
                        className="review-action"
                        disabled={hunkBusy !== null}
                        onClick={() => void runHunkMutation("stage", selectedHunk.header)}
                      >
                        {hunkBusy === `stage:${selectedHunk.header}` ? "Staging…" : "Stage hunk"}
                      </button>
                    )}
                    {review.diff.scope === "staged" && (
                      <button
                        type="button"
                        className="review-action"
                        disabled={hunkBusy !== null}
                        onClick={() => void runHunkMutation("unstage", selectedHunk.header)}
                      >
                        {hunkBusy === `unstage:${selectedHunk.header}` ? "Unstaging…" : "Unstage hunk"}
                      </button>
                    )}
                    {review.diff.scope === "unstaged" && confirmHunk !== selectedHunk.header && (
                      <button
                        type="button"
                        className="review-action review-action-danger"
                        disabled={hunkBusy !== null}
                        onClick={() => setConfirmHunk(selectedHunk.header)}
                      >
                        Discard hunk…
                      </button>
                    )}
                    {review.diff.scope === "unstaged" && confirmHunk === selectedHunk.header && (
                      <>
                        <span className="review-confirm-label">Discard this hunk?</span>
                        <button
                          type="button"
                          className="review-action review-action-danger"
                          disabled={hunkBusy !== null}
                          onClick={() => void runHunkMutation("discard", selectedHunk.header)}
                        >
                          {hunkBusy === `discard:${selectedHunk.header}` ? "Discarding…" : "Confirm discard"}
                        </button>
                        <button
                          type="button"
                          className="review-action"
                          disabled={hunkBusy !== null}
                          onClick={() => setConfirmHunk(null)}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                )}
              </section>
            )}

          <section className="review-ship" aria-label="Ship changes">
            <div className="review-ship-head">
              <div>
                <span className="eyebrow">SHIP CHANGES</span>
                <strong>Commit, push and open a pull request</strong>
              </div>
              <span className="muted">Every destination is explicit</span>
            </div>
            <div className="review-ship-row">
              <input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                aria-label="Commit message"
              />
              <button
                type="button"
                className="review-action"
                disabled={shipBusy !== null || !review.status?.files.some((file) => file.staged) || commitMessage.trim().length === 0}
                onClick={() => void commitStaged()}
              >
                {shipBusy === "commit" ? "Committing…" : "Commit staged"}
              </button>
            </div>
            {commitResult && (
              <div className="review-ship-result">Committed {commitResult.hash.slice(0, 8)} · {commitResult.subject}</div>
            )}
            <div className="review-ship-row">
              <select value={pushRemote} onChange={(event) => setPushRemote(event.target.value)} aria-label="Push remote">
                <option value="">Choose remote</option>
                {(review.status?.remotes ?? []).map((remote) => (
                  <option key={remote.name} value={remote.name}>{remote.name} · {remote.url}</option>
                ))}
              </select>
              <input value={pushBranch} onChange={(event) => setPushBranch(event.target.value)} placeholder="Target branch" aria-label="Push branch" />
              <button
                type="button"
                className="review-action"
                disabled={shipBusy !== null || pushRemote.trim().length === 0 || pushBranch.trim().length === 0 || !review.status?.head}
                onClick={() => void pushBranchNow()}
              >
                {shipBusy === "push" ? "Pushing…" : "Push branch"}
              </button>
            </div>
            {pushResult && <div className="review-ship-result">Pushed {pushResult.remote} → {pushResult.branch} · {pushResult.head.slice(0, 8)}</div>}
            <div className="review-ship-pr">
              <div className="review-ship-row">
                <input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} placeholder="Pull request title" aria-label="Pull request title" />
                <input value={prBase} onChange={(event) => setPrBase(event.target.value)} placeholder="Base branch" aria-label="Pull request base branch" />
                <button
                  type="button"
                  className="review-action"
                  disabled={shipBusy !== null || prTitle.trim().length === 0 || prBase.trim().length === 0 || pushBranch.trim().length === 0}
                  onClick={() => void createPullRequest()}
                >
                  {shipBusy === "pr" ? "Opening…" : "Open pull request"}
                </button>
              </div>
              <textarea value={prBody} onChange={(event) => setPrBody(event.target.value)} placeholder="Describe the change (optional)" aria-label="Pull request description" rows={2} />
              {prResult && <a className="review-ship-result review-ship-link" href={prResult.url} target="_blank" rel="noreferrer">Open pull request · {prResult.head} → {prResult.base}</a>}
            </div>
          </section>

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
                        setSelectedHunkHeader(row.hunk);
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
