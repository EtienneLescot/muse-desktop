# M2 closure campaign — first tickets (26 September 2026)

**Platform:** Windows 11 (build 26200) · dev build (WebView2, CDP 9222, real
Muse sidecar 1.3.0). Live model turns wherever a turn was needed.

**Objective:** close the Windows-reachable M2 criteria. Three tickets move to
☑ (M2-02, M2-03, M2-07); the others' precise remainders are stated below.

## Results

| Ticket | Scenario | Result |
|---|---|---|
| **M2-02** | sandbox postures really apply (`m2-02-postures.json`) | **Windows closed** — posture switch + **Restart workspace host** respawns the host with the right flags (`workspace` → `--sandbox-network restricted`), and **two projects run two different postures simultaneously** (restricted beside `enabled`), read from the live process command lines. The refusal ("workspace host already uses sandbox posture…"), the elevated projection (`--disable-sandbox --sandbox-network enabled`) and the kill-durability are proved in the M0 records (`m0-04-strict-tool-stop.json` finding_context, `m0-06-posture.json`) and cross-referenced in the evidence file. |
| **M2-03** | worktree Create & open (`m2-03-worktree-create-open.json`) | **Windows closed** — the 25/09 fix's outstanding in-app replay passes: with the Worktree switch on, the conversation **starts inside the fresh worktree** (header workspace `…\.muse\worktrees\m1-qualification-xcgyr`), git announces the `muse/m1-qualification-xcgyr` branch (`git worktree list` confirms the attachment), and the first live turn answers in it. Refusals + rollback were proved on 27/09 (`ux-start-worktree.mjs`). |
| **M2-04** | worktree environment setup (`m2-04-06-setup-cleanup.json`) | **Windows closed — feature built this campaign.** An audit found the setup runner **never wired** (design types only). Built: Rust runner (`git_worktree_setup_run/cancel` — command ≤ 2,000 chars, confined to `.muse/worktrees`, ten-minute kill, ready/failed/timedOut/cancelled), readiness (`git_worktree_readiness` — package.json/Cargo.toml/pyproject.toml/go.mod + toolchains) and the Settings surface. Native proof: setup runs in the worktree (proof file written there), failure reports `failed · exit 5`, cancellation ends a 30 s command, readiness detects `package.json` + `git`/`node`, the main checkout is refused (outside confinement). 31 Rust tests cover the guards. |
| **M2-06** | worktree cleanup (`m2-04-06-setup-cleanup.json`) | **Windows closed — feature built this campaign.** The audit found only cleanup-intent persistence wired. Built: `git_worktree_inspect` (branch/HEAD/clean/conflicted/age per worktree, from Git + filesystem) + `git_worktree_remove` (confined, dirty refused unless forced) + the Settings list with per-repository retention. Native proof: **Inspect all** lists the main checkout and worktrees with real status; a **dirty worktree is flagged and its removal refused** ("worktree has uncommitted changes…"); a **clean unattached worktree is removed** from the panel; the retention select persists per repository. The active conversation's worktree is always spared. |
| **M2-07** | sub-agent fan-out + parent resume (`m2-07-subagent-fanout.json`) | **Windows closed** — a live delegation turn spawns controllable lanes; a lane is **stopped through its own `subagent/stop` control** (transition to Stopped); switching away and back resumes the parent with the lane history intact (terminal states preserved, nothing re-runs). Concurrency was proved on 27/09 (3+2 simultaneous lanes across two threads). Distinction recorded: muse-spark mostly delegates through host-internal reminder children (`subagentInternal`, no controls by design); controllable lanes appear on explicit delegation orders. |
| M2-01 | persistent folders | ◐ — the single remaining piece is contractual: `workspaces[]` has **no backend equivalent** (one project = one folder on the CLI side). Everything else is proved natively. |
| M2-05 | Local ↔ Worktree handoff | ◐ — **host-blocked**: the actual transfer needs a multi-workspace MSP contract that does not exist. Prepare-handoff plan + Open-with-context are implemented. |
| M2-08 | several writers | ◐ — **protocol-blocked**: MSP provides neither a file lock, nor a structured writer result, nor confirmed atomic cancellation. |

## Reproducibility

```
npm run build && cargo build --manifest-path src-tauri/Cargo.toml
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/debug/muse-desktop.exe
node scripts/cdp-m2-03-worktree.mjs --out docs/evidence/2026-09-26-m2-closure/m2-03-worktree-create-open.json
node scripts/cdp-m2-02-postures.mjs --out docs/evidence/2026-09-26-m2-closure/m2-02-postures.json
node scripts/cdp-m2-07-subagents.mjs --out docs/evidence/2026-09-26-m2-closure/m2-07-subagent-fanout.json
```

The M2-03 harness resets `G:\repos\m1-qualification` (scratch) on every run.
Note for harness authors: a CDP-driven app keeps the Node process alive through
the open WebSocket — end harnesses with `process.exit()`, and prefer out-of-band
git reads with a timeout when the app's host may hold `index.lock`.
