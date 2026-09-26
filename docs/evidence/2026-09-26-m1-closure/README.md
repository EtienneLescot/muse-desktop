# M1 closure campaign — native Windows (26 September 2026)

**Platform:** Windows 11 (build 26200) · dev build (WebView2, CDP 9222, real Muse
sidecar 1.3.0) for every dev criterion, and the packaged NSIS 0.1.0 install
(`C:\Users\etien\AppData\Local\Muse-Desktop\`, installed foreground at 13:4x)
for the packaged-webview criteria. Live model turns wherever a turn was needed.
Every repository-level claim was verified with the **real `git` binary**, not
the UI.

**Objective:** drive every remaining Windows-reachable M1 criterion. macOS/Linux
stay structurally out of reach (no native machine) — nothing was raised on
those columns.

## Results

| Ticket | Scenario | Result |
|---|---|---|
| **M1-05** | terminal geometry, manual width, shortcuts, REPL (`m1-05-terminal-native.json`) | **Windows closed** — `mode con` follows the pane (51×27 → 68×38 window resize → 78×38 via the + button → 51×27 back); the manual width **survives observer re-notifications** (the 25/09 fix replay) and **lifts on a real pane move**; Tab completion echoes the completed name; Escape discards the line; Ctrl+L reaches the PTY as the ConPTY repaint (26 newline flood on a 27-row PTY); the **node REPL** starts, evaluates `1+1 → 2`, exits on Ctrl+D back to the `G:\repos\openscreen>` prompt (cwd binding proved in the same shot). Ctrl+C's synthetic-key attempt does not interrupt a child (the 27/09 run5 real-keyboard proof stands; the shortcut path itself is exercised). |
| **M1-06** | Add output to prompt (`m1-06-add-output-prompt.json`) | **Windows closed** — `echo MARKER` → panel button → the composer draft carries the bounded `[Terminal output · …]` block with provenance; a 2500-line (~44 k chars) output lands as a **12,001-character block, tail kept** (the 12 k fallback bound). |
| **M1-11** | model label per conversation + context usage (`m1-11-model-context.json`, `m1-11-context-trigger.json`) | **Windows closed** — A shows its own model while B switches to another; back to A the label is still A's; B keeps the switched model across the round trip (the 25/09 fix replay). Context usage: a 28,757-char turn makes the host emit `context_usage` and the meter renders **"Context 6% used"** with the popover ("Context window", pressure copy). |
| **M1-01→04** | git review end-to-end on a scratch repo (`m1-01-04-git-native.json`) | **M1-01/02/03 Windows closed; M1-04 one piece open** — snapshot lists the files changed during a controlled turn (`config.properties` + `notes.txt`); the office file shows git's binary marker in the diff view; an 802-row status renders with the true count; stage/unstage by file (`M ` / ` M` verified in porcelain), **partial hunk staging** (1 hunk staged + 1 left unstaged via Unstage hunk), discard reverts content after the inline confirm, **untracked files survive** every discard path; a diff-line comment reaches the **live engine** (turn starts, answer streams) and a queued comment persists (`ready` + `sent` items); commit lands (`qualif: gamma clarifier change`), push writes `refs/heads/master` on the bare remote, Fetch reports the advance and **Pull latest fast-forwards HEAD** (`60406fc4 → 8a15aaa8`); a forbidden remote surfaces a clean actionable error (`Repository not found`). **Still open (M1-04):** the live PR round trip through `gh` needs a disposable GitHub remote — not creatable from here. |
| **M1-07** | files browser (`m1-07-09-files-fork.json`, M1-07 half) | **Windows closed** — text preview from disk + Add to prompt with provenance; the office file stays out of the text preview ("could not be safely previewed"); a 550-entry folder lists the first **200 with the explicit note**; an on-disk rename appears after refresh (`aaa-renamed.txt` in, `f-0000.txt` gone); deleting the browsed folder on disk yields a bounded error (`cannot resolve workspace path bulk: … os error 2`) and **Up** recovers. |
| **M1-08** | attachments (`m1-08-attachments.json`, `m1-08-single-image.json`) | **Windows closed, one defect recorded** — 8 PNGs attach as 8 chips; a 9th file is refused by the UI ("You can attach up to 8 files."); an 8-image + text send is rejected at the wire with `inputParts cannot contain more than 8 parts`, text preserved, Retry/Discard outbox intact (M0-03). **Defect (minor):** the UI counts *files* (8) while the wire counts *parts* (text + 8 = 9) — the two bounds disagree; recorded, not fixed. A **single real image rides a live turn**: the model answers about the pixel's colour ("grey"). |
| **M1-09** | faithful fork (`m1-07-09-files-fork.json`, M1-09 half) | **Partial — host-blocked piece identified precisely** — forking an anchor whose seed the host no longer holds shows the **explicit recovery copy** ("That turn is no longer available on the host…") without a crash (a listed criterion ✓); the app stays alive and actionable. The creation itself is refused by **host 1.3.0 on every anchor, a fresh two-turn session included**: raw error captured via a direct `fork_session` IPC call — `MSP error -32023: invalid fork boundary … WriteFailed [forkBoundaryInvalid] [retryable=false]`. Correlation: every session now carries `Reminder child session` sub-agent lanes, and the documented host limit is fork-seed materialization on sub-agent sessions. The 20/09 fresh one-turn fork proof stands; the supervisor side has nothing to fix. Added to the upstream blockers memo. |
| **M1-10** | queue removal race in the **packaged** webview (`m1-10-packaged-queue-race.json`) | **Windows closed** — two turns queued while the first ran; both removed mid-flight (2 clicks); the queue emptied **while the first turn was still running**; neither removed turn ever answered (no ALPHA/BETA in the settled transcript); the first turn carried to completion. |
| **M1-13** | 2,000-entry measurement in the **packaged** webview (`m1-13-packaged-2000.json`) | **Measured** — 2,000 persisted entries: the window mounts **160 articles (1720→1880)**, 1,368 nodes, `aria-setsize 2000` / `aria-posinset` present, Load-older and Latest available, keyboard hints on the region; the original log restored byte-identical afterwards. The finder did not mount in that synthetic view (`hasFinder: false`) — its jump was proved in dev earlier. Assistive qualification stays resource-blocked (M0-12). |

## Packaging notes (the traps, so they are not repeated)

1. **The silent `/S` install hung twice** and once completed *without replacing*
   the app (same-version skip): the reliable path is uninstall/clean the folder,
   then ONE foreground `start /wait … /S` install. Always verify the installed
   exe — here `hash(installed) ≠ hash(target/release/muse-desktop.exe)` even
   after a clean install (the tauri NSIS step stamps `target/release` after
   packaging, so the bundle carries the pre-stamp binary). Identity was
   therefore verified by a **UI marker**: the `.connection-notice` stylesheet
   rule exists only at HEAD, and the packaged webview ships it.
2. **The packaged app auto-opens the last active conversation**, which its
   freshly spawned host has NOT loaded — sends answer `sessionNotLoaded`
   (`-32024`, the listed-vs-loaded distinction from M1-06). Queue/send harnesses
   must run on a conversation the packaged host actually loaded (a fresh
   conversation works).
3. The shared WebView2 profile carries `muse-desktop.workspace.v1`; a corrupted
   value (`G: eposopenscreen`, the M0 escape artifact) resurfaced once and was
   re-planted with the `String.fromCharCode(92)` join before packaged runs.

## Campaign defects & limits recorded

- M1-08 UI-vs-wire parts bound mismatch (above).
- M1-09 host fork refusal (above) — upstream draft updated.
- M1-04's live PR round trip needs a disposable GitHub remote.
- Ctrl+C's interrupt is proved with a real keyboard (27/09); the CDP synthetic
  key path cannot reproduce the ConPTY interrupt behaviour — the harness
  records the attempt honestly instead of claiming a pass.

## Reproducibility

```
npm run build && cargo build --manifest-path src-tauri/Cargo.toml
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/debug/muse-desktop.exe
node scripts/cdp-m1-terminal.mjs --out docs/evidence/2026-09-26-m1-closure/m1-05-terminal-native.json
node scripts/cdp-m1-06-add-output.mjs --out docs/evidence/2026-09-26-m1-closure/m1-06-add-output-prompt.json
node scripts/cdp-m1-11-model-context.mjs --out docs/evidence/2026-09-26-m1-closure/m1-11-model-context.json
node scripts/cdp-m1-11-context-trigger.mjs --out docs/evidence/2026-09-26-m1-closure/m1-11-context-trigger.json
node scripts/cdp-m1-git.mjs --out docs/evidence/2026-09-26-m1-closure/m1-01-04-git-native.json
node scripts/cdp-m1-files-fork.mjs --out docs/evidence/2026-09-26-m1-closure/m1-07-09-files-fork.json
node scripts/cdp-m1-08-attachments.mjs --out docs/evidence/2026-09-26-m1-closure/m1-08-attachments.json
node scripts/cdp-m1-08-single-image.mjs --out docs/evidence/2026-09-26-m1-closure/m1-08-single-image.json
# packaged-webview criteria: install the NSIS build, verify identity, launch with CDP:
node scripts/cdp-long-transcript.mjs --entries 2000
node scripts/cdp-m1-10-packaged-race.mjs
```

The git suite resets `G:\repos\m1-qualification` (scratch) on every run; the
fork harness creates live turns in that workspace; nothing outside the scratch
repo and the packaged app's own profile is touched.
