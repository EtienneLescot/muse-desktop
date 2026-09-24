# Index of native evidence — Windows campaign of 20 September 2026

The single entry point to the evidence produced by the campaign. Each ticket points to its documents, to **what is proved**, to **what remains**, and to **the command that reproduces the measurement**.

Updated after PR #195 was merged.

## How to read this folder

One folder per subject. **Every document states its own limits**: none presents a single scenario as proof that a ticket is closed.

| Folder | Subject | Documents |
|---|---|---|
| [`2026-09-20-windows-group1/`](2026-09-20-windows-group1/) | M0-03 (sending), M1-10 (queue), general campaign | 8 documents + 29 screenshots |
| [`2026-09-20-windows-ab-projects/`](2026-09-20-windows-ab-projects/) | isolation between two projects — M0-01, M0-14 | 1 |
| [`2026-09-20-windows-browser/`](2026-09-20-windows-browser/) | built-in browser — M4-01, M4-02 | 1 |
| [`2026-09-20-windows-transcript/`](2026-09-20-windows-transcript/) | transcript window, persistence, performance — M1-13 | 7 |
| [`2026-09-20-windows-a11y/`](2026-09-20-windows-a11y/) | accessibility — M0-12 | 1 |
| [`2026-09-20-windows-language/`](2026-09-20-windows-language/) | English copy, navigation, paths — M0-11 | 4 |
| [`2026-09-20-windows-m010/`](2026-09-20-windows-m010/) | first launch and failure guidance — M0-10 | 1 |
| [`2026-09-20-windows-release/`](2026-09-20-windows-release/) | distribution — M4-09 | 3 |
| [`2026-09-20-windows-ledgers/`](2026-09-20-windows-ledgers/) | native mirrors and testability — M3-07, M3-09 | 2 |
| [`2026-09-20-windows-cleanup/`](2026-09-20-windows-cleanup/) | cleaning up test conversations | 1 |

The report addressed to the sidecar maintainer lives outside this folder: [`../SIDECAR-CONTRACT-GAPS.md`](../SIDECAR-CONTRACT-GAPS.md).

## Coverage matrix

