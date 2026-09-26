# Operational roadmap — Muse-Desktop

Reference state: **20 September 2026**, repository at `064e210` (main, after merging PRs #18–#153).
Updated **27 September 2026** by a **native Windows qualification** campaign (repository at `362c8bb`, PRs up to #227): evidence in [`docs/evidence/2026-09-27-qualif-native/`](evidence/2026-09-27-qualif-native/). Updated again **25–26 September 2026** by the **M0 completion campaign** — every Windows-reachable M0 criterion replayed natively, M0-08 gap fixed: evidence in [`docs/evidence/2026-09-25-m0-completion/`](evidence/2026-09-25-m0-completion/). Goal: finish the existing paths, then reach parity with the Codex desktop workflows while keeping Muse branding. The M0 → M4 order was approved by Étienne.

This document is the source of truth for product progress. It is split **by platform** because most remaining tickets do not close at the same time on every OS. The [SPEC](SPEC.md) preserves the original intentions; the [13 September review](plans/2026-09-13-roadmap-progress.md) is historical. The [parity audit](plans/2026-09-15-codex-parity-audit.md) holds the technical findings and official references. Counts of merged stories are not a parity rate.

**For coding agents:** the [detailed implementation plan](plans/2026-09-15-agent-implementation-plan.md) covers the 53 IDs below: code to read, proposed contracts, steps, dependencies, acceptance tests and delivery format. That plan complements the statuses; it is not proof of implementation.

> **Revision of 20 September 2026.** This roadmap replaces the previous version, which was organised by axis (Design / UI / Function / Validation) and enriched with detailed delivery reviews. It is now organised by **progress state** and by **platform**, with three states only. The earlier version is still readable in the Git history:
>
> ```sh
> git show 064e210:docs/ROADMAP.md        # by-axis version, 720 lines, blob 319cb128
> ```
>
> Nothing was lost: the delivery reviews, test measurements and bundle fingerprints of the old version stay in that history. The limit findings that condition exit criteria were carried over here, ticket by ticket.

## Checkpoint — native Windows qualification (27 September 2026)

Native qualification campaign (Tauri app + webview, driven over CDP; evidence in
[`docs/evidence/2026-09-27-qualif-native/`](evidence/2026-09-27-qualif-native/)).

**Proved natively this campaign:** M0-01 two simultaneous projects · M0-02/03 host shutdown → honest
"Its process exited…" message + recovery in 7.6 s (root cause: dropped stdin) · M0-04
Stop → terminal with `turnId` + phases **before first token / late answer / after the end** +
"during a tool" variant (sub-agent lane in flight) · M1-05 PTY: defect isolated to
`portable-pty 0.9.0` · M1-06 Run in Muse chain proved + trigger fixed + spawn environment defect
isolated · M1-10 queue: clean two-turn race + **restore and resume
after `taskkill /F`** · M1-11 effective model per session + UI label defect · M2-03/07 worktrees
and sub-agent lanes + "Create & open" defect · M3-06/07 run without a click, native lease,
anti-duplicate claim, DST resolved · M3-08 run cards · M3-09 persisted notification.

**Open defects to fix (evidence attached):** shell sandbox unavailable for a host started
by the app (`m1-06-run-in-muse-sandbox.md`) · PTY with no output (`m1-05-pty-sortie-vide.md`) — **fixed** (portable-pty 0.8.1) · model
label shared between threads (`m1-11-bascule-modele.md`) — **fix implemented on 25/09** (`97f9eb1`), replay pending · worktree created but unused
(`m2-worktrees.md`) — **fix implemented on 25/09** (`97f9eb1`) · path comparison `G:\…` vs `\\?\G:\…` which makes any target on an
existing conversation impossible (`m3-automations-reveil.md`), **fixed on 22/09 with the terminal
cwd, to be replayed in-app** · "Review needed" never marked
after a restart — **fix implemented on 25/09** (`97f9eb1`, recovery re-applied after the native-ledger merge) · DST warnings absent — **implemented on 25/09** (`97f9eb1`, `resolveOnceTrigger` warns at creation) · button labels ("Stop the running sidecar" — **fixed on 25/09**,
`terminal.read-output` as content instead of role — no reproduction, still open).

**Still to qualify:** M0-05/07/11-14 (stale races, macOS/Linux support, CI, installs), remaining M1
(PTY in an interactive command, strict tool-during-tool, keyboard and attachments in the real UI,
packaged), remaining M2 (closing with active agents, Local↔Worktree, sub-agent fan-out), M3-01 to 05
(MCP, extensions, skills), real `AutomationWake` wake-up.

## Removals of 23 September 2026

Surfaces removed from the app, **code deleted** (front end and Rust). They delivered no verifiable user result and cluttered the side panel and the settings:

- **Content**: extractive thread summary and "artifacts" attachments (M4-05, artifacts side); its "Decisions" reused raw fragments.
- **Activity**: writer coordination and locks (M2-08), profiles and setup execution (M2-04), worktree inspection and cleanup from the UI (M2-06).
- **Manual desktop control** (window inventory, click, typing): computer use goes through the CUA driver, in Settings (M4-04).
- **Sharing and channels** (M4-06, already postponed) and **Remote/Cloud environments** with no transport (M4-07).
- **Settings with no effect**: "Check a path", "Web search", duplicate models in the composer.

What remains: Changes, Terminal, Files, Browser in the panel; Computer use and Memory in Settings; context usage next to the model picker, as in Claude Code. The ticket lines below describe the state before the removal.

## How to read this roadmap

### Three states, one criterion

| State | Meaning |
|---|---|
| ☐ **Not started** | No code, no interface, or a ticket deliberately postponed for lack of product specification. |
| ◐ **Started** | Code or an interface exists and is covered by tests, **but at least one exit criterion is unproven** on the platform concerned. |
| ☑ **Done** | Every exit criterion of the ticket is proved **on that precise platform**, with a reproducible proof. |

**Closing rule.** A ticket is only **Done** once the real effect is obtained, errors and recovery are handled, effective permissions are respected, the scenario has been validated natively **and** the limits are documented. An interface that exists, a green unit test or a host acknowledgement never suffice to close a ticket.

**Platform rule.** A ticket with no OS dependency is assessed once (merged `Global` columns). A ticket that depends on a native runtime is assessed **per OS**, and a favourable status on Windows says nothing about macOS or Linux.

### Platform conventions

- **Windows** — primary target. WebView2, x64 Muse sidecar and a native smoke test on two real hosts. Every existing native validation was produced here.
- **macOS** — announced target, **no native validation produced to date**.
- **Linux** — announced target and **the CI platform**. Careful: CI (`ubuntu-latest`) runs `npm test`, `npm run build` and `cargo test` — that is, the pure contracts and the Rust supervisor — but **launches no webview, no real Muse sidecar and no installer**. Green CI on Linux is not proof of Linux execution.
- **`n/a`** — the platform is not concerned by that ticket.

### Reading notes

- **"Wired" is not "Done".** Nearly every M0–M4 ticket has shipped code and unit tests; what blocks closure is almost always the **native proof**. That is why the dominant status is ◐ Started.
- **Execution of future tickets is still to be planned**: a ◐ state describes existing code, not work in progress.
- Dependencies are not cleared everywhere: `M1-01 → M1-02/03/04`, `M0-01 → M1-05/06/09/10`, `M2-03 → M2-04/05/06/08`, `M3-06/07 → M3-09`. An uncleared dependency forbids declaring its result delivered.

## Checkpoint — 20 September 2026

**Current reproducible measurements:** taken on **Windows** on 20 September 2026 at commit `064e210` — `npm test`: **829 Node tests, 193 suites, 0 failures** (11.0 s); `npm run build`: **green** (`tsc --noEmit` + Vite); `cargo test --manifest-path src-tauri/Cargo.toml`: **200 Rust tests, 0 failures**. CI runs both suites on `ubuntu-latest` with frontend and sidecar placeholders, with no credential and no model turn.

> **The Rust test count depends on the platform.** `scheduler_wakeup.rs` carries tests gated by `#[cfg(target_os = …)]` (Task Scheduler / `launchd` / `systemd`): at the same commit `064e210`, the Windows measurement gives **200** tests where earlier publications announced **194**. Do not compare a Rust total obtained under Linux with one obtained under Windows without saying so.
>
> To replay these measurements locally, two unversioned prerequisites are needed: `npm ci`, then a sidecar placeholder (Tauri validates every `externalBin` and `frontendDist` at build time) and a `dist/` produced by `npm run build`. The Rust tests run no sidecar.
>
> The Node totals, by contrast, are identical on all three OSes — but have only been run natively on Windows and Linux (CI).

**Native campaign of 20 September 2026 (group 1, driven by CUA then CDP):** [`docs/evidence/2026-09-20-windows-group1/`](evidence/2026-09-20-windows-group1/). First exercise of the Tauri application with the **native Windows Muse binary** as the sidecar, rather than the WSL bridge used until then: a complete live model turn in the webview, detection of host death (`Disconnected`, `Connection error` pill, sending blocked, transcript entirely preserved), explicit recovery failing cleanly on an `ephemeral` session, and text preserved with no host available.

**UI driving unblocked (round 3):** the UI Automation tree does not expose the webview's DOM and synthetic keyboard input does not reach it; the "from the webview" acceptance scenarios were therefore out of reach. Launching the development build with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` exposes a CDP endpoint, used by **`scripts/cdp-drive.mjs`** (inspection, filling, clicking on the real DOM) and **`scripts/cdp-scenario.mjs`** (bounded scenario, `--live` for a model turn). Development instrumentation only: it enables a WebView2 feature, it does not change the application's code. A first live scenario observed queue admission (`muse-desktop.queued-turns.v1`), the **Queued messages** panel ordered with its removal action, the **`Stopping…`** state, then the absence of a terminal and the switch to stale.

**No group 1 ticket is closed as a result** — the remaining criteria are listed in the evidence document.

**Campaign of 20 September 2026 — consolidated state (27 PRs merged, #154 to #180):** the native evidence is gathered under [`docs/evidence/`](evidence/), one folder per subject, and the sidecar contract is analysed in [`SIDECAR-CONTRACT-GAPS.md`](SIDECAR-CONTRACT-GAPS.md).

| Ticket | What is now measured | Deliverable |
|---|---|---|
| **M0-03** | **all 4 criteria of the ticket**: a rejected send (unknown skill) keeps the text · a double Enter admits only one turn (1 client identifier) · draft and in-flight send survive a reload · Enter during an IME composition **does not submit** | [#177](https://github.com/EtienneLescot/muse-desktop/pull/177) [#178](https://github.com/EtienneLescot/muse-desktop/pull/178) [#179](https://github.com/EtienneLescot/muse-desktop/pull/179) [#180](https://github.com/EtienneLescot/muse-desktop/pull/180) |
| **M0-10** | failure guidance exercised on a real case: sidecar neutralised → `sidecar`/`binary`/`triple`/`folder` panel with **Try again** and **Choose workspace folder**, no implicit install | [#172](https://github.com/EtienneLescot/muse-desktop/pull/172) |
| **M0-12** | `forced-colors` honoured (system colors on all 5 controls) · 24 tab stops with no trap · `Ctrl+F` bound to the finder · AA contrast on 60 texts · **one defect fixed**: the `prefers-contrast` rule was inert, with a regression test | [#162](https://github.com/EtienneLescot/muse-desktop/pull/162) [#163](https://github.com/EtienneLescot/muse-desktop/pull/163) [#165](https://github.com/EtienneLescot/muse-desktop/pull/165) |
| **M1-13** | DOM window bounded to **160 articles out of 2,001** · incremental loading of **120 entries** with a constant DOM · finder reaching a result **outside the window** · rendering cost measured (layout 12 ms, script 2.02 s, +160 KiB of heap) | [#166](https://github.com/EtienneLescot/muse-desktop/pull/166) [#167](https://github.com/EtienneLescot/muse-desktop/pull/167) [#169](https://github.com/EtienneLescot/muse-desktop/pull/169) [#170](https://github.com/EtienneLescot/muse-desktop/pull/170) |
| **M4-01 / M4-02** | native navigation, isolation by `sessionId`, annotation created, **context guard after navigation** proved | [#154](https://github.com/EtienneLescot/muse-desktop/pull/154) [#155](https://github.com/EtienneLescot/muse-desktop/pull/155) |
| **M4-09** | install, uninstall and **upward version update** performed with no loss: 64 conversations and 2 projects identical after each transaction | [#174](https://github.com/EtienneLescot/muse-desktop/pull/174) [#176](https://github.com/EtienneLescot/muse-desktop/pull/176) |
| **M0-01 / M0-14** | two simultaneous hosts · one host dying with no effect on the other · a turn carried to completion **while** the other host died, with no stale | [#158](https://github.com/EtienneLescot/muse-desktop/pull/158) [#159](https://github.com/EtienneLescot/muse-desktop/pull/159) |

**What still blocks, by nature:**

- **M1-06: DISPROVED on 21/09/2026.** The "host-side blocker" came from a probe that requested the capability in a shape the host reads as "no capability requested". With the right shape, sidecar 1.3.0 **does publish** the `userShell` items **and** their output. Detail and measurements in the M1-06 line below; **stop citing `SIDECAR-CONTRACT-GAPS.md` for this ticket.**
- **M0-04, M1-11: re-checked on 27/09/2026 — both "sidecar blockers" were false.** The host **does emit** a terminal notification (`turn/completed` at **+36 ms** after `turn/interrupt`) and **does report** model projections (`model_id` on the session, `is_active` on `model/list`); the measurement backing them shared the `--no-session-log` harness of M1-06 (see [`session-log-expique-tout.md`](evidence/2026-09-27-qualif-native/session-log-expique-tout.md)). **Only `outputRef` stays plausible** in [`SIDECAR-CONTRACT-GAPS.md`](SIDECAR-CONTRACT-GAPS.md). M0-04 keeps its special stop phases to qualify — on the scenario side, not the host side.
- **Revision of 27/09/2026:** M0-02 and M0-03 **closed on Windows** (evidence: [`m0-02-reprise-apres-mort-host.md`](evidence/2026-09-27-qualif-native/m0-02-reprise-apres-mort-host.md), [`M0-03-texte-en-rejet-conserve.md`](evidence/2026-09-20-windows-group1/M0-03-texte-en-rejet-conserve.md)); M0-04 **advanced to proof of the transmitted `turnId` and resolution in ~1 s** ([`m0-04-stop-terminal.md`](evidence/2026-09-27-qualif-native/m0-04-stop-terminal.md)).
- **M0-01**: the "concurrent approvals" criterion stays open — the host ceiling is `promptUnmatched` and no approval request could be provoked, even in `ask` mode.
- **M0-10, M4-09**: the "clean machine" is not covered — the test machine already has WSL, Muse and 64 conversations. Installer signing is also absent (`NotSigned`).
- **M0-12, M1-13**: qualification with a **real screen reader** has not been done; the roles and labels observed are a necessary condition, not proof of correct announcement.
- **M4-01, M4-02**: **macOS and Linux** qualification does not exist.
- **M0-11, M1-10**: partial.

**Three campaign errors, corrected and kept on record**: a false positive on the focus indicator (measured on the field instead of the container), an erroneous diagnosis on `prefers-contrast` (specificity instead of declaration order, with a fix withdrawn then validated differently), and a confusion over transcript entry order that had produced a worthless "success". The documents concerned keep both versions.

**Built-in browser evidence (20/09/2026):** [`docs/evidence/2026-09-20-windows-browser/`](evidence/2026-09-20-windows-browser/M4-01-M4-02.md). The work bar tabs only exist in the DOM once the side panel is unfolded — a point that had led to the wrong conclusion that they were inaccessible. On an open conversation, the seven tabs **Content · Review · Terminal · Files · Browser · Desktop · Memory** are present. In **M4-01**, native navigation is proved in the webview: `<input type="url">`, `iframe` mounted on `https://example.com/`, per-tab persistence and **isolation by `sessionId`** (two distinct `browser.tabs.v1.session.*` keys). In **M4-02**, the three annotation fields are present, an **annotation was actually created** (normalised URL anchor, selection quote, comment, identifier and timestamp persisted), and the **context guard after navigation is proved**: after moving the tab to another domain, notes anchored to the first page stop being shown (2 → 0) while staying persisted with their original anchor. Region cropping and visual capture stay open for M4-02.

**Latest native evidence (Windows, 19–20 September 2026):** two real Muse Code 1.3.0 sidecars, two distinct sessions and workspaces; smoke `--exercise-control --exercise-errors --exercise-approval --exercise-isolation --exercise-user-shell --exercise-reconnect --exercise-history --exercise-reasoning --exercise-model --exercise-queue --exercise-compaction` passed; native dogfood of 20/09 on the direct MCP bridge (Tab path, typing, Ctrl+F, native zoom Ctrl+0 then Ctrl+Plus ×2).

**Known platform limits:**

- The Muse 1.3.0 host observed stays **`ephemeral`**: `session/read` and `view/page` answer `methodNotFound`, so durable resume and native reconciliation stay undemonstrated, on any OS. **Correction (20/09/2026):** `approval/listPending` **is** available as soon as it is given a `sessionId` and returns `{approvals, userInputs}` — it is a call without a `sessionId` that produces `methodNotFound`. Earlier mentions classifying it as absent must be re-read; see [`msp-probe.mjs`](../scripts/msp-probe.mjs) and the [campaign report](evidence/2026-09-20-windows-group1/).
- **No native macOS or Linux evidence** exists in this repository to date, for any ticket.
- Desktop control (`desktop_control.rs`) is implemented on **Windows** (Win32/UIA) and **macOS** (Accessibility through System Events, `desktop_control_macos.rs`); Linux explicitly returns `supported: false`. macOS port (build `scripts/build-macos.sh`, engine not bundled: Muse CLI install driven by the app on first launch through the official installer, native title bar, login shell PATH, native startup probe, cua-driver endpoint over a Unix socket, launchd wake-up through LaunchServices): code shipped and unit-tested, **native proof of real use still to be produced**.
- **`turn/completed`, `turn/retracted` and `turn/stopped` are never emitted**, even after `turn/interrupt` or a user `Stop`: a turn's final state is **inferred** on the client side, never received. Observed on two real hosts and from the interface.

**Next pickup:** the native M0 evidence on Windows is well advanced (see the consolidated table above). What remains depends on three kinds of work:

1. **Sidecar side** — **no measured blocker left** (revision of 27/09/2026). The turn terminal notification exists (`turn/completed` at +36 ms), model projections exist, `session/read`/`session/resume` resume works. Only `outputRef` stays to be confirmed in [`SIDECAR-CONTRACT-GAPS.md`](SIDECAR-CONTRACT-GAPS.md). The methodological lesson stands: measure with the contract's shapes (nested `capabilities`, a host with a session log), otherwise you manufacture fictional blockers.
2. **Infrastructure side** — a clean machine for M0-10 and M4-09, Authenticode signing of the installers, update channel hosting, macOS and Linux VMs for M4-01/M4-02.
3. **Method side** — qualification with a real screen reader for M0-12 and M1-13; completing the variants of scenarios already covered (Chinese and Korean IME, reload before acknowledgement, mouse double-click for M0-03; the remaining M0-04 stop phases: before first token, during a tool, after the end, late answer; named services and locks for M1-05 and M2-08); remaining M0 and M1 in native Windows qualification (tooled scenarios: `cdp-concurrent-turns`, `cdp-queue-race`, `cdp-ab-projects`, `cdp-stop-terminal`).

The remaining criteria and their precise limits are listed in each document under [`docs/evidence/`](evidence/): none of this campaign's documents declares a ticket closed on a single scenario.

## Summary

### By state

| State | Total | Breakdown |
|---|---|---|
| ☐ Not started | **1** | M4-06 |
| ◐ Started | **36** | everything else |
| ☑ Done | **16** | **M0**: M0-01, M0-02, M0-03, M0-04, M0-09, M0-11 · **M1**: M1-01, M1-02, M1-03, M1-05, M1-06, M1-07, M1-08, M1-10, M1-11 · M1-12 |
| **Total** | **53** | |

Each ticket is counted at its best state across OSes (the `Global`-column convention below; a ticket whose `Global` cell reads `—` counts at its best per-OS column). Sixteen tickets are closed on at least one platform — all of them on Windows, 20–27/09 and 25–26/09 (M0 campaign) and 26/09 (M1 campaign); their macOS/Linux columns stay ◐/☐ for lack of native proof there. M1-04, M1-09 and M1-13 remain ◐ on Windows with precisely stated remainders (a live PR round trip needing a disposable GitHub remote; a host-blocked fork creation; the assistive half of M1-13).

### By platform

The 53 tickets fall into three groups, counted from the tables below.

| Group | Tickets | ☐ | ◐ | ☑ |
|---|---|---|---|---|
| **A** — no OS dependency (`Global` column filled) | 34 | 1 | 22 | 11 |
| **B** — dependent on a native runtime (`Global` = `—`) | 18 | 0 | 14 | 4 |
| **C** — M1-12, closed and identical on all three OSes | 1 | 0 | 0 | 1 |
| **Total** | **53** | **1** | **36** | **16** |

Group B is the only one carrying **different** code per platform: that is where the per-OS distinction really changes the answer. (Since 26/09/2026: M0-01, M1-06, M1-10 and M1-11 are ☑ on Windows — every Windows-reachable criterion of those tickets is proved; the other 14 stay ◐ on Windows.)

Exact breakdown of the 18 group B tickets (since 26/09/2026: 4 are ☑ on Windows — M0-01, M1-06, M1-10, M1-11 — the other 14 ◐; all ☐ on macOS and Linux):

- **M0** (5): M0-01, M0-05, M0-06, M0-08, M0-10
- **M1** (4): M1-06, M1-09, M1-10, M1-11
- **M2** (3): M2-02, M2-05, M2-07
- **M3** (1): M3-05
- **M4** (5): M4-01, M4-02, M4-03, M4-04, M4-09

The 18 group B tickets are therefore the only ones whose closure is **reachable in the short term on Windows**: their code exists and the native proof chain is already tooled there (`smoke:native`, NSIS/MSI bundles, dogfood). Outside Windows, none of them is started.

Conversely, **16 group A tickets show ◐ on macOS and Linux although the code is shared and not platform-specific**: M0-02, M0-03, M0-09, M1-01, M1-02, M1-03, M1-04, M1-05, M1-07, M1-08, M1-13, M3-01, M3-03, M3-04, M3-08, M4-07. For those, the ◐ outside Windows reflects **the absence of native proof**, not a code defect: they are mechanically cheaper to close than group B.

Among the group A tickets, **six** stay ☐ on macOS and Linux instead of ◐: **M0-04**, **M1-06**, **M1-10**, **M1-11**, **M3-02** and **M4-06**. The first four carry a real OS dependency despite a favourable `Global` column — the terminal proof depends on host behaviour for M0-04, and M1-06/M1-10/M1-11's Windows proofs lean on the bundled-engine Windows host — while M4-06 is postponed for lack of a product specification. Every other group A ticket is simply waiting for native proof on code that is already shared.

> **Convention for the `Global` column:** it carries the ticket's state considered independently of the OS, that is, **the best state reached**. It does not claim the three platforms are level — only the per-OS columns do that. For the summary counts above, a ticket whose `Global` cell reads `—` (a per-OS ticket) is counted at its best per-OS column.

---

## M0 — Make the existing solid and finish it

*Immediate priority. Do not add new surfaces before securing these paths.*

| ID | Expected result | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M0-01 | A keeps working when project B is opened | — | ☑ | ☐ | ☐ |
| M0-02 | Resume a conversation after the engine closes or crashes | ☑ | ☑ | ◐ | ◐ |
| M0-03 | Lose no text on a rejected send | ☑ | ☑ | ◐ | ◐ |
| M0-04 | Stop and resume with reliable states | ☑ | ☑ | ☐ | ☐ |
| M0-05 | Answer permissions and questions even after an incident | — | ◐ | ☐ | ☐ |
| M0-06 | Show the permission policy that is really in force | — | ◐ | ☐ | ☐ |
| M0-07 | Protect diagnostics and avoid a crash on Unicode | — | ◐ | ◐ | ◐ |
| M0-08 | Detect an engine incompatibility | — | ◐ | ☐ | ☐ |
| M0-09 | Keep data with no silent failure | ☑ | ☑ | ◐ | ◐ |
| M0-10 | Succeed on first launch | — | ◐ | ☐ | ☐ |
| M0-11 | Finish the English and the navigation details | ☑ | ☑ | ◐ | ◐ |
| M0-12 | Use what exists by keyboard and screen reader | — | ◐ | ◐ | ◐ |
| M0-13 | Clearly identify capabilities that are not connected | — | ◐ | ◐ | ◐ |
| M0-14 | Have reproducible checks before merging | — | ◐ | ◐ | ◐ |

### Detail

- ☑ **M0-01 — A keeps working when project B is opened** *(Global: —)* — **Windows closed on 26/09/2026.**
  - Windows ☑ — routing isolated by canonical path, explicit session ownership, approval isolation; proved with two real child processes (Rust + Node) with a sudden death of B and completion of A (20/09, 27/09); fresh-session concurrent turns (25/09, [m0-01-ab-fresh-sessions.json](evidence/2026-09-25-m0-completion/m0-01-ab-fresh-sessions.json)); and the **packaged NSIS webview** repetition ([m0-packaged-webview.json](evidence/2026-09-25-m0-completion/m0-packaged-webview.json), 26/09: turn A in project `muse-desktop`, turn B concurrently in openscreen, both completed, isolation intact). No Windows criterion of this ticket remains open.
  - **Native progress (20/09/2026, CUA then CDP):** two simultaneous hosts observed; host B's death **with no effect** on the application, the conversation served by A, the 58 sessions or the queue (no respawn, application still `Responding`). Then, on the surviving host: **new session created (58 → 59), real turn admitted, conversation still connected, sub-agents moved from 1 to 3 `Completed`**.
- **Fresh-session repetition PASSED on 25/09/2026** ([campaign 2026-09-25](evidence/2026-09-25-m0-completion/README.md)): two fresh sessions in two workspaces (project `muse-desktop` + openscreen) each completed a live turn with transcripts intact and no cross-talk (correction on review, 26/09: in this dev run A completed at 23:54:54, **before** B started at 23:55:28 — the two turns did not overlap here; the concurrent-completion proof is the packaged repetition below, and the record's verdict was corrected accordingly). **Remaining:** macOS/Linux.
  - **Missing criterion of 20/09 PROVED on 27/09/2026** ([`m0-01-deux-projets.md`](evidence/2026-09-27-qualif-native/m0-01-deux-projets.md)): concurrent long turns in both projects → B's host killed at 15:37:24 mid-turn → **turn A finished at 15:38:10 with no error**, honest status for B to the second. Both repetitions proved on 25–26/09/2026: fresh sessions (25/09) and the packaged NSIS webview (26/09).
  - macOS ☐ / Linux ☐ — multi-OS qualification not started. The webview is not WebView2 outside Windows.
  - *Exit criterion:* isolation proved from the packaged Tauri interface, on every announced OS. **✓ Windows (26/09); macOS/Linux remain ☐.**

- ◐ **M0-02 — Resume a conversation after a close or a crash** *(no OS dimension)* — **reopened on 27/09/2026:** `taskkill /F` + relaunch can **wipe `projects.v1` and `sessions.v1`** (every conversation) while the queue, runs and notifications survive — whereas an identical kill earlier had preserved everything ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)); survival of the queue and runs is proved ([`m1-10-course-de-file.md`](evidence/2026-09-27-qualif-native/m1-10-course-de-file.md)), that of projects and threads in every kill mode is not. **Cause found in the code:** `useMuseSessions.ts` L1875 + L2361-2383 — `useState(() => loadProjects())` with a `[]` fallback on an invalid read, then a **write-through `useEffect` that persists `[]` at mount**: transient corruption → permanent erasure. Suggested fix: no write at mount / never persist a fallback from an invalid read. **→ Fix implemented on 27/09/2026:** `sessionsHydratedRef`/`projectsHydratedRef` guards in `useMuseSessions.ts` — hydrated state (possibly the fallback) is **never** persisted, only mutations (a new array identity) write (`npm test` 1133/1133 + `tsc` green); the kill still has to be **replayed** to prove the corrected behaviour. **→ FIX CONFIRMED by replay on 27/09/2026:** the corrupted value `not-json-M02c` survives reloads (+2 s, +10 s) on the fixed build — where the old build replaced it with `"[]"` in < 1 s ([`m0-02-fix-write-through.md`](evidence/2026-09-27-qualif-native/m0-02-fix-write-through.md), which also documents the embedded-frontend trap and the **host's redemption**: 59 threads rebuilt from its history). State: the "crash" and "erasure" pieces are handled; the real `taskkill /F` test under varied conditions remains for full closure. **→ Real `taskkill /F` mid-turn PASSED on 27/09/2026:** brutal kill at +3 s into a turn → projects **172 bytes byte for byte** + threads **13,557 → 13,578 bytes (59 → 61, valid JSON)** + 36 keys intact — no corruption, no loss. Every piece of the acceptance is proved (unsent = queue proved by M1-10, per-thread history = this test, no second host = immediate stop and relaunch) — only the composer's **draft** is left to test directly. **→ Draft tested on 27/09/2026: DEFECT, not preserved** — typed without sending, lost on `taskkill /F`, no storage key carries it (React state only); a missing piece for closure ([`m0-02-fix-write-through.md`](evidence/2026-09-27-qualif-native/m0-02-fix-write-through.md)). **→ FIX implemented on 25/09/2026** (`97f9eb1`): the composer draft now persists in **durable** localStorage (the sessionStorage key died with the webview), written per keystroke. **→ KILL REPLAY PASSED on 25/09/2026** ([campaign 2026-09-25](evidence/2026-09-25-m0-completion/README.md)): draft `M0-02-DRAFT-DOIT-SURVIVRE-AU-KILL-25SEP` survived `taskkill /F` + relaunch and the composer restored it exactly — the last open Windows piece of M0-02 is closed.
  - Explicit reconnection through `session/read` + `session/resume`, per-conversation connection state (`disconnected / connecting / connected / error`), rehydration of folded items by `itemId`, visible liveness with a stale state, bounded reconciliation after 15 s of silence, `view/page` fallback by cursor, paginated `session/list`, **Muse is resuming** bridge, **Sync now** button, detection of event ring loss.
  - **Proved on 27/09/2026 on Windows** ([`m0-02-reprise-apres-mort-host.md`](evidence/2026-09-27-qualif-native/m0-02-reprise-apres-mort-host.md)): host death while running → honest status "Muse stopped because the host process ended. Reconnect to continue." → `resume_session` on a relaunched host (`loaded: true`, grants, model) → **full history read back** (`read_session_history`) → **new turn executed**. All three criteria of the ticket are covered.
  - **Note of 27/09:** the old "blocking remainder" ("the sidecar is `ephemeral` and does not serve `session/read`/`session/resume`") was **false** — measured with a `--no-session-log` host (memory only). See [`session-log-expique-tout.md`](evidence/2026-09-27-qualif-native/session-log-expique-tout.md).
  - macOS ◐ / Linux ◐ — shared code, no native proof on those platforms.
  - *Exit criterion:* a turn's resume actually replayed against a durable host. **✓ done on Windows (27/09).**

- ☑ **M0-03 — Lose no text on a rejected send** *(no OS dimension)*
  - Durable per-send outbox (`clientMessageId`, `sending/accepted/failed`), draft cleared only on acknowledgement, server check before retransmission, native mirror under `app_data/outbox/`, sidebar flagging preserved sends.
  - **Proved on 20/09/2026 on Windows** for all 4 criteria ([`M0-03-texte-en-rejet-conserve.md`](evidence/2026-09-20-windows-group1/M0-03-texte-en-rejet-conserve.md)): a rejected send (unknown skill) keeps the text · a double Enter admits only one turn · draft and in-flight send survive a reload · Enter during an IME composition does not submit.
  - **Remaining (non-blocking):** method variants — engine cut mid-send, mouse double-click, Chinese and Korean IME (§Method); macOS/Linux proof.
  - *Exit criterion:* no text lost across the ticket's four scenarios. **✓ done on Windows (20/09).**

- ◐ **M0-04 — Stop and resume with reliable states**
  - Windows ◐ — distinction between an accepted request (`Stopping Muse`) and a confirmed terminal, `turnId` transmitted, `turn/completed|retracted|stopped` aliases, bounded recovery after an acknowledgement with no terminal, double-click ignored.
  - **Decisive progress (27/09/2026, native proof):** [`m0-04-stop-terminal.md`](evidence/2026-09-27-qualif-native/m0-04-stop-terminal.md) — Stop clicked from the webview → `cancel_session` with a **non-empty, correct `turnId`** → state resolved in **1 s** (server terminal) → **immediate relaunch**. The sentence "host 1.3.x emits no terminal after `turn/interrupt`" is **false** (`turn/completed` at +36 ms, proved) and the old frozen "Stopping…" does not reproduce at HEAD.
  - **Strict variant CLOSED on 26/09/2026** ([m0-04-strict-tool-stop.json](evidence/2026-09-25-m0-completion/m0-04-strict-tool-stop.json)): under the product's `elevated` sandbox posture the model's shell tool executes, and Stop pressed mid-tool (at +54.5 s of a 90 s ping) sent `cancel_session` carrying **sessionId + turnId**, the tool was cancelled and the UI resolved cleanly (the no-text-first degenerate case sends the by-design turnId-less fallback and also resolves honestly). **No Windows criterion of this ticket remains open.** **Variant measured on 27/09/2026:** stopping during a **"Running" sub-agent lane** (tool work in flight in the child session) — `cancel_session`+`turnId`, turn resolved, lanes closed. **Phases closed** ([`m0-04-stop-terminal.md`](evidence/2026-09-27-qualif-native/m0-04-stop-terminal.md)): **before the first token** (stop at +1.5 s pre-output, `turnId` transmitted, resolution 1.0 s, immediate relaunch), **late answer** (stop at +45 s on a live turn, same), **after the end** (no Stop button left, UI at rest, next turn immediate). The "accepted request / confirmed terminal" distinction is proved with its exact label (`Stopping Muse…` captured live, resolution in 1.0 s). **Remaining label defect:** the turn's Stop button carries the title `Stop the running sidecar`. **→ FIXED on 25/09/2026** (`97f9eb1`): the title now reads `Stop the current turn`; the `cdp-stop-terminal` harness keeps the old title as a fallback selector. **→ Full stop scenario re-PASSED on 25/09/2026** on the fixed build: `turnId` on the wire, `cancel_session` 2/2 with turnId, resolution **1 023 ms**, immediate follow-up.
  - **Packaged webview re-PASS on 26/09/2026** ([cdp-stop-terminal-packaged-run5.json](evidence/2026-09-25-m0-completion/cdp-stop-terminal-packaged-run5.json)): NSIS-installed 0.1.0 app — single `cancel_session` at +3.6 s **carrying the correct `turnId`**, `Stopping…` resolved in **1 009 ms**, immediate follow-up accepted, Stop title "Stop the current turn". With the strict tool-during-tool variant proved the same day under the elevated posture ([m0-04-strict-tool-stop.json](evidence/2026-09-25-m0-completion/m0-04-strict-tool-stop.json), correction on review: it is **not** host-blocked — the sandbox was the blocker, and the elevated posture removes it), **no Windows criterion of this ticket remains open — Windows ☑ (26/09)**. The underlying host defect (the model's shell tool hangs under the sandbox — Draft 2 in [docs/upstream](upstream/muse-host-1.3.0-m0-blockers.md)) is worked around, not fixed, and stays tracked upstream.
  - macOS ☐ / Linux ☐ — not started.

- ◐ **M0-05 — Answer permissions and questions even after an incident**
  - Windows ◐ — `list_pending_requests` re-reads `approval/listPending` and rebuilds the cards per session, deduplication by identifier, a refusal painting no false resume state, stale switch with actions. **Remaining:** native validation of stale races. Sidecar 1.3.0 does not serve `approval/listPending`. **Strengthened on 26/09/2026** ([m0-05-elevated-attempt.json](evidence/2026-09-25-m0-completion/m0-05-elevated-attempt.json)): with `elevated` sandbox the tools **execute** and still no approval card is raised in ask posture — the host raises no approval prompts at all, sandbox-independent. **→ Bounded attempt on 25/09/2026** ([m0-05-approval-attempt.json](evidence/2026-09-25-m0-completion/m0-05-approval-attempt.json)): in persisted ask posture, a live turn demanding a self-run shell command rendered the tool lane but **no approval card was provokable** (host ceiling `promptUnmatched`; shell tool sandbox-blocked) — the stale race stays host-blocked, status not raised.
  - macOS ☐ / Linux ☐ — not started.

- ◐ **M0-06 — Show the permission policy that is really in force**
  - Windows ◐ — global Ask / Approve on my behalf / YOLO picker, mapping onto the MSP enum, persistence, `session/setApprovalMode`, distinction between local posture and host ceiling. Contract verified on the 1.3.0 binary: `promptUnmatched` accepted, `approval_mode_ceiling` for `onRequest` and `allowAll`.
  - macOS ☐ / Linux ☐ — the reference binary tested is Windows/WSL; the matrix of older versions and the other OSes remain to be qualified.
  - **Native PASS on 25/09/2026** ([m0-06-posture.json](evidence/2026-09-25-m0-completion/m0-06-posture.json)): posture change YOLO→Ask propagated to **all 10 connected sessions without restart** (`set_approval_mode:ask` ×10 on the wire) and **persisted across a `taskkill /F` + relaunch**. **Remaining:** only the refused/stale decision replay (same host ceiling as M0-05).
  - *Exit criterion:* posture change without a restart, preserved after relaunch, native test of the refused/stale decision.

- ◐ **M0-07 — Protect diagnostics and avoid a crash on Unicode**
  - Windows ◐ / macOS ◐ / Linux ◐ — the code is **shared** (renderer + bridge): no raw wire log by default, stderr bounded to 20 lines / 8,000 characters, secrets masked, UTF-8-safe truncation, `collect_diagnostics`, bounded Settings export, structured MSP terminal errors.
  - **Native qualification advanced on Windows 25/09/2026** ([campaign 2026-09-25](evidence/2026-09-25-m0-completion/README.md)): a structured, actionable engine error was exercised natively (`unknown skill /definitelynotaskill … install or enable it first` — text preserved, no crash, no raw wire dump), plus the honest host-death statuses of 27/09 and the incompatible-engine handling of M0-08 below — the engine error was **mirrored in the packaged NSIS webview on 26/09/2026** ([cdp-unknown-skill-reject-packaged-run1.json](evidence/2026-09-25-m0-completion/cdp-unknown-skill-reject-packaged-run1.json)). **Remaining:** the same proofs on macOS/Linux.

- ◐ **M0-08 — Detect an engine incompatibility**
  - Windows ◐ — handshake requiring `serverInfo`, version, `schema.version=1` and a `sha256:*` fingerprint; compile-time registry of the RPCs emitted; actionable error at startup. Windows/WSL 1.3.0 binary validated.
  - **Incompatible-engine campaign 25–26/09/2026** ([m0-08-incompatible-engine.json](evidence/2026-09-25-m0-completion/m0-08-incompatible-engine.json)): with engines that do not speak MSP (`cmd.exe`, `hostname.exe`), the app never crashed, detection was bounded ("Connecting" → "Disconnected" ≤ ~90 s) and Reconnect was offered — but the supervisor's actionable reason reached only the console. **Fix shipped:** `connectionNoticeBySession` — the silent boot resume now records a bounded per-conversation reason and the connection pill carries it as a tooltip (validated natively: pill title = `"MSP handshake failed (sidecar dropped the response). Host stderr: "`; real engine restored → "Connected", notice cleared). **Remaining:** engine-version matrix; macOS/Linux.

- ☑ **M0-09 — Keep data with no silent failure** *(no OS dimension)* — **Windows closed on 26/09/2026.**
  - Defensive facade over every known persistence module, corruption/quota reporting, selective export/import with a preview, durable/UI classification, FNV-1a checksum verified before restore, migration of the `muse.*` aliases, defensive `sessionStorage` drafts.
  - **Native corruption sweep PASSED on 25/09/2026** ([m0-09-corruption-sweep.json](evidence/2026-09-25-m0-completion/m0-09-corruption-sweep.json)): 9 persistence keys corrupted then reloaded — no crash; `projects.v1` corrupted value never overwritten; `sessions.v1` rebuilt from the host's durable history; `schedule-runs.v1` from the native ledger; Settings rendered the "Local data needs attention / Corrupted data (…)" report natively. **Documented limit:** localStorage-only join tables (`thread-projects.v1`, `connectors.v1`, `memory.v1`) reset to `[]` on the first post-boot mutation. **Recovery round-trip PASSED on 26/09/2026** ([m0-09-recovery-roundtrip.json](evidence/2026-09-25-m0-completion/m0-09-recovery-roundtrip.json)): native export (107 entries, FNV-1a checksum) -> selective import through the recovery preview -> checksum-verified restore over a damaged value. **External formats and alias migration PROVED on 26/09/2026** ([m0-09-external-import-migration.json](evidence/2026-09-25-m0-completion/m0-09-external-import-migration.json)): a CLI-style JSON config imported through the Library panel (both sessions stored), the legacy `muse.workspace` alias migrated into the current namespace without overwrite, and a hand-built snapshot with a wrong FNV-1a checksum rejected natively ("checksum mismatch; the file may be damaged"). **Every Windows criterion of this ticket is proved; remaining: macOS/Linux.**

- ◐ **M0-10 — Succeed on first launch**
  - Windows ◐ — contextual guidance (sidecar, WSL, Muse CLI, authentication, folder), bounded `probe_startup` probe shown in recovery and in Settings, states readable without colour, UTF-16 output decoded, `dev:clean:windows` bounded to the checkout.
  - **Remaining (Windows):** detection on a clean machine, non-default WSL distributions, a real authentication path. **Prerequisite discovered on 27/09/2026:** `muse sandbox windows setup` (elevated) must be run before any shell — otherwise `sandbox_users_missing` and every `userShell` fails; to fold into the first-launch guidance ([`m1-06-run-in-muse-sandbox.md`](evidence/2026-09-27-qualif-native/m1-06-run-in-muse-sandbox.md)).
  - macOS ☐ / Linux ☐ — the probe and the guidance are specific to the Windows/WSL sidecar chain; a native equivalent is still to be written.

- ☑ **M0-11 — Finish the English and the navigation details** *(no OS dimension)* — **closed 26/09/2026.**
  - Residual labels harmonised, search independent of the French locale, `Ctrl`/`Cmd` tooltips through `primaryModifier()`, centralised error copy `userFacingError`, readable native path `displayPath`, zoom tooltip documented and verified in dogfood on 20/09.
  - **Native audit run on 25/09/2026** ([cdp-language-audit-run1.json](evidence/2026-09-25-m0-completion/cdp-language-audit-run1.json)): UI chrome English on the live app; the French hits are user-typed conversation titles (content, not labels). **Packaged checklist PASSED on 26/09/2026** ([cdp-language-audit-packaged-run2.json](evidence/2026-09-25-m0-completion/cdp-language-audit-packaged-run2.json)): the same audit in the NSIS-installed webview on the 6 surfaces it reached (home, new conversation, automations, extensions, library, search) — chrome English, French hits are user content only. Correction on review: the audit harness did not open a conversation (`conversation-NOT-OPENED`, `back.opened: false` in both runs), so that surface's systematic audit stays open as coverage follow-up; packaged conversation chrome is nevertheless evidenced English by the stop and A/B runs on the same install (Stop title "Stop the current turn", "Muse is working", "Enter to send"). Every status criterion of this ticket is proved natively; the Stop-button label defect was fixed and re-proved the same campaign.

- ◐ **M0-12 — Use what exists by keyboard and screen reader**
  - Windows ◐ — Tab path validated in dogfood (logical order, focus ring, Enter activation Summary→Content), typing delivered, Ctrl+F correctly ignored inside an input, native zoom verified through `zoomHotkeysEnabled`, forced contrast `Highlight`/`ButtonText`/`LinkText`.
  - macOS ◐ / Linux ◐ — the accessibility code is shared, but `forced-colors` is a Windows mechanism and **no** assistive proof exists outside Windows.
  - **Remaining:** a real screen reader, native contrast, a complete mouse-free path — on all three OSes.

- ◐ **M0-13 — Clearly identify capabilities that are not connected** *(no OS dimension)*
  - Shared vocabulary `Available` / `Local` / `Manual` / `Not connected` with a reason and a next step, badges on connectors, channels, exports, worktrees, index, CLI/IDE import, Browser and Desktop control.
  - **Native capture on 25/09/2026** ([m0-13-capability-badges.json](evidence/2026-09-25-m0-completion/m0-13-capability-badges.json)): the shared vocabulary renders natively ("Granted … only through the granted tools", "Observe only … 19 tools", "Local"). **Remaining:** the host-announced consent replay; macOS/Linux.

- ◐ **M0-14 — Have reproducible checks before merging**
  - Linux ◐ — the **only** platform where an automated check runs: CI on `ubuntu-latest` with `npm ci`, `npm test`, `npm run build`, `cargo test` (Linux Tauri dependencies installed, frontend and sidecar placeholders), bounded and masked failure artefacts. MCP and Muse MSP fixtures shipped, `pump_stdout` validated on a real child process (`powershell.exe` on Windows, `sh` elsewhere).
  - Windows ◐ — opt-in native smoke `npm run smoke:native` on two real sidecars, outside CI.
  - macOS ☐ — nothing.
  - **A/B scenario from the Tauri interface PASSED on 25/09/2026** ([m0-01-ab-fresh-sessions.json](evidence/2026-09-25-m0-completion/m0-01-ab-fresh-sessions.json)) — two fresh sessions, concurrent live turns, isolation intact — and **re-passed in the packaged NSIS webview on 26/09/2026** ([m0-packaged-webview.json](evidence/2026-09-25-m0-completion/m0-packaged-webview.json)). macOS ☐ still nothing.

**🚦 M0 exit:** a native scenario create → send → stream → approve → answer → interrupt → retry, then a restart and two simultaneous projects. No setting claims to change a capability it does not control. **Windows validation first; macOS/Linux support qualified separately.**

---

## M1 — Finish the daily development workflow

*The `design/prototype` mockup is not a native implementation. Error contracts and destructive operations still have to be designed even where a screen exists.*

| ID | Expected result | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M1-01 | See the files actually changed | ☑ | ☑ | ◐ | ◐ |
| M1-02 | Comment a diff line and ask for a fix | ☑ | ☑ | ◐ | ◐ |
| M1-03 | Stage or discard a change | ☑ | ☑ | ◐ | ◐ |
| M1-04 | Sync, commit, push and create a PR | ◐ | ◐ | ◐ | ◐ |
| M1-05 | Open and use a terminal in the project | ☑ | ☑ | ◐ | ◐ |
| M1-06 | Have the engine read the terminal output | ☑ | ☑ | ☐ | ☐ |
| M1-07 | Browse the project's real files | ☑ | ☑ | ◐ | ◐ |
| M1-08 | Add files and images to a request | ☑ | ☑ | ◐ | ◐ |
| M1-09 | Create a faithful conversation branch | — | ◐ | ☐ | ☐ |
| M1-10 | Redirect an execution or queue it | ☑ | ☑ | ☐ | ☐ |
| M1-11 | Pick an available model and follow the context | ☑ | ☑ | ☐ | ☐ |
| M1-12 | Find and organise conversations | ☑ | ☑ | ☑ | ☑ |
| M1-13 | Read a long conversation comfortably | ◐ | ◐ | ◐ | ◐ |

### Detail

- ◐ **M1-01 → M1-04 — Git review and delivery** *(shared code, native proofs missing)*
  - ◐ M1-01 — Git baseline captured before each turn with a bounded delay, HEAD/fingerprint/path comparison without reading Muse's text; lazy listing, bounded reading, native watcher, text handoff into the prompt, CSV/TSV/JSON tables. **Windows ☑ (26/09/2026, [campaign](evidence/2026-09-26-m1-closure/README.md)):** the last-turn snapshot lists the files changed during a controlled live turn, the office file shows git's binary marker in the diff view, and an 802-row status renders with the true count. **Remaining:** macOS/Linux only.
  - ◐ M1-02 — bounded persistent multi-comment queue (40 entries, 8,000 characters), a freshness guard refusing a moved anchor, `stale` anchors never moved silently. **Windows ☑ (26/09/2026):** a diff-line comment reaches the live engine (turn starts, answer streams); a queued comment persists with `ready`/`sent` states. **Remaining:** macOS/Linux only.
  - ◐ M1-03 — stage/unstage/discard by file and by hunk, multiple selection, HEAD/status/patch guard before writing, untracked files never deleted. **Windows ☑ (26/09/2026):** stage/unstage verified in porcelain (`M `/` M`), partial hunk staging leaves 1+1 hunks, discard reverts after the inline confirm, untracked files survive. **Remaining:** macOS/Linux only.
  - ◐ M1-04 — commit, push with an explicit refspec, idempotent PR through `gh`, **Fetch** and **Pull latest** as `--ff-only`. **Windows progress (26/09/2026):** commit, push (`refs/heads/master` on a bare remote), Fetch of a remote advance and **Pull latest fast-forwarding HEAD** (`60406fc4 → 8a15aaa8`) all proved in the real webview with git-verified outcomes; a forbidden remote surfaces a clean actionable error (`Repository not found`) — the live remote-rejection piece. **Remaining (Windows):** the live PR round trip through `gh` needs a disposable GitHub remote; plus macOS/Linux.
  - *Note:* these four tickets are **Git/OS-agnostic** in their logic, but no native proof exists outside Windows — the macOS/Linux column reflects that absence, not a code defect.

- ◐ **M1-05 — Open and use a terminal in the project** *(Global: —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — persistent Rust PTY registry through `portable-pty`, shell bound to the conversation's cwd, output bounded to 200,000 characters, resize, controlled close, ANSI SGR 16/256/24-bit rendering, Ctrl+C/Ctrl+D/Ctrl+L/Tab/Escape shortcuts. The PTY survives a tab change because the supervisor owns it.
  - **Major defect measured on 27/09/2026** ([`m1-05-pty-sortie-vide.md`](evidence/2026-09-27-qualif-native/m1-05-pty-sortie-vide.md)): **PTY output never comes back** — `cmd.exe` and `conhost.exe` alive, writes accepted (`write_all+flush`), ~700 `terminal_read` calls all returning `output: ""`, the startup banner itself never received, resize with no effect. Root-cause lead: `portable-pty` **0.9.0** pinned, a version known for ConPTY freezes on Windows ([turborepo#11816](https://github.com/vercel/turborepo/pull/11816)). Remediation: downgrade or patch the crate, replay the scenario.
  - **FIXED on 27/09/2026** ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)): root cause **confirmed** = `portable-pty 0.9.0`; **downgraded to 0.8.1** (`Cargo.toml` + lock, `cargo build` OK, `npm test` + `tsc` green) and the full PTY loop comes back: **`cmd.exe` banner rendered, command typed on a real keyboard, output `muse-pty-fix-2026` displayed, prompt returned** — with no change in `terminal.rs`.
  - **Remaining:** a long interactive command (editor/REPL), the other shortcuts (Ctrl+D/L/Tab/Escape). **⚠ ROOT CAUSE of the wandering cwd found (27/09, run6 bis):** `terminal_open` passes the workspace in `\\?\G:\…` form (UNC, for `cmd.exe`) → **refused, forced deviation to `C:\Windows`** — so the shell is **never** bound to the conversation's cwd (an unmet acceptance piece), and it is the same root cause as the automations' workspace comparison defect; fix: normalise the cwd (strip `\\?\`) before spawning ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)). **→ Fixed on 22/09/2026** in `terminal.rs`, only the spawn touched (`std::process` already strips the prefix), with a real PTY test that failed on `C:\Windows>`; the in-app replay remains. **ANSI + Ctrl+C proved on 27/09/2026 (run5):** SGR `31m`/`32m` rendered in distinct colours (`RED`→`rgb(239,68,68)`, `GREEN`→`rgb(34,197,94)`); `ping -n 20` interrupted after ~6 replies with a `^C` mark. **Resize: DEFECT CONFIRMED on 27/09/2026 (run4)** — the pane follows the window (506×820 → 332×520 through `set_window_frame`) but `mode con` stays **28×100** across all three measurements: the PTY geometry never moves (`terminal_resize` not called or ignored); located on the app side, not `portable-pty` ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)). **→ FIX implemented on 25/09/2026** (`97f9eb1`): the panel now watches its own size with a ResizeObserver (monospace cell measured in the rendered font) and calls `terminal_resize` with clamped bounds mirrored from `terminal.rs`; the in-app `mode con` replay remains. **Interactive round trip proved on 27/09/2026** (run3): `set /p ANS=Name?` waiting → input `interactive-ok` delivered → `echo %ANS%` → **`interactive-ok`** (captured on the process side). The historical defect below keeps its record.
  - **Windows ☑ on 26/09/2026** ([campaign](evidence/2026-09-26-m1-closure/README.md), [`m1-05-terminal-native.json`](evidence/2026-09-26-m1-closure/m1-05-terminal-native.json)): the in-app replays all pass — `mode con` follows the pane (51×27 → 68×38 → 78×38 manual → 51×27 back), the manual −/+ width **survives observer re-notifications and lifts on a real pane move**, Tab completes, Escape discards, Ctrl+L lands as the ConPTY repaint, and the **node REPL** round trip (`1+1 → 2`, Ctrl+D exit back to the bound `G:\repos\openscreen>` prompt) proves the cwd binding and the long-interactive criterion. Ctrl+C's interrupt stands on the 27/09 real-keyboard proof; the CDP synthetic key path cannot reproduce the ConPTY interrupt and the harness records the attempt honestly. Every Windows-reachable criterion of the ticket is proved; macOS/Linux stay ◐/☐.

- ◐ **M1-06 — Have the engine read the terminal output**
  - Windows ◐ — **Add output to prompt** (fallback bounded to 12,000 characters), **Run in Muse** negotiating `userShell`, fallback for `item/completed` with no delta, deferred `item/readOutput` reading in 64 KiB blocks.
  - **Blocking finding of 19/09/2026: DISPROVED on 21/09/2026 — it was a measurement artefact.** The harness sent the capability **flat** (`capabilities: {}` **plus** `requestedCapabilities: ["userShell"]`), a shape the host reads as "no capability requested". It therefore got `grantedCapabilities: []`, the call answered `capabilityRequired`, and the probe concluded "no `userShell` item". With the shape the application has always used — **nested**, `capabilities.requestedCapabilities` (`src-tauri/src/main.rs`) — the same probe measures: `grantedCapabilities: ["userShell"]`, `session/userShell` → **`accepted`** with a `commandId`, then **`item/started` and `item/completed` of kind `userShell`** (at 1,867 and 1,922 ms), and the command's marker **returned**. Verdict of the corrected probe: "the host DOES publish 2 userShell item(s) — the gap report is wrong here".
  - **Consequence:** the blocker is **not** on the host side. `SIDECAR-CONTRACT-GAPS.md` must no longer be invoked for M1-06, and the client-side `Run in Muse` path works: capability projected by Rust, merged by the renderer, button enabled as soon as a command is typed.
  - **Second defect found, a synchronisation one (21/09/2026):** the renderer's `grantedCapabilitiesBySession` map is populated **only at mount**, by a `restore_sessions` that runs before the per-workspace hosts are started. On a fresh launch it therefore holds only part of the sessions, and **nothing repopulates it** — the button announces "did not grant the userShell capability" although the host granted it. Measured: bridge `["userShell"]` for all 13 sessions, renderer map reduced to `01a0c2d7`. Detail in [`evidence/2026-09-21-ux/m1-06-capacites-au-montage.md`](evidence/2026-09-21-ux/m1-06-capacites-au-montage.md).
  - **`sessionNotLoaded` is no longer an opaque failure:** the host reports `status: "notLoaded"` for **every** persisted session after a relaunch — including at 27 turns — so "listed" and "loaded" are two different states. `SessionMeta` now carries `loaded` and the button is unavailable with an exact reason while the conversation is not loaded, instead of failing after the click.
  - **Remaining:** (1) repopulate the capability map after the hosts start — begun: the `start_session`/`resume_session` responses carry `granted_capabilities` and the renderer hydrates them on (re)connection (**measured 27/09**: `["userShell"]` propagated); (2) **show the `userShell` output in the Run in Muse card** (the items and their `output` are indeed published by the host — `msp-user-shell-items.mjs`); (3) interactive native qualification on all three OSes.
  - **Qualification 27/09/2026** ([`m1-06-run-in-muse-sandbox.md`](evidence/2026-09-27-qualif-native/m1-06-run-in-muse-sandbox.md)): the full chain is proved — **Run in Muse** clicked → `userShell` item + output **shown in the thread in 1 s**. The command **really executes** in an external host (`markerEchoed: true`, 78 ms) with the app's binary, flags and workspace. **Remaining defect:** a host started **by** the application answers `managed shell sandbox is unavailable` — even after `muse sandbox windows setup` (mandatory: `sandbox_users_missing` on a fresh machine) and even on a fresh session. Lead: the spawn context from the Tauri process. The `\\?\` prefix is ruled out: the host accepts it as `workspaceRoot` and as cwd (measured 22/09). **Measured on 23/09:** under the `windows_elevated` sandbox, the model's `powershell` tool never returns, whether the host was started by the app or not; with `--disable-sandbox`, it finishes in 1 s. A host bug to report ([`outil-shell-bloque-sandbox.md`](evidence/2026-09-21-ux/outil-shell-bloque-sandbox.md)). **Add output to prompt** is still to be validated as soon as a command succeeds in the app.
  - macOS ☐ / Linux ☐ — not started; native qualification on all three OSes is required by the ticket. **Windows ☑ on 26/09/2026** ([`m1-06-add-output-prompt.json`](evidence/2026-09-26-m1-closure/m1-06-add-output-prompt.json)): **Add output to prompt** is proved natively — a marker `echo` lands in the composer through the panel button with the `[Terminal output · …]` provenance block, and a ~44k-char output is delivered as a bounded **12,001-character block, tail kept**. The last Windows-reachable criterion is closed (macOS/Linux stay ☐).

- ◐ **M1-07 → M1-08 — files and attachments** *(shared code)*
  - ◐ M1-07 — session-scoped `files_list`/`file_read`/`file_open`, root/absolute/traversal/symlink guards, 500-entry listing, 512 KB reads, images and PDFs under 5 MiB as bounded base64, native watcher flagging staleness, **Add to prompt** with provenance. **Windows ☑ on 26/09/2026** ([campaign](evidence/2026-09-26-m1-closure/README.md)): text preview + Add to prompt with provenance, office file kept out of the text preview, a 550-entry folder lists the first 200 with the explicit note, an on-disk rename appears on refresh, and a **deleted browsed folder yields a bounded error** with `Up` recovering — the renames/deleted-roots/office-formats pieces are all closed. **Remaining:** macOS/Linux.
  - ◐ M1-08 — real MSP `text` and `image` parts (the schema does **not** accept an arbitrary file part), Rust validation of type/MIME/base64/dimensions/bounds (8 parts, 120,000 characters, 5 MB), outbox persisting the exact parts, bounded draft with **Reselect** beyond that. **Windows ☑ on 26/09/2026** ([`m1-08-attachments.json`](evidence/2026-09-26-m1-closure/m1-08-attachments.json), [`m1-08-single-image.json`](evidence/2026-09-26-m1-closure/m1-08-single-image.json)): a single real PNG rides a live turn (the model answers about the pixel's colour), the 9th file is refused by the UI, and an 8-image + text send is rejected at the wire (`inputParts cannot contain more than 8 parts`) with the text preserved and the Retry/Discard outbox intact. **Recorded defect (minor):** the UI counts *files* (8) while the wire counts *parts* (text + 8 = 9) — the bounds disagree; to reconcile. **Remaining:** macOS/Linux.

- ◐ **M1-09 — Create a faithful conversation branch** *(Global: —)*
  - Windows ◐ — `session/fork` verified in the Windows binary's schema, `excludeItems: true`, precise MSP `lastTurnId` anchor through **Fork from here**, persisted `session/branchChanged` notification, explicit recovery on an unavailable anchor.
  - **Host limit observed:** rejection `fork seed materialized 3 run ids for 2 stored turns` on an old dogfood session with sub-agents; fork **OK** on a fresh one-turn session on 20/09. Failure confined to host 1.3.0, nothing to fix on the supervisor side. **Measured again on 26/09/2026** ([campaign](evidence/2026-09-26-m1-closure/README.md)): the refusal now covers **every anchor, a fresh two-turn session included** — raw error captured via a direct `fork_session` IPC call: `MSP error -32023: invalid fork boundary … WriteFailed [forkBoundaryInvalid] [retryable=false]`. Correlation: every session now carries `Reminder child session` sub-agent lanes, and the documented limit is fork-seed materialization on sub-agent sessions. The **explicit recovery copy on an unavailable anchor** ("That turn is no longer available on the host…") is proved without any crash — a listed criterion — and the app stays actionable. Windows stays ◐ solely for the host-blocked creation piece; added to the upstream blockers memo.
  - macOS ☐ / Linux ☐ — contract verified on a **Windows** binary only.

- ◐ **M1-10 — Redirect an execution or queue it** *(Global: —)*
  - Windows ◐ — MSP queue by default, visible `queued`/`steered` dispositions, order persisted under `muse-desktop.queued-turns.v1`, `turn/unqueue`, reconciliation on `history.snapshot.queuedTurns`. Smoke `--exercise-queue` passed on two sessions: `disposition: queued` then `turn/unqueue` accepted.
  - **Progress (27/09/2026):** the removal race played for real in the webview ([`m1-10-course-de-file.md`](evidence/2026-09-27-qualif-native/m1-10-course-de-file.md)): burst removals from the page context during a first turn — **no removed turn ever started** (neither acknowledgement nor answer), queue emptied, the first turn carried to its terminal. **Race-closing run on the evening of 27/09:** two turns **correctly and distinctly queued** (A and B, with no duplicate — the duplication came from the harness: a double synthetic Enter, fixed), removed during execution, **never launched** (queue empty as soon as they were removed, the first turn still alone at +20 s), with an "unsent" trace in the log for both.
  - **Remaining:** only execution in the packaged webview (a dev build here). **→ Windows ☑ on 26/09/2026** ([`m1-10-packaged-queue-race.json`](evidence/2026-09-26-m1-closure/m1-10-packaged-queue-race.json)): the removal race replayed in the **packaged NSIS 0.1.0 webview** — two turns queued while the first ran, both removed mid-flight (2 clicks), the queue emptied **while the first turn was still running**, neither removed turn ever answered (no ALPHA/BETA in the settled transcript), and the first turn carried to completion. **Restore after restart proved on 27/09/2026** ([`m1-10-course-de-file.md`](evidence/2026-09-27-qualif-native/m1-10-course-de-file.md)): two turns queued → `taskkill /F` mid-turn → relaunch → storage intact **and the queue resumes on its own, in order** (A→ALPHA then B→BETA), with no duplicate and no inversion. Every Windows-reachable criterion is closed; macOS/Linux stay ☐.
  - macOS ☐ / Linux ☐ — not started.

- ◐ **M1-11 — Pick an available model and follow the context** *(Global: —)*
  - Windows ◐ — `model/list` as the source of truth, `session/setModel`, compaction as a separate gesture with a `pending → accepted/noop/error` cycle, `session/contextUsage` and `session/tokenUsage` displayed as provided, reasoning effort: the picker offers **the seven persistent Muse Spark levels** (`minimal`→`ultra`; `none` removed — a thread-only value the CLI never persists, and `ultra` presented as `max` + autonomy) while the validator stays on **the contract's eight values** (`none`→`ultra`, `max` included), persisted globally and per project and applied through `session/setReasoningEffort` ([evidence](evidence/2026-09-27-qualif-native/effort-raisonnement-sept-niveaux.md)), last model kept in `StoredSession.model_id`.
  - **Native proofs:** all **eight** levels are accepted by a live 1.3.0 host and each emits `session/reasoningEffortChanged` with the value sent (`node scripts/msp-reasoning-tiers.mjs`) — the "seven out of eight" came from our list, not the engine. **Measurements of 27/09/2026:** the model's "effective" state **is** visible on the host side — `list_models` returns `is_active: true` on the current model, `start_session`/`resume_session` report `model_id`, and `session/setModel` projects onto the session (`msp-projection-check.mjs`); the old `isActive: false` from `--exercise-model` came from the harness's `--no-session-log` host ([evidence](evidence/2026-09-27-qualif-native/session-log-expique-tout.md)). **Remaining:** context tracking (`contextUsage`) and native qualification.
  - **Qualification 27/09/2026** ([`m1-11-bascule-modele.md`](evidence/2026-09-27-qualif-native/m1-11-bascule-modele.md)): the switch is proved on the thread (`set_model` with `modelId`+`providerId`+`profileId` per `sessionId`; `list_models`→`is_active` follows) and **the host's state really is per session** (two conversations in the same workspace diverge). **Defect blocking closure: the picker's label is not per conversation** — on a switch, the UI announces the last model chosen elsewhere (measured: A shows `muse-spark-1.3` while it runs on `muse-spark-1.2-contributor`); the label does match the effective model exactly after `resume_session` hydration (`model_id` ↔ label). **→ FIX implemented on 25/09/2026** (`97f9eb1`): the catalog is now bound to the session it was read for (`liveModelsSessionId`), the picker prefers the session's own `model_id` over the shared `isActive` row, `set_active` re-reads `model/list` for the conversation being opened, and a failed per-session refresh no longer wipes the catalog; the in-app replay remains. Secondary: switching on an unloaded conversation → a clean host rejection ("conversation engine is unavailable — start or restore the conversation first") with no explanation in the picker. **Windows ☑ on 26/09/2026** ([`m1-11-model-context.json`](evidence/2026-09-26-m1-closure/m1-11-model-context.json), [`m1-11-context-trigger.json`](evidence/2026-09-26-m1-closure/m1-11-context-trigger.json)): the in-app replay passes — A keeps its own label while B switches to another model, B keeps the switched model across the round trip; and a 28,757-character turn makes the host emit `context_usage`, the meter rendering **"Context 6% used"** with the full popover (used/free, pressure copy). The last Windows-reachable criterion is closed; macOS/Linux stay ☐.
  - macOS ☐ / Linux ☐ — not started.

- ☑ **M1-12 — Find and organise conversations** *(no OS dimension — the only closed ticket)*
  - Search on title, folder and local log text with an excerpt; persisted pinning; **Move up**/**Move down** assigning persistent ranks; `new` marker cleared through `setActive`; `session/rename` propagated to the host when available; paginated `session/list` restore (opaque cursor, 200/page, 20 pages max) with deduplication and an explicit failure on a repeated or malformed cursor.
  - **Why closed:** every exit criterion is met and proved by the Node tests, with no native or OS dependency. Full sidebar virtualisation stays conditioned on a performance measurement — that is separate optimisation work, tracked by M1-13, not a criterion of this ticket.

- ◐ **M1-13 — Read a long conversation comfortably** *(no OS dimension)*
  - DOM window bounded beyond 600 entries (160 visible, 120 older loaded), virtual spacers proportional to the full log, heights measured by ResizeObserver, compensated scrolling, position and index persisted under `muse-desktop.stream-position.v1`, full **Ctrl/Cmd+F** finder jumping to a result outside the window, `aria-posinset`/`aria-setsize` metadata, Home/End/PageUp/PageDown navigation.
  - **Remaining:** assistive qualification (resource-blocked, same NVDA session as M0-12). **The packaged measurement is done on 26/09/2026** ([`m1-13-packaged-2000.json`](evidence/2026-09-26-m1-closure/m1-13-packaged-2000.json)): 2,000 persisted entries in the packaged NSIS webview — the window mounts **160 articles (1720→1880)**, 1,368 nodes, `aria-setsize 2000`/`aria-posinset` present, Load-older and Latest available, keyboard hints on the region; the original log restored byte-identical. The finder did not mount in that synthetic view (its jump was proved in dev earlier).

**Dependencies:** M1-01 → M1-02/03/04; M0-01 → M1-05/06/09/10; engine capabilities to verify before M1-08/09/10.
**🚦 M1 exit:** make, inspect, fix, test and ship a repository change from Muse, with a recovery path on error.

---

## M2 — Projects and isolated parallel work

| ID | Expected result | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M2-01 | A project represents persistent folders | — | ◐ | ☐ | ◐ |
| M2-02 | Project settings really apply | — | ◐ | ☐ | ☐ |
| M2-03 | Create a worktree automatically | — | ◐ | ◐ | ◐ |
| M2-04 | Prepare the worktree's environment | — | ◐ | ☐ | ◐ |
| M2-05 | Move from Local to Worktree and back | — | ◐ | ☐ | ☐ |
| M2-06 | Clean up worktrees without deleting work | — | ◐ | ◐ | ◐ |
| M2-07 | Drive the real sub-agents | — | ◐ | ☐ | ☐ |
| M2-08 | Run several writers without collision | — | ◐ | ☐ | ◐ |

### Detail

- ◐ **M2-01 — A project represents persistent folders** *(Global: —)*
  - Windows ◐ — persistent multiple roots with `workspace` kept as the primary root, guided migration **N projects need a folder**, native probe `inspect_workspace_root` (`Available`/`Not a folder`/`Missing`), `projectId:rootIndex` environment picker when creating a conversation.
  - Windows ◐ — **folder rules**: read-only native probe `rules_scan` (`AGENTS.md` first, `CLAUDE.md` only as a fallback, personal rules as a conditional fallback), shown in the project with their status. The client instruction field has been **removed** — a project does not own instructions, the CLI reads the folder's. Details and limits: [regles-du-dossier](evidence/2026-09-21-ux/regles-du-dossier.md).
  - Windows ◐ — **project picker**: "Start in" becomes "Project", the default option is "No project", and the folder is shown only when it distinguishes — a project born from its own folder no longer shows "openscreen · openscreen" under a folder picker that already says "openscreen". Two roots that would still read the same fall back to the full path (`projectOptionLabels`).
  - **Remaining:** `workspaces[]` has no backend equivalent (one project = one folder on the CLI side).
  - Linux ◐ — the pure path (model, migration, projection) is covered by the Node tests and CI runs on Linux; the native probe is not exercised there.
  - macOS ☐ — not started.

- ◐ **M2-02 — Project settings really apply** *(Global: —)*
  - Windows ◐ — global/project inheritance through `settingsForThread` with a visible source (`g:`), effective model applied after `session/start`, `autoCompact` honoured, and above all **sandbox projection when the host starts**: `workspace` → `--sandbox-network restricted`, `network` → `--sandbox-network enabled`, `elevated` → `--disable-sandbox --sandbox-network enabled`, a `read-only` project → `--disable-write --disable-shell`. A host already running explicitly refuses a different posture and asks for **Restart workspace host**.
  - **Remaining:** native qualification of two projects with different postures and durable reconnection after a restart. The host provides no sandbox mutation over MSP — any switch requires a process restart.
  - macOS ☐ / Linux ☐ — not started.

- ◐ **M2-03 — Create a worktree automatically** *(Global: —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — `git_worktree_create(sessionId, branch, relativePath, baseRef)` confined to `.muse/worktrees/`, `git worktree add -b` off the UI thread, refusal of existing paths / option-shaped references / traversals, atomic **Create & open** action with admission rollback. Git is identical on all three OSes, but **no native proof** exists outside Windows.
  - **Qualification 27/09/2026** ([`m2-worktrees.md`](evidence/2026-09-27-qualif-native/m2-worktrees.md)): the mechanism is a **full PASS** (`ux-start-worktree.mjs`: creation, `muse/…` branch, `HEAD` base, refusal "worktree path must be relative and stay inside .muse/worktrees", rollback). **Wiring defect measured on the thread:** the "Create a new worktree" checkbox creates the worktree (`git_worktree_create_for_workspace` → `…\.muse\worktrees\openscreen-rn3d0`) but **the conversation starts in the main repository** — `start_session` receives `workspacePath: G:\repos\openscreen` and `git_status` announces `branch: "pr620"`, never `muse/openscreen-rn3d0`. The `path` returned is not passed to `start_session`: "Create & open" does not open. **→ FIX implemented on 25/09/2026** (`97f9eb1`): root cause was the welcome-screen flow calling the no-argument `startSession()` when no project was selected, discarding the worktree path; the flow now always starts in `startFolder` when a worktree exists (project settings attached only when a project is chosen). The in-app replay (`git_status` must announce `muse/…`) remains.
  - **Remaining:** native qualification and failures after admission.

- ◐ **M2-04 — Prepare the worktree's environment** *(Global: —)*
  - Windows ◐ / Linux ◐ — persistent per-workspace profiles, a user command bounded to 2,000 characters run only after **Run setup**, states `ready`/`failed`/`timedOut`/`cancelled`, targeted native cancellation, a runner refusing folders outside `.muse/worktrees` and killing past ten minutes, **Check readiness** detecting `package.json`/`Cargo.toml`/`pyproject.toml`/`go.mod`.
  - Linux ◐ — the runner purges the inherited environment and keeps `PATH`, temporary folders, home and locale, plus Windows variables (`PATHEXT`, `ComSpec`) neutralised elsewhere: the Linux path is plausible and tested in Rust, not exercised natively.
  - macOS ☐ — not started.
  - **Remaining:** native qualification of atomic creation and of setup on each platform.

- ◐ **M2-05 — Move from Local to Worktree and back** *(Global: —)*
  - Windows ◐ — **Prepare handoff** produces a read-only local plan (source workspace, target worktree, conflicts, uncommitted changes, target state, branch availability), `pass`/`warn`/`blocked` checks, invalidation as **refresh required**, **Open with handoff context** placing a bounded editable note in the composer.
  - **Blocker:** the actual transfer (atomic host stop/resume, moving the context, rollback) stays **blocked by the absence of a multi-workspace MSP contract**. No implicit switch is triggered.
  - macOS ☐ / Linux ☐ — not started.

- ◐ **M2-06 — Clean up worktrees without deleting work** *(Global: —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — **Inspect** reading the real Git status, refusal to delete a dirty checkout or one attached to Muse conversations, `.muse/worktrees/` confinement, per-repository retention policy (7/14/30/90 days or indefinite) computed **only after a clean inspection**, **Inspect all** in parallel, a persistent cleanup intent resumed after an interruption. Git keeps the final decision if a checkout is locked.
  - **Remaining:** qualification of external processes — inspection cannot know about every process outside Muse.

- ◐ **M2-07 — Drive the real sub-agents** *(Global: —)*
  - **Qualification 27/09/2026 (concurrency):** two **simultaneous** `subagent-running` lanes observed live (`e8af2a61` + `47a01e3d`), but **controlled reproduction out of the model's reach** — muse-spark serialises its delegation despite an order to overlap (20 samples / 30 s: `maxConcurrentRunning=1`); clean multi-thread reproduction remains ([`m2-worktrees.md`](evidence/2026-09-27-qualif-native/m2-worktrees.md)). **→ CONCURRENCY PROVED afterwards (run2):** 3 simultaneous `running` lanes in one thread + 2 `running` lanes in a second thread at the same time — the app renders, follows and controls several children in parallel, across threads and within a thread.
  - Windows ◐ — host states normalised and visible, `item/updated` snapshots replaced by revision in the sub-agent lane, controls bounded by lifecycle.
  - **Remaining:** native qualification on live agents and interleaved terminal events. **Pieces measured on 27/09/2026** ([`m2-worktrees.md`](evidence/2026-09-27-qualif-native/m2-worktrees.md)): the host publishes real **`childSessionId`** items (child sessions created by the model) and the UI renders **sub-agent lanes with stop buttons** (`title="subagent/stop"`, captured in the `cdp-stop-terminal` runs) — the full fan-out scenario with parent resume remains.
  - macOS ☐ / Linux ☐ — not started.

- ◐ **M2-08 — Run several writers without collision** *(Global: —)*
  - Windows ◐ / Linux ◐ — target files pre-flighted and persisted per workspace, overlap detection blocking two writers on a common file or subfolder, `cores - 2` lanes bounded to 4–8 and a FIFO queue, explicit dispatch to the worktree's conversation through the normal start/send path, **renderer lease** bounded to the workspace + **Tauri advisory OS lock** per target released by the OS after a crash, a Stop acknowledgement keeping the lease until the terminal, local extractive summary.
  - Linux ◐ — the advisory OS lock is Tauri Rust and therefore portable in principle; not exercised natively.
  - macOS ☐ — not started.
  - **Remaining:** confirmed atomic MSP cancellation and complete business-result collection — the current MSP protocol provides neither a file lock, nor a structured writer result, nor confirmed atomic cancellation.

**Dependencies:** M0-01/02 and M1-01 before M2-03; M2-03 before M2-04/05/06/08.
**🚦 M2 exit:** two conversations change and test independent spaces; restart, transfer and cleanup preserve the changes.

---

## M3 — Operational extensions and automations

| ID | Expected result | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M3-01 | Connect a local MCP server | ◐ | ◐ | ◐ | ◐ |
| M3-02 | Connect a remote MCP server | ◐ | ◐ | ☐ | ☐ |
| M3-03 | Install/disable a usable extension | ◐ | ◐ | ◐ | ◐ |
| M3-04 | Discover skills on disk and in the project | ◐ | ◐ | ◐ | ◐ |
| M3-05 | Invoke a skill with its real context | — | ◐ | ☐ | ☐ |
| M3-06 | Run scheduled work with no prior click | — | ◐ | ◐ | ◐ |
| M3-07 | Handle sleep, resume, duplicates and failures | — | ◐ | ◐ | ◐ |
| M3-08 | Review run results | ◐ | ◐ | ◐ | ◐ |
| M3-09 | Receive a useful notification | — | ◐ | ◐ | ◐ |

### Detail

- ◐ **M3-01 — Connect a local MCP server** *(no OS dimension in the transport)*
  - Real stdio transport with a handshake `initialize` → `notifications/initialized` → `tools/list`/`tools/call`, `Content-Length` frames and line-delimited JSON, explicit persistent process **Start server**/**Stop server**, manual **Refresh tools**, bounded hot reload on `tools/list_changed`, opt-in `config.mcpServers` injection on start/resume/worktree, authorization following the global posture, **Reconnect with current connectors**.
  - **Remaining:** the tool catalogue actually exposed by the Muse host, native permission authority, native qualification. Discovered tools are **not** copied into the MSP catalogue — the injection leaves the host to initialise its own capabilities.

- ◐ **M3-02 — Connect a remote MCP server**
  - Windows ◐ / macOS ◐ / Linux ◐ *(code)* — streamable HTTP/SSE transport, `Mcp-Session-Id` carried over, bearer in memory then in the **native credential manager** through the `keyring` crate: Windows Credential Manager, macOS Keychain, Secret Service/keyutils on Linux. **Forget token** revokes the native copy without deleting the connector. A public HTTPS endpoint is mandatory, private addresses are refused, and an expired session is renewed automatically once (401/403, a single time).
  - macOS ☐ / Linux ☐ *(proof)* — the `keyring` backend is cross-platform but **only Windows is qualified**: neither the macOS keychain nor Linux Secret Service has been exercised. Remote networking has not been tested outside Windows.
  - **Remaining:** OAuth/provider refresh, remote catalogue on the host side, macOS/Linux network qualification.

- ◐ **M3-03 — Install/disable an actually usable extension** *(shared code)*
  - Registration after a successful `tools/list` probe, explicit persistent runtime, hot list, catalogue and revision rollback for `.mcpb`/ZIP with validation of `manifest.json`, semver, runtime and entry point, writing under `app_data/mcp-packages/<id>/<version>` by staging plus atomic rename, immutable revisions, the server is **never** executed during installation. Provenance, version and source displayed.
  - **Remaining:** the tool catalogue actually visible to the host and native permission authority; native qualification of a packaged server.

- ◐ **M3-04 — Discover skills on disk and in the project** *(shared code)*
  - `skills_scan` bounded to the roots `.agents/skills`, `.muse/skills`, `.claude/skills` and `skills`, limited to 100 documents and 20,000 characters per file, outbound symlinks ignored, frontmatter requiring `name` and `description`, strictly relative resources, precedence project > repo > team > builtin, explicit reload.
  - **Remaining:** the host catalogue is loaded separately through M3-05 to avoid two sources of truth; qualification of the host contract.

- ◐ **M3-05 — Invoke a skill with its real context** *(Global: —)*
  - Windows ◐ — `skills_read_resources` re-reads the resources just before sending with Rust verification of the path and the workspace, context tagged `<skill-resource>` with a truncation marker, a resource error creating a system entry with no partial send, `skill/list` catalogue hydrated per session and invalidated on `skill/changed`, the `/selector arguments` command turned into an MSP `{type: "skill"}` part, `preparing`→`failed`/`unknown` progress exposed.
  - macOS ☐ / Linux ☐ — qualification of the host contract not started.

- ◐ **M3-06 — Run scheduled work with no prior click** *(Global: —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — each schedule captures workspace, project, model, policy and time zone; `ask` stays in review, `workspace`/YOLO dispatch; bounded local run log; structured turn end marking `completed`/`failed`; **next trigger** computed from the same cron/time-zone cursor as the dispatcher; **cross-platform one-shot wake-up shipped**: `Muse-Desktop\AutomationWake` task (Windows), `com.muse.desktop.automation-wake` job under `~/Library/LaunchAgents` (macOS), `muse-desktop-automation-wake.timer` timer (Linux).
  - **Remaining:** the wake-up relaunches the executable with `--automation-wakeup` — it is a **relaunch mechanism, not a background service**. It depends on the user session and is qualified on **no** OS (locked machine, sleep, host crash). The business signal is provided directly by the host while it is still open.
  - **Wake-up state measured on 27/09/2026:** `schtasks /query /tn "Muse-Desktop\AutomationWake"` → **task not found** (not registered here) — the app's status "Native wake-up is unavailable; keep Muse open for automations." is **accurate**; registering the task is the remaining qualification entry point ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)).
  - **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)): **execution with no click proved with the app open** — a `Once` automation created for 16:34:00, run created at 16:34:11, `completed` in 12 s, a **new conversation** created (`threadReuse: new` + `sessionId`), the answer `WOKEN` captured. The app declares the native wake-up state itself: **"Native wake-up is unavailable; keep Muse open for automations."** — the `AutomationWake` mechanism is still to be qualified (it did not declare itself available here).
  - **Targeting an existing conversation (27/09/2026, continued):** an honest refusal measured on a busy thread (run `failed`, `sessionId: ""`, explicit error, persisted `run-failed` notification — no inconsistent state) — **but a blocking defect**: the dispatch compares `workspace: "G:\repos\openscreen"` (scheduling) with `workspace: "\\\\?\\G:\repos\\openscreen"` (conversation, the raw form from `start_instance`/`start_session`) → **same directory, two spellings, systematic failure**. "Reusing the same thread" is unplayable until that comparison is normalised. **→ Comparison normalised on 22/09/2026** (`displayPath` on both sides, storage unchanged); a replay on a free thread then a busy one remains.
  - *Note:* **the only M3 ticket with three distinct native implementations**, so the only one where the per-OS column reflects different code and not merely a missing proof.

- ◐ **M3-07 — Handle sleep, resume, duplicates and scheduling failures** *(Global: —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — skip/latest policy, stable occurrence cursor, cross-window lease, anti-duplicate claim, bounded retries (3 attempts, 15/30/60 s backoff) that can be cancelled, immediate wake on returning to the window, IANA time zone captured as wall-clock time with DST gaps and duplicates resolved, a single `setTimeout` chain, an **exclusive native Tauri lease** recoverable after a crash with a local fallback in preview, atomic native mirrors under `app_data/scheduler/`, non-terminal runs marked **Review needed** after a restart and blocked until explicit reconciliation.
  - **Remaining:** native qualification of the lease and of the triggers **on each OS** (Task Scheduler / `launchd` / `systemd` are three distinct implementations), proof of host state after a crash, locked machine, sleep and wake.
  - **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)): proved pieces — **exclusive native lease active** (`scheduler_claim` → `{"acquired":true,"native":true}`, 30 s TTL, ownerId shown in the panel), persisted **anti-duplicate claim** (`occurrenceKey = scheduleId:occurrenceAt`), `missedPolicy` and the occurrence cursor (`No further runs` after a `once` is consumed). Remaining: crash and relaunch ("Review needed"), attempt exhaustion, sleep.
  - **DST/time zone measured on 27/09/2026:** gaps and duplicate hours **resolved deterministically** (gap `28/03/2027 02:30` → `03:30` summer time; duplicate `31/10/2027 02:30` → **first occurrence**), IANA `timeZone` persisted per schedule — **but no warning is shown** for those adjustments: the "shows the warnings" half of the time-zone acceptance stays open. **→ FIX implemented on 25/09/2026** (`97f9eb1`): `resolveOnceTrigger` (schedules.ts) resolves the picked wall clock explicitly and the creation form now shows the adjustment — gap → the measured jump-forward instant, duplicate → first occurrence kept (the tests pin the 27/09 measured epochs); native replay of the form remains.
  - **Restart mid-run (27/09/2026):** a non-terminal run killed by `taskkill /F`, app relaunched → the run **still shows "Running"** (dead work) — **the "Review needed" marking does not happen** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)): the "blocked until explicit reconciliation" acceptance is unmet, and the displayed state is inconsistent. **→ FIX implemented on 25/09/2026** (`97f9eb1`): boot recovery ran before the native app-data ledger was merged, and a native snapshot without the marker outranked the recovered row — the hold is now re-applied after the merge (`recoverScheduleRuns(mergeScheduleRuns(...))`, regression-tested). Kill replay remains.

- ◐ **M3-08 — Review run results** *(shared code)*
  - Bounded history, preview, status, unread, link to the conversation, archiving, filters, manual retry, context inspector; bounded local extractive summary (headline, counters, up to 12 files, up to 12 issues) **with no model call**; explicit **Issues / Warnings / Blockers / Risks** and **Next steps / Todo / Follow-up / Remaining** lines extracted separately and persisted with no inference; structured `result/output/summary/text` preview from the host crossing the Rust bridge and preserved after bounding.
  - **Remaining:** a semantic business summary and a native run end — depends on the host. **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)): a complete run card measured — `resultPreview: "WOKEN"`, `attempt`, `unread`, filters `Queued/Running/Completed/Failed/Archived`, actions `Inspect run` / `Open conversation` / `Mark read` / `Archive` and manual retry all present.

- ◐ **M3-09 — Receive a useful notification** *(Global: —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — local inbox deduplicated by idempotency key, unread, All/Unread filters, persistent muting, routing to the target conversation with the click preserved during rehydration, bounded native ledger under app data, unit or global acknowledgement, structured issues and next steps carried through.
  - **Remaining (blocking, per OS):** **native qualification of the permission prompt** is still to be run on Windows/macOS/Linux, through `tauri-plugin-notification` with a webview fallback. The application must stay open to receive host events — **no persistent service while the app is closed**.
  - **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)): **useful notification proved in-app** — "Automation completed: Qualif M3 wake — NEW — WOKEN — 16:34:23" with the **run's result**, actions **Open conversation** and **Mark read**, an `Unread (1)` counter, All/Unread filters. Only the native permission prompt (system banner) remains.

**Dependencies:** M0-06/08 before MCP; M2-01 and M0-02/09 before M3-06; M2-03 if the run is isolated; M3-06/07 before the inbox.
**🚦 M3 exit:** a scheduled run uses a real tool or skill, executes according to the policy and produces a reviewable result. For local runs, "app and computer switched on" stays an explicit constraint.

---

## M4 — Extended parity

*These gaps stay visible for an ambition of full parity. Their feasibility must be checked against the Muse engine before committing to implementation.*

| ID | Expected result | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M4-01 | Browse in a real built-in browser | — | ◐ | ☐ | ☐ |
| M4-02 | Annotate a page visually | — | ◐ | ☐ | ☐ |
| M4-03 | Have Muse drive the browser | — | ◐ | ☐ | ☐ |
| M4-04 | Have Muse drive a desktop application | — | ◐ | ☐ | ☐ |
| M4-05 | Produce and read images and rich documents | — | ◐ | ◐ | ◐ |
| M4-06 | Share by URL and revoke access | ☐ | ☐ | ☐ | ☐ |
| M4-07 | Control an execution on another host or in the cloud | ◐ | ◐ | ◐ | ◐ |
| M4-08 | Interact by voice | — | ◐ | ◐ | ◐ |
| M4-09 | Install and update on the announced platforms | — | ◐ | ☐ | ☐ |

### Detail

- ◐ **M4-01 / M4-02 / M4-03 — built-in browser, annotations, driving** *(Global: —)*
  - Windows ◐ — normalised navigation, history and eight tabs isolated by `sessionId` under `muse-desktop.browser.tabs.v1`, explicit same-origin download bounded to 10 MiB with `credentials: omit` and redirects refused, interception of `<a download>` links, **Open native** opening a dedicated `muse-browser` Tauri webview with a non-persistent private profile, idempotent **Close native**.
  - **Fundamental:** the native surface rests on **WebView2**, hence Windows. The tickets speak explicitly of "WebView2 qualification" — the macOS (WKWebView) and Linux (WebKitGTK) equivalents are **not started**. The iframe sandbox stays the web-preview fallback.
  - **Remaining:** native qualification, cross-origin pages, download responses initiated by navigation, automatic capture of the iframe alone, the complete workflow.

- ◐ **M4-04 — Have Muse drive a desktop application** *(the most asymmetric ticket)*
  - Windows ◐ — **computer use now rests on the open-source CUA driver** ([trycua/cua](https://github.com/trycua/cua), MIT): the application starts **its own service** on a private named channel, in `bounded` mode, with a **capability manifest it generates and approves**, and hands the Muse host the MCP entry pointing at it. One switch, three levels (19 / 38 / 57 tools measured on 0.28.2), no application list. **Verified end to end:** `get_screen_size` answers, `click` is refused by the driver itself (`outside the capability manifest`), revoking stops the service. Plan and measurements: [2026-09-22-computer-use-cua](plans/2026-09-22-computer-use-cua.md).
  - Windows ◐ — the older native surface remains: bounded inventory of visible windows, read-only observation through UI Automation (semantic role, automation identifier, geometry, visibility, state), bounded `ValuePattern`/`RangeValuePattern`/`SelectionItemPattern`/`TogglePattern`/`TextPattern` values for non-sensitive controls, `value hidden` masking of password and credential-like controls, explicit Win32 fallback, focus/text/keys/clicks behind the **Allow desktop control** consent (OFF by default, reasserted in a volatile native lock), capture through the OS picker, `computer.*` adapter conditioned on the host catalogue, **Stop Muse action**.
  - **Dogfood of 20/09:** panel reached through UIA tabs, consent observed OFF by default, `Available` badge, capture not automatic — consent deliberately **not granted**, so the actions are not proved in real conditions.
  - macOS ☐ / Linux ☐ — **not started, and explicitly outside the code's scope**: `desktop_control.rs` returns `supported: false` with the reason "Desktop control is not available on this platform yet" instead of simulating availability.
  - **Remaining:** a real turn where the model calls a `computer_*` tool; applying a level change to an already-open conversation (the MCP list is fixed at `session/start`/`session/resume`, so a resume is needed); guided rather than automatic driver installation; macOS/Linux runtimes. This slice **must not** be presented as autonomous desktop control until the real turn is measured.

- ◐ **M4-05 — Produce and read images and rich documents** *(shared code)*
  - Versioned Markdown artefacts with **Preview/Source**, local editing **Save as new version**, notes with a quote bounded to 240 characters, UTF-8 text export bounded to 2 MiB through the native picker; CSV/TSV/JSON as an accessible table (100 rows, 20 columns, 400 characters per cell); DOCX/XLSX/PPTX/ODT/ODS/ODP up to 5 MiB decompressed with `fflate`, keeping only the useful XML parts (ceilings of 4 MiB per entry, 8 MiB cumulative, 500 entries); **bounded RTF extraction**; binary `item/readOutput` output in 64 KiB blocks with image/PDF/document preview, native save and **Open in app**; full PDFs in the WebView's reader.
  - Windows ◐ / macOS ◐ / Linux ◐ — parsing and rendering in JavaScript, so genuinely portable; **no native proof outside Windows**.
  - **Remaining:** actual generation by the engine, formats beyond OOXML/ODF/RTF, cross-platform native qualification.

- ☐ **M4-06 — Share by URL and revoke access** *(Global: ☐ — postponed)*
  - Windows ☐ / macOS ☐ / Linux ☐ — **decision: postponed pending a product specification.**
  - What exists: local Markdown/JSON export, bounded bundles (400 entries, 12,000 characters per entry, 240,000-character body), credential-shaped values replaced, `redacted`/`truncated`/`omittedEntries` metadata, native save, retention of 100 bundles, **local** revocation in the profile's SSOT.
  - What is missing: hosting, identity, permissions and real revocation between clients. **No server, token, account or public link is simulated.** It is the only ticket at ☐: it is blocked by a product decision, not by missing code.

- ◐ **M4-07 — Control an execution on another host or in the cloud** *(no OS dimension in the model)*
  - Pure `HostConnection` abstraction under `muse-desktop.host-connections.v1`: strict `local`/`remote-ssh`/`cloud-runner` typing, a `disconnected`/`connecting`/`connected`/`reconnecting`/`error` state machine, secret masking, SSH/HTTPS endpoint sanitisation, bounded reconnection backoff, heartbeat evaluation, isolated session routing, environment teardown with no orphans, an environment manager in Settings.
  - **Remaining:** interactive authentication with a native SSH key and a remote cloud container runtime — the real transport does not exist yet, only the pure model and 11 unit tests.

- ◐ **M4-08 — Interact by voice** *(no OS dimension in the code)*
  - Windows ◐ / macOS ◐ / Linux ◐ — **Voice** in the composer through `SpeechRecognition`/`webkitSpeechRecognition` after a user gesture, interim and final results staying in the editable draft, a `getUserMedia({audio:true})` pre-check with temporary tracks stopped immediately, refusal editable as text, no audio persisted or sent to the host, microphone errors translated into calm messages.
  - **Remaining:** the runtime depends on the WebView's Speech API support — **WebView2, WKWebView and WebKitGTK do not expose it the same way**. Real-time conversation, a remote provider and per-platform qualification of the Tauri permission dialog stay open.

- ◐ **M4-09 — Install and update on the announced platforms** *(the distribution ticket)*
  - Windows ◐ — **reproducible x64 NSIS and MSI bundles** with the sidecar, icons and SHA-256 integrity manifests; a `muse-desktop.release-manifest.v1` manifest with no machine path and no timestamp, signable in Ed25519 and revalidated at every step; a `muse-desktop.release-update.v1` update plan, copied staging published by atomic rename, `current`/`previous` switch with rollback, `release:launch` asking for a bounded stop of the PID then relaunching the executable with no shell, `release:installer` handoff to the NSIS `.exe` or `msiexec.exe`, SHA-256-verified `release:delta`, signed `release:channel`, `release:fetch` refusing redirects, `release:orchestrate sync` verifying then staging a candidate.
  - **Remaining (Windows):** operational hosting, rotation of the trust keys, publishing the sidecar (supplied by the build environment, **not versioned**), installation on a clean machine, wiring the rollback into the installer.
  - macOS ☐ / Linux ☐ — **not started**. No `.dmg`/`.app` or `.deb`/`.rpm`/AppImage bundle. The sidecar is a triple-suffixed `externalBin` (`muse-x86_64-unknown-linux-gnu` in CI): each OS requires its own Muse binary, not available in this repository. `tauri.conf.json` declares `minimumSystemVersion: 11.0` for macOS and `targets: "all"`, but no target has been built or qualified outside Windows x64. **→ Schema prerequisite unblocked on 25/09/2026** (`build-macos.sh` noted it as pending): the release manifest now carries `sidecar: null` for engine-not-bundled platforms, propagated through verify, update plan/stage/apply, channel and orchestrator (tested, plus an end-to-end CLI proof on a fake `.dmg`); `npm run build:macos` wraps `scripts/build-macos.sh`, and `release:manifest`/`release:verify` are wired as npm scripts. The `.app`/`.dmg` build and every native proof still require a macOS machine.

---

## Scopes not to be confused with parity

- **US-28 real-time co-editing**: a disconnected stub, off the critical path. The product need is to be confirmed; do not count it as achieved or as a demonstrated Codex prerequisite.
- **US-13 SSE**: a transport choice, not a user result. No migration work while the current transport meets the criteria.
- **Arbitrary providers, simulated quotas and announced RAG**: ambitions of the original SPEC, not attested Muse capabilities. Do not promise a model list independent of the engine.
- **Proactive multi-service memory**: only local memory and text references exist. It depends on real connectors and a freshness policy; to be specified after M3, not "done" with the local CRUD.
- **US-34 configuration import**: local import exists; faithful migration of engine sessions is unproven. Extend M0-02/M0-09 only after verifying the compatible formats.

## Mapping to the old stories

| Historical stories | New tracking |
|---|---|
| US-1/2/5/10/11/29 | M0-01 to 05, M0-09, M1-09/10/12/13 |
| US-3/30 | M2-01/02; remote sharing split out as M4-06 |
| US-4/31 | M1-11; no conflation of local summary with server fork |
| US-6/7/8 | M2-03 to 08 |
| US-9 | M3-06 to 09 |
| US-12/21 | M1-01/02/07, M4-05; snippets and real files kept separate |
| US-14/15/16/17/22 | M0-05/06 |
| US-18/23 | M1-07/08 |
| US-19 | M4-01 to 05 |
| US-20 | M1-08 and proactive memory to be specified after M3 |
| US-24/25/26 | M3-01 to 05 |
| US-27/28 | M4-06; co-editing off the critical path |
| US-32/33/34 | M0-10/11/12, M0-02/09; M4-09 |
| US-13 | No dedicated work |

## Update rules

1. Every PR cites the IDs concerned and updates **only the platforms actually touched**. A fix to a shared contract does not move macOS or Linux from ☐ to ◐ without native proof.
2. The proof must state **commit, command or scenario, platform and result**. Do not apply a synthetic UI proof to the native engine, nor Linux CI to Linux execution.
3. A ticket only moves to **Done** when all its exit criteria are proved **on the platform concerned**. A partial delivery creates sub-tickets (`M0-01a`, `M0-01b`) with separate criteria; it does not close the parent.
4. To declare a ticket done: real effect, errors and recovery handled, effective permissions, native validation of the scenario and documented limits.
5. Feasibility and product decisions are recorded **before** turning a hypothesis into a commitment. No global percentage until the scope and its weighting are settled.
6. When a ticket depends on Muse host behaviour, the limit is written in the ticket and **the status is not raised** while waiting for a host that exposes the contract or a verified adapter.
