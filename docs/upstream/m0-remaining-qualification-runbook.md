# M0 remaining qualification runbook — ready to execute when resources arrive

Written **26 September 2026**. Everything runnable on the Windows machine has been
run (dev + packaged NSIS; see
[`docs/evidence/2026-09-25-m0-completion/`](../evidence/2026-09-25-m0-completion/README.md)).
This page is the mechanical checklist for the four remaining resource-dependent
campaigns, so each becomes a half-day session rather than an investigation.

## 1. macOS session (unblocks the macOS column of every M0 ticket)

Important: the CDP harness (`scripts/cdp-*.mjs`) is WebView2-only. On macOS the
scenarios run **manually** through Safari's Web Inspector (Develop ▸ machine ▸
`com.muse.desktop`) for DOM reads, or purely visually. Build with
`sh scripts/build-macos.sh --bundle all` (the engine installs on first launch —
that path is itself part of M0-10 on macOS).

| # | Scenario (in order) | Ticket | Evidence to record |
|---|---|---|---|
| 1 | First launch: install CLI when offered, pick a folder | M0-10 | guidance copy, probe panel |
| 2 | Create → send → stream → **Stop** → follow-up | M0-04 | `Stopping…` resolves, relaunch works |
| 3 | Type a draft, kill the app (`kill -9`), relaunch | M0-02 | draft restored from durable storage |
| 4 | Send `/definitelynotaskill …` | M0-07 | structured error, text preserved |
| 5 | Posture Ask → change → quit → relaunch | M0-06 | applied live, persisted |
| 6 | Two projects, concurrent turns in both | M0-01/M0-14 | both complete, isolation intact |
| 7 | Corrupt `muse-desktop.projects.v1` in localStorage, reload | M0-09 | no clobber, warning panel |
| 8 | Language audit checklist (§ labels) | M0-11 | chrome English |
| 9 | Keychain: remote MCP token saved/revoked | M3-02 (adjacent) | token in Keychain Access |

## 2. Clean machine / VM (M0-10)

A Windows VM (or a fresh local user) with **no Muse, no WSL, no repo checkout**:

1. Install the 0.1.0 NSIS bundle silently, first launch.
2. Record every guidance state: no CLI → offer install; `muse sandbox windows
   setup` elevation prompt; auth sign-in.
3. Complete one real turn. Evidence: screenshots of each guidance panel.
4. Repeat once with WSL present but no CLI (the "non-default WSL" branch).

## 3. NVDA session (M0-12, Windows half)

One hour, NVDA default settings, on the packaged app:

1. Tab through the full composer → verify every control is announced with role
   and label (composer, model picker, effort, posture, Stop).
2. Run the stop scenario listening to announcements: "Stopping…" then "Ready".
3. Verify the transcript stream announces new messages (aria-live) without
   re-reading the whole log.
4. Verify the finder (Ctrl+F) is usable keyboard-only with announcements.
5. Record: NVDA speech log + notes; any control announced as "button" without
   label is a defect to fix before the ticket can close.

## 4. Older engine builds (M0-08)

For each available prior Muse CLI build: run the startup handshake probe
(`scripts/msp-probe.mjs`) and the app against it; record accept/refuse copy.
One row per version in the evidence folder closes the matrix.

## Status rule reminder

No column moves until its scenario is executed **and** the evidence file exists
in `docs/evidence/` naming commit, build (dev or packaged), platform and result
— per the roadmap update rules.
