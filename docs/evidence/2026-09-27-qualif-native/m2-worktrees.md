# M2 — Worktrees: creation is perfect, but the conversation starts in the main repository (27 September 2026)

**The `create_worktree` mechanism is flawless; its wiring to the conversation is wrong.**
The "Create a new worktree" checkbox promises *"The conversation starts in a copy on a new branch"* —
yet, measured on the IPC wire, the session starts on the **main repository**, branch `pr620`.

## 1. Worktree mechanism — full PASS (`node scripts/ux-start-worktree.mjs --port 9222`)

```
welcome screen — the "Create a new worktree" checkbox is offered, unchecked by default,
  and says where the work will happen: "Create a new worktree The conversation works directly in openscreen."
creation with no session: muse/probe-mucri3h9
  {"repoRoot":"\\\\?\\C:\\…\\muse-desktop","path":"C:\\…\\muse-desktop\\.muse\\worktrees\\probe-mucri3h9",
   "branch":"muse/probe-mucri3h9","base":"HEAD","createdAt":…}
ok   the path is the plan's (.muse/worktrees/…)
ok   the branch is the one requested
ok   git knows this worktree
ok   a path outside .muse/worktrees is refused — "worktree path must be relative and stay inside .muse/worktrees"
ok   the worktree is removed
PASS
```

The supervisor's safety is validated (refusal outside `.muse/worktrees`, exact message) and cleanup is idempotent.

## 2. The complete "check the box → conversation" scenario — FAIL on the wiring

Real IPC wire (conversation "Reply with exactly the word: WT2", openscreen):

| # | Call | Measurement |
|---|---|---|
| 1 | `git_worktree_create_for_workspace` `{workspace: "G:\repos\openscreen", branch: "muse/openscreen-rn3d0", relativePath: ".muse/worktrees/openscreen-rn3d0", baseRef: "HEAD"}` | ✓ answers `{path: "G:\repos\openscreen\.muse\worktrees\openscreen-rn3d0", branch: "muse/openscreen-rn3d0", base: "HEAD"}` |
| 2 | `start_session` | ✗ **`workspacePath: "G:\repos\openscreen"`** — the **main** repository; response `workspace: \\?\G:\repos\openscreen` |
| 3 | `git_status` | ✗ **`branch: "pr620"`** — the main repository's branch, not `muse/openscreen-rn3d0` |
| 4 | `send_input` | ✓ turn started normally (`disposition: "started"`) — but in the main repository |

`git -C G:\repos\openscreen worktree list` confirms the worktrees really created and known to git:

```
G:/repos/openscreen/.muse/worktrees/openscreen          [muse/openscreen]
G:/repos/openscreen/.muse/worktrees/openscreen-eoo86    [muse/openscreen-eoo86]
G:/repos/openscreen/.muse/worktrees/openscreen-riptv    [muse/openscreen-riptv]
G:/repos/openscreen/.muse/worktrees/openscreen-rn3d0    [muse/openscreen-rn3d0]
```

The session's local record in `muse-desktop.sessions.v1` is itself consistent with the
measured reality (`workspace: \\?\G:\repos\openscreen`, `branch: "pr620"`) — it really is the
`workspacePath` passed to `start_session` that is at fault: **the `path` returned by
`git_worktree_create_for_workspace` is not passed on to `start_session`**.

Screenshot: [`shots/m2-worktree-session.png`](shots/m2-worktree-session.png).

## 3. Sub-agents (M2-04) — pieces measured

- `read_session_history` returns **`childSessionId`** items (a real child session created by the
  model) — observed on the "Count slowly…" conversation: `{"childSessionId":"078d364d-bf81-…"}`.
- **Sub-agent lanes with stop buttons** (`title="subagent/stop"`) are rendered in the thread and
  were captured in the `cdp-stop-terminal` runs.
- Remaining: a dedicated fan-out scenario capturing the parallel lanes and the parent's work
  resuming after a lane is stopped.

## M2 Windows verdict

- **M2-03 ("Create a worktree automatically")**: **creation** is proved (`git_worktree_create_for_workspace` → a `.muse/worktrees/…` path, a `muse/…` branch, a `HEAD` base, dangerous paths refused, rollback) but the atomic **"Create & open"** action does not open into the worktree: `start_session` receives the main repository. The "the conversation works in a worktree" acceptance is **not** met (M2-02/M2-05 along with it: no work is possible "on the branch" while the wiring is missing).
- **M2-05 (Local → Worktree)**: not replayed today; the wiring defect above is its prerequisite.
- **M2-07 (real sub-agents)**: pieces proved (`childSessionId` items in `read_session_history`, sub-agent lanes with `subagent/stop` buttons rendered and captured); the complete fan-out scenario + parent resume is still to replay.

## Lane concurrency (M2-07) — observed, controlled reproduction beyond the model's reach

- **Observed live on 27/09/2026**: two **simultaneous** `msg subagent subagent-running` lanes
  in the same render (children `e8af2a61-…` and `47a01e3d-…`, "thinking… Running", 17:02:34-41) —
  the app does render and follow the children in parallel.
- **Controlled reproduction not obtained**: despite an explicit order to overlap ("do NOT
  wait … the two subagents must overlap"), muse-spark serialises its delegation — 20 samples
  over 30 s (`window.__laneWatch`): `maxLanes=1`, `maxConcurrentRunning=1`. Model behaviour,
  not an app limit. Multi-thread concurrency (each thread spawning its child) remains the
  clean reproduction to do.

## Multi-thread reproduction — CONCURRENCY PROVED (run2, 27 September 2026)

Two simultaneous threads, each spawning sub-agents, sampled by switching threads:

| Sample | Thread | Lanes | `running` |
|---|---|---|---|
| t | A ("Reply with exactly the word: PTY") | 5 | **3 simultaneous** (`running, completed, running, completed, running`) |
| t+~4 s | B ("Start a subagent to summarize…") | 2 | **2 simultaneous** |
| back | B (re-checked) | 2 | **2 still in flight** |

**The app renders, follows and controls several sub-agents in parallel** — across threads **and** within one
thread (3 coexisting `running` lanes in A). The serialisation observed in run1 was therefore a
delegation choice by muse-spark, not an app limit. The M2-07 pieces (a child linked to the parent
thread through `childSessionId`, a `running → completed` cycle, controls bounded by state) are
consolidated by this real concurrency.

## Reproducibility

- Commit `4453efc`+; Windows 11 26200, WebView2, CDP 9222; `muse` 1.3.0.
- Sequence: `node scripts/ux-start-worktree.mjs --port 9222` → welcome screen, check
  `label.welcome-worktree`, start a conversation with the `window.fetch` trace reinstalled
  (`window.__museIpcTrace`) → read `git_worktree_create_for_workspace` / `start_session` /
  `git_status`; cross-check with `git -C G:\repos\openscreen worktree list`.
