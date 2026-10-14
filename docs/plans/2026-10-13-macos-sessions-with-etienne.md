# What only Étienne can unblock on macOS — 13 October 2026

The macOS campaign of 13/10 proved natively everything an agent can reach on this Mac (macOS 26.5,
Apple Silicon, pinned engine `1.4.2-R4684.1`); evidence is in
[`docs/evidence/2026-10-13-macos-closure/`](../evidence/2026-10-13-macos-closure/). What is below
needs a person, a system permission, a second machine or a device. Nothing here is simulated: each
ticket stays ◐ on macOS until its step is done. Model of the Windows list of
[5 October](2026-10-05-sessions-with-etienne.md).

## Decisions — resolved on 13/10/2026

| # | Question | Outcome (Étienne) |
|---|---|---|
| D5 | **Engine.** The installed launcher ran 1.3.0-R3401.1. | **Pin 1.4.2 beside it** (`scripts/macos/pin-engine.sh`, `~/muse-proofs/engine/1.4.2-R4684.1/`); the launcher and its `.muse-version` are untouched. |
| D6 | **macOS harness.** WKWebView has no CDP. | **Test mode on macOS debug builds and a WKWebView bridge** (ADR [0003](../adr/0003-webview-e2e-driver.md), amendment of 13/10). |
| D7 | **macOS code defects** found by the proofs (M0-06 text, M0-11 zoom and hint, M1-05 locale and substitutions, M1-07 bounded listing, M2-04 cancel). | **Fix them now**, release **0.4.0** (`3196ce2`). |
| D8 | **Shared defects** that also weaken Windows ☑ (M2-03 rollback, M2-06 cleanup intent, M2-07 sub-agent lanes on 1.4.2, M4-05 DOCX attachment). | **◐ on macOS, flagged on Windows**, not fixed in this campaign. |
| D9 | **M1-04, a real PR.** | **Done with `gh`** on the disposable private repository `EtienneLescot/m1-qualif-pr` (PR #2, closed, branch deleted). |
| D10 | **M4-09, update over 0.3.0.** | **Overwrite the installed app** on this Mac (Étienne: "tu peux écraser"). |

## Session on this Mac (about 2 h 30, when you say so)

The agent drives an isolated test instance through its bridge, or the installed app. You act only
where a system prompt, your voice, your hands or your accounts are needed.

| # | Time | Tickets | Steps |
|---|---|---|---|
| 1 | 20 min | M0-12, M1-13 | **VoiceOver.** In VoiceOver Utility, allow VoiceOver to be controlled with AppleScript (the agent may not change it). Turn VoiceOver on (Cmd+F5), then don't type. The agent drives a test instance and reads each spoken phrase through AppleScript: Tab to the composer, the Stop and Ready announcements, Cmd+F. Then Increase Contrast, Reduce Motion and 200 % zoom. |
| 2 | 2 min | M0-03 | **IME.** Add a Japanese input source. In the composer, type にほんご and confirm the candidate with Enter: the message must not be sent. The bridge has no IME composition, and the composer only reads `isComposing`, which WebKit may clear before that Enter. |
| 3 | 10 min | M4-08 | **Voice**, on the installed 0.4.0. It carries the microphone and speech usage keys; the debug build does not. Allow the Microphone and Speech Recognition prompts. Dictate a sentence, interrupt it halfway, edit it before sending. On macOS, WebKit's recognition goes to Apple's speech service; the UI only says "system speech service" (backlog). |
| 4 | 5 min | M3-09 | **Notifications**, on the installed app. Enable them in Settings, answer the system prompt, then a "Once" automation must bring its notification with the run's result. |
| 5 | 25 min | M3-06, M3-07 | **`launchd` wake, sleep, lock, clock**, on the installed app. This step writes `~/Library/LaunchAgents/com.muse.desktop.automation-wake.plist`: it is your user configuration, so it needs your yes.<br>• A "Once" automation at +3 min, then Cmd+Q. Check the plist and `launchctl print gui/$(id -u)/com.muse.desktop.automation-wake`; the app relaunches and the run completes.<br>• A "Once" at +4 min, then `pmset sleepnow`; wake it after that time and the run fires.<br>• Lock the session (Ctrl+Cmd+Q).<br>• Move the clock one hour forward, then back. |
| 6 | 20 min | M4-04, M0-13 | **Computer use "Observe and act"**. CuaDriver 0.28.2 already holds Accessibility and Screen Recording on this Mac. The agent sets a test instance to Observe and act (its own socket since `df57377`), then runs one real act turn on Calculator:<br>• an action that changes it;<br>• a refused permission;<br>• its window closed meanwhile;<br>• you taking the mouse back;<br>• no action after Stop.<br>Hands off unless asked. |
| 7 | 10 min | M4-09, M0-01 | **First launch from a quarantined download.** Open the 0.4.0 DMG downloaded by a browser, drag it to Applications, first launch: Gatekeeper's "downloaded from the Internet" box only, no warning. The agent's install copies from a CLI download, which carries no quarantine. Then the A/B scenario of M0-01 in the packaged app (the bridge does not drive a release build). The real turn in the installed app was done on 14/10 by the agent, with Étienne's grant ([`m4-09-dmg-real-turn-macos.json`](../evidence/2026-10-13-macos-closure/m4-09-dmg-real-turn-macos.json)). |
| 8 | 20 min | M0-10 | **Clean Mac.** A new standard macOS account (admin rights needed), with no Muse and no history. In it: Install CLI, the Meta device-code sign-in, a folder in ~/Documents (TCC prompt), a first turn. |
| 9 | 10 min, optional | M4-03 | **Your own browser.** The attach switch on your real Chrome or Edge profile, including Chrome's per-profile remote-debugging consent page. The proof used a Chrome started on a temporary profile. |
| 10 | 5 min, optional | M1-08, M0-09 | **Native panels.** Pick a file in the macOS open panel and drop one from the Finder. The proofs fed files through the page. |
| 11 | 5 min | M4-06 | **Second device.** Open the published share link from your phone, then again after Revoke: it must answer 404. Also check that the installed app may publish over plain HTTP to a LAN address: App Transport Security is not exercised by the debug build. |

## Infrastructure you own

- **M0-10:** a clean macOS account or a second Mac (step 8).
- **M4-07 (optional):** a separate SSH host. The macOS proof used an `sshd` started by the user on
  127.0.0.1, with its own keys and no change to `~/.ssh` or Remote Login, under the same limit as
  Windows.