| Ticket | Proved | Remaining | Nature of the blocker | Documents |
|---|---|---|---|---|
| **M0-01** | two simultaneous hosts · one host dying with no effect on the other · a turn carried to completion **while** the other died, with no stale | **concurrent approvals** | the host's `promptUnmatched` ceiling — `ask` mode presented no request | [M0-01-M0-14](2026-09-20-windows-ab-projects/M0-01-M0-14.md), [group 1](2026-09-20-windows-group1/README.md) |
| **M0-02** | `ephemeral` announced · host death detected · `Disconnected` + sending blocked + transcript preserved · **honest** resume failure (`sessionNotFound [retryable=false]`) | durable resume of a turn | **sidecar contract**: `session/read` and `session/resume` missing | [group 1](2026-09-20-windows-group1/README.md), [gaps](../SIDECAR-CONTRACT-GAPS.md) |
| **M0-03** | **all 4 criteria**: a rejected send keeps the text · a double Enter = 1 turn · draft and send survive a reload · Enter during an IME composition does not submit | variants: Chinese/Korean IME, reload **before** acknowledgement, **mouse** double-click | method | [rejection](2026-09-20-windows-group1/M0-03-envoi-rejete.md), [double send](2026-09-20-windows-group1/M0-03-double-envoi.md), [reload](2026-09-20-windows-group1/M0-03-rechargement.md), [IME](2026-09-20-windows-group1/M0-03-ime.md) |
| **M0-04** | interrupt displayed (`Stopping…`) · stale state correctly flagged · no false success | **confirmed terminal** | **sidecar contract**: `turn/completed`/`retracted`/`stopped` never emitted | [group 1](2026-09-20-windows-group1/README.md), [gaps](../SIDECAR-CONTRACT-GAPS.md) |
| **M0-10** | failure guidance exercised on a neutralised sidecar: `sidecar`/`binary`/`triple`/`folder`, **Try again**, **Choose workspace folder**, no implicit install | **a clean machine** | infrastructure (WSL, Muse and conversations already present) | [M0-10](2026-09-20-windows-m010/M0-10-guidance-echec.md) |
| **M0-11** | English copy across 7 surfaces and 129 source files · navigation helper wiring **locked by test** · `displayPath()` covered, UNC edge cases included | native tooltip rendering · the `Cmd` branch on a real macOS | infrastructure | [copy](2026-09-20-windows-language/M0-11-copie-anglaise.md), [navigation](2026-09-20-windows-language/M0-11-navigation.md), [paths](2026-09-20-windows-language/M0-11-display-path.md) |
| **M0-12** | `forced-colors` honoured · 24 tab stops with no trap · `Ctrl+F` bound · AA contrast on 60 texts · **one defect fixed** (inert `prefers-contrast`) with a regression test | **a real screen reader** | out of reach | [M0-12](2026-09-20-windows-a11y/M0-12.md) |
| **M0-14** | same as M0-01 | same as M0-01 | same as M0-01 | [M0-01-M0-14](2026-09-20-windows-ab-projects/M0-01-M0-14.md) |
| **M1-06** | `userShell` **negotiated and accepted** | item published, `outputRef`, output readable | **sidecar contract** | [gaps](../SIDECAR-CONTRACT-GAPS.md) |
| **M1-10** | queue admission persisted · **Queued messages** panel ordered · `Stopping…` · queue emptied after Stop · **sequential removal** · **race: removed turns do not start** | exact click count · the host's `turn/unqueue` acknowledgement · one unexplained log anomaly | method + sidecar contract | [removal](2026-09-20-windows-group1/M1-10-retrait-file.md), [race](2026-09-20-windows-group1/M1-10-course-file.md) |
| **M1-11** | `setModel` and `setReasoningEffort` **accepted** | effective projection | **sidecar contract**: `projection: not-reported`, `isActive: false` | [gaps](../SIDECAR-CONTRACT-GAPS.md) |
| **M1-13** | window bounded to **160 articles out of 2,001** · incremental loading of 120 with a constant DOM · finder reaching a **result outside the window** · rendering cost measured · **persistence ceilings locked by test** · **write cost quantified and its frequency observed** | **assistive qualification** · measurements on the development build only | out of reach · infrastructure | [window](2026-09-20-windows-transcript/M1-13.md), [finder](2026-09-20-windows-transcript/finder-hors-fenetre.md), [rendering](2026-09-20-windows-transcript/perf-rendu.md), [ceilings](2026-09-20-windows-transcript/plafonds-persistance.md), [cost](2026-09-20-windows-transcript/cout-ecriture-journal.md), [frequency](2026-09-20-windows-transcript/granularite-ecritures.md) |
| **M3-07** | the run registry's native mirror made **importable by a test** and covered (failure contract, guard order) | a real IPC call · durable writing in the packaged app | out of reach for a node process | [schedule ledger](2026-09-20-windows-ledgers/schedule-ledger-et-garde.md) |
| **M3-09** | the notifications' native mirror covered · **write coalescing** verified | a real IPC call | same | [unreachable modules](2026-09-20-windows-ledgers/modules-inaccessibles-aux-tests.md) |
| **M4-01** | native navigation (iframe mounted) · per-tab persistence · **isolation by `sessionId`** | macOS/Linux qualification · downloads initiated by navigation | infrastructure | [M4-01-M4-02](2026-09-20-windows-browser/M4-01-M4-02.md) |
| **M4-02** | annotation **actually created** (URL anchor, quote, comment) · **context guard** after a domain change | region cropping · visual capture | infrastructure | [M4-01-M4-02](2026-09-20-windows-browser/M4-01-M4-02.md) |
| **M4-09** | NSIS build (SHA-256 verified) · **install and uninstall with no loss** · **update 0.0.9 → 0.1.0 with no loss** · delta chain (~1250× smaller, byte-exact reconstruction) | **a clean machine** · **signing** (`NotSigned`) · MSI · a real rollback | infrastructure | [build](2026-09-20-windows-release/M4-09.md), [cycle](2026-09-20-windows-release/M4-09-cycle-installation.md), [update](2026-09-20-windows-release/M4-09-mise-a-jour.md) |

