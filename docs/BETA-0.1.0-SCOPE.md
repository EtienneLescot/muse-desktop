# Scope of the 0.1.0 beta — Windows

**Goal:** a **convergent** beta. We do not ship what is ready, we ship what is **necessary**, and everything else is explicitly out.

A scope is defined by its exclusions. This document therefore lists **what is in**, measured, and **what is out**, with the reason.

## The entry criterion: the minimum path, verified

`scripts/beta-smoke.mjs`, run against the development build:

| Step | Result |
|---|---|
| Create a conversation | **OK** |
| Composer usable | **OK** |
| Send accepted (composer cleared) | **OK** |
| Turn in progress | **OK** |
| **Model answer received** | **OK** |
| Turn finished | **OK** |
| No error displayed | **OK** |

And persistence, after a **full shutdown of the application and its hosts**, then a relaunch:

| Measurement | Result |
|---|---|
| Stored conversations | **2** — kept |
| Active conversation | kept |
| Projects | `openscreen`, `muse-desktop` — kept |
| **Model answer in the log** | **kept** (2 entries with the marker) |
| Displayed counter | **2** |

**The path a user will take first works, and their work survives a restart.**

## In the beta

| # | Item | Status |
|---|---|---|
| 1 | Launch the app, create a conversation, send a message, get an answer | **verified** |
| 2 | Find conversations and projects again after a restart | **verified** |
| 3 | Install, update and uninstall **without losing projects** | **verified** (`M4-09`) |
| 4 | Secure webview (isolated context, no Node exposed) | verified |
| 5 | English interface, working keyboard navigation | verified (`M0-11`, `M0-12`) |
| 6 | Transcript usable over a long history (bounded window, finder) | verified (`M1-13`) |
| 7 | Windows x64 NSIS installer | built, `NotSigned` |
| 8 | 0.1.0 release notes | to write |

## Out of the beta, with the reason

| Item | Why it is out |
|---|---|
| **Authenticode signing** | needs a certificate and a purchase decision. The installer will show a SmartScreen warning. **Documented in the release notes**, not hidden. |
| **Online automatic updates** | needs hosting that does not exist. **Updating through the installer** is verified and is enough for a beta. |
| **macOS and Linux** | no bundle built, no evidence. Out of scope for a Windows beta. |
| **Screen-reader qualification** | I cannot drive a screen reader. The markup is verified (`M0-12`), the actual announcement is not. |
| **The built-in browser's remaining surface** (region cropping, visual capture) | navigation and annotations work; the two missing functions do not block the main path. |
| **The four client workstreams** from the 20/09 plan | no defect was **reproduced**. Writing them now would be guessing — the mistake this campaign corrected seven times. They stay planned, not in the beta. |
| **Showing `userShell` output in the transcript** | the host **does publish** the item and its output (measured 21/09: `item/started` + `item/completed` of kind `userShell`, marker returned); it is **the client** that does not render it in the thread. A fallback exists (insert the output into the prompt). Annoying, not blocking. |
| **Visual confirmation of model and effort** | the client shows the requested model, marked as not live. Honest, imperfect, not blocking. |
| **`M0-01`, `M0-14`, `M1-10` — uncovered criteria** | these are robustness criteria on edge cases. A beta does not have to cover them all, and the evidence documents say which ones. |

## What still has to be done to ship

1. **Verify the installed package** — launch the **installed** application (not the development build) and replay the minimum path on the NSIS package. That is the difference between "it works on my machine in dev" and "it works for a user".
2. **Release notes** — what works, what does not, the SmartScreen warning, the requirements (Muse Code installed).
3. **Tag and version** — `v0.1.0-beta.1`, consistent across `package.json`, `tauri.conf.json` and the installer name.
4. **Clean up the test conversations** before shipping, so the app does not open on leftovers.

## What is **not** an exit criterion

- No group 1 ticket needs to be **closed**. The beta is judged on the user path, not on a matrix.
- No macOS or Linux evidence.
- No CodeRabbit review: it was rate-limited throughout the campaign, and I am not making it a dependency.

## The main risk, knowingly accepted

**The application is not signed.** Windows will show a SmartScreen warning on first launch. That is normal for a beta, but it has to be **written in the release notes** — a user who meets the warning with no explanation will conclude the software is dubious.

## What the beta does not claim to be

- Not a stable version: recovery after a host crash is not guaranteed in every case.
- Not a complete version: several interface functions exist without being qualified.
- Not a signed version.

**A beta exists to collect feedback on a real path.** This scope is chosen so that path is solid, and so the rest is **stated** rather than discovered.