Tickets **not started** for lack of access: M2 and M3 (apart from M3-07 and M3-09) need a host that exposes the matching contracts; see their lines in [`../ROADMAP.md`](../ROADMAP.md).

## Measurement tools shipped

All under `scripts/`. The `cdp-*` scripts assume the application was launched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`; they enable a WebView2 feature and **do not modify** the application's code.

| Script | Role | Model cost |
|---|---|---|
| `msp-probe.mjs` | describes the host's contract (surfaces, `userShell`, `approval/listPending`) | **none** |
| `native-smoke.mjs` | control, errors, approval, isolation, queue, compaction on two hosts | a few turns |
| `cdp-drive.mjs` | DOM inspection and driving (`snapshot`, `eval`, `click`, `fill`) | none |
| `cdp-panel.mjs` | opens the work bar and exercises the built-in browser | none |
| `cdp-annotate.mjs` | creates an annotation and checks it persists | none |
| `cdp-scenario.mjs` | turn, queue, Stop, stale | one turn |
| `cdp-ab-projects.mjs` | isolation between two projects | one turn |
| `cdp-concurrent-turns.mjs` | concurrent turns | one turn |
| `cdp-unknown-skill-reject.mjs` | deterministic send rejection | none |
| `cdp-double-send.mjs` | double submission | one turn |
| `cdp-reload-mid-send.mjs` | draft and send against a reload | one turn |
| `cdp-ime-compose.mjs` | IME composition | none |
| `cdp-long-transcript.mjs` | bounded window on a fabricated log | none |
| `cdp-scroll-window.mjs` | incremental loading | none |
| `cdp-finder-jump.mjs` | finder to a result outside the window | none |
| `cdp-perf.mjs` | rendering cost and memory | none |
| `cdp-a11y-probe.mjs` | tab order, focus, contrast | none |
| `cdp-contrast-probe.mjs` | emulated `forced-colors` and `prefers-contrast` | none |
| `cdp-focus-pixels.mjs` | focus indicator by pixel comparison | none |
| `cdp-language-audit.mjs` | French copy in the rendered DOM | none |
| `cdp-queue-removal.mjs` | removing a queue entry | one turn |
| `cdp-queue-race.mjs` | queue/removal race | one turn |
| `cdp-stream-granularity.mjs` | number and volume of log writes in a turn | one turn |
| `cdp-delete-conversations.mjs` | deletes test conversations through the application's dialog | none |
| `bench-log-append.mts` | cost of appending to the log by its size | none |

### UX pass 1 (21 September 2026)

| Script | Role | Model cost |
|---|---|---|
| `ux-capture.mjs` | 13 interface surfaces, preconditions asserted | none |
| `ux-force-conversation.mjs` | forces the conversation view and the panel's 8 tabs | none |
| `ux-contrast-audit.mjs` | real WCAG ratios, composited alpha, light or dark theme | none |
| `ux-panel-overflow.mjs` | overflows per tab, **blocking self-test** | none |
| `ux-breakpoint-sweep.mjs` | 13 window widths, shallow **and nested** leaks | none |
| `ux-composer-overflow.mjs` | 11 widths: the composer's control row never clips its model picker | none |
| `ux-computer-use.mjs` | computer use end to end: driver found, levels, bounded activation, **a tool outside the manifest refused by the driver**, MCP entry, revocation | none |
| `ux-review-captures.mjs` | screenshots + structural assertions | none |
| `ux-terminal-contrast.mjs` | WCAG contrast of the controls, active **and** disabled | none |
| `ux-target-size-audit.mjs` | targets < 24×24 px, overflow, elements clipped by an ancestor | none |
| `ux-session-meta-probe.mjs` | the Rust bridge's raw projection (the authority over what is rendered) | none |
| `ux-react-state-probe.mjs` | a React prop read off the fiber, when the DOM and the bridge contradict each other | none |
| `ux-verify-pass2.mjs` | checks the pass 2 decisions against the DOM and by screenshot | none |
| `ux-terminal-state.mjs` | the state of the terminal's actions **and the reason** they are unavailable | none |
| `ux-read-logs.mjs` | transcript read from the hook's state, not from the DOM | none |
| `ux-run-in-muse.mjs` | exercises `Run in Muse`: typing, enabling, clicking, waiting for the item | one shell call |
| `msp-user-shell-items.mjs` | does the host publish `userShell` items? (**capability shape corrected**) | one shell call |
| `msp-user-shell-after-resume.mjs` | `userShell` before and after `session/resume`, on a fresh session | one shell call |
| `ux-rules-scan.mjs` | `rules_scan` on the live bridge: every line checked against the disk, files **unchanged** after reading | none |
| `ux-project-rules.mjs` | the Projects panel: `Instructions` field gone, 4 roles listed, overflow from 1440 to 760 px | none |
| `ux-terminal-precondition.mjs` | walks the conversations and checks none is refused for "session not loaded" | none |
| `ux-legacy-instructions.mjs` | the removed-instructions notice: appearance, Copy/Dismiss, storage emptied — **and restored** | none |
| `check-scripts-parse.mjs` | guard rail: every script in `scripts/` must compile **and** must not close a page-side template with a backtick (self-tested scanner) | none |

**`ux-panel-overflow.mjs` refuses to print a single figure if its self-test fails**: a 300 px probe inside a 100 px box must be reported at +200 px, and the same probe with `overflow-x: hidden` must be ignored. That guard rail exists because three successive versions of this detector produced plausible and false reports — details in [`2026-09-21-ux/debordement-desktop.md`](2026-09-21-ux/debordement-desktop.md).

`ux-review-captures.mjs` carries a warning: it forces the panel's width **without** changing the window's, which produces a state no real window can reach. For responsive layout questions, the instrument is `ux-breakpoint-sweep.mjs`.

## Documents recording a failure or an error

These documents keep a negative result or an error of method. They are deliberately preserved:

| Document | What it records |
|---|---|
| [M0-03-envoi-rejete-inabouti](2026-09-20-windows-group1/M0-03-envoi-rejete-inabouti.md) | first attempt at a rejected send, since replaced |
| [M1-10-retrait-file-inabouti](2026-09-20-windows-group1/M1-10-retrait-file-inabouti.md) | queue never fed — preconditions unverified |
| [finder-hors-fenetre-inabouti](2026-09-20-windows-transcript/finder-hors-fenetre-inabouti.md) | wrong selector: the finder's container instead of its opener |
| [M0-12](2026-09-20-windows-a11y/M0-12.md) | contains the false positive "no focus indicator" **and** its correction |
| [modules-inaccessibles-aux-tests](2026-09-20-windows-ledgers/modules-inaccessibles-aux-tests.md) | initial false diagnosis: 15 modules announced instead of 2 |
| [nettoyage-conversations](2026-09-20-windows-cleanup/nettoyage-conversations.md) | **three** deletion methods that failed before the right one |
| [debordement-desktop](2026-09-21-ux/debordement-desktop.md) | **three** successive instrument bugs, including a silent `NaN` that emptied the report; replaces a version whose every figure was wrong |
| [revue-passe2](2026-09-21-ux/revue-passe2.md) | **four false positives** (two of which I had relayed) and a duplicate hypothesis **disproved by the persisted data** |
| [m1-06-blocage-refute](2026-09-21-ux/m1-06-blocage-refute.md) | a "blocking finding" published against the host, disproved: the probe requested the capability **flat** and therefore never ran the command |
| [m1-06-capacites-au-montage](2026-09-21-ux/m1-06-capacites-au-montage.md) | three sources contradicting each other about the same capability, and the synchronisation defect that explains them |
| [authentification-muse](2026-09-21-ux/authentification-muse.md) | why the editor cannot do OAuth on its own, and how to drive the CLI instead — with the `META_API_KEY` precedence trap |
| [find-bar-flottante](2026-09-21-ux/find-bar-flottante.md) | **two false hypotheses** (transparency, z-index) ruled out by measurement before finding the real cause: a 760 px card in a 1034 px flow |
| [regles-du-dossier](2026-09-21-ux/regles-du-dossier.md) | the client kept its own instructions while the CLI reads rules from the folder; `max` was missing from eight reasoning levels, and `ultra` was described as deeper than `max` |
| [composeur-modele-rogne](2026-09-21-ux/composeur-modele-rogne.md) | a CSS fix that **stopped applying** when the button became a `<details>`; and a closed `<details>` whose content keeps a rectangle, producing a false 200 px overflow at every width |
| [alignement-cli-projet-dossier](2026-09-21-ux/alignement-cli-projet-dossier.md) | a missing `--trust-workspace` left the folder's rules silent **with no error**; the decision to write our instructions into `AGENTS.md` was taken and then **withdrawn** (the file belongs to the user) |

## Campaign errors of method, documented rather than quietly fixed

1. **Focus indicator**: concluded absent by framing only the `TEXTAREA`. The ring is on the container.
2. **`prefers-contrast`**: first attributed to specificity, a fix attempted, **failed**, the fix withdrawn, the diagnosis corrected, the real hypothesis tested **outside the repository** before being applied.
3. **Transcript entry order**: `streamWindowStart` is an offset from the end, so an "outside the window" marker was in fact **inside** it.
4. **Tautological assertion on Windows**: `pathToFileURL(url.pathname).pathname` differs from `url.pathname` (a double slash), which failed 92 tests for nothing.
5. **Wrong test, not wrong code**: `createLatestWriteQueue` deliberately coalesces writes; my assertion expected the opposite.
6. **`returnByValue` forgotten** on `Runtime.evaluate`: returns a remote reference, hence `undefined`, indistinguishable from a failure.
7. **Test cycles with no initial-state check**: four tests failed for want of confirming the starting state or the conversation's identity.
8. **Unverified "clean conversation" capture**: the predicate counted `.message`/`.log-entry`/`[data-role]`, which exist nowhere in the real DOM — the transcript row class is `.msg`. The count was therefore **always 0**, and three captures of the **Library** page were recorded as "clean conversation" with a null `conversationOpen`. The selector is fixed, and the script now **refuses** to write the capture when the transcript is empty. The `check-scripts-parse.mjs` guard rail additionally detects the *balanced* form of the backtick trap, the one `node --check` lets through: that is what produced this bug, a comment containing `.msg` between backticks inside the page-side template.
9. **cp1252 mojibake in eight source files** — the most expensive tooling error of this campaign, and the only one that reached the interface. Rewriting a UTF-8 file with `Get-Content -Raw` (PowerShell decodes as ANSI) then `[System.IO.File]::WriteAllText` turns every non-ASCII character into a lead byte followed by the cp1252 character: the em dash, the ellipsis, the arrow and Attach's "＋" became unreadable **inside the application**, and 126 lines across eight files were damaged by successive rewrites. Visible symptom: "Describe what you want to buildÃ¢â‚¬Â¦" and "Ã¯Â¼Â‹ Attach".
   - **Repair**: the inverse transformation (cp1252 bytes → UTF-8), applied **line by line** with the number of passes chosen by what actually erases the markers — the damage was not uniform (a file rewritten twice shows `ÃƒÆ'Ã‚Â¢`).
   - **Permanent losses**: two glyphs whose last byte (0x90, 0x9D) does not exist in cp1252 — the arrow `←` and the closing quote `”` — were restored by hand.
   - **Guard rail**: `test/encoding.test.ts` refuses any source file containing a lead byte followed by a non-ASCII character, with fixtures written as escapes so the test never contains what it forbids.
   - **Rule**: never rewrite a source file with a tool that does not explicitly read UTF-8. That is also what produced the two `cdp-*.mjs` files already damaged before this session.

## What this campaign did not do

- **No macOS or Linux evidence**, for any ticket.
- **No qualification with a real screen reader.**
- **No test on a clean machine**: the test machine already has WSL, Muse and conversations.
- **No signed installation**: both installers are `NotSigned`.
- **No test of the M2 and M3 contracts** (worktrees, MCP, scheduler, notifications) beyond the two ledgers.
- **No product fix** apart from the `prefers-contrast` defect: this campaign measures and documents, it does not refactor.
