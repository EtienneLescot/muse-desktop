# What only Étienne can unblock — 5 October 2026, updated 6 October

Everything below needs a person, a device or an outward-facing decision. The agent-reachable work
of the [closure audit](2026-10-05-roadmap-closure-audit.md) runs without it. The four decisions are
resolved. The Windows session happens when you say so (decision of 06/10).

## Decisions — resolved on 05/10/2026

| # | Question | Outcome (Étienne) |
|---|---|---|
| D1 | **Windows workspace isolation on native Muse 1.4.2.** Under `--sandbox-network restricted` the model's shell tool could not write a file inside the root. Keep the default and say so in Settings, or default Windows-native projects to the elevated posture? Evidence: [`m0-06-verdict-matrix-1.4.2.json`](../evidence/2026-10-05-roadmap-closure/m0-06-verdict-matrix-1.4.2.json). | **Resolved: keep the default workspace isolation and document the limit.** The cause is narrower than feared: the sandboxed PowerShell starts in a verbatim `\\?\` folder, so cmdlets with relative paths fail. Absolute paths, `write_file` and `--disable-sandbox` work. Settings states it; upstream [#88](https://github.com/meta-models/muse-code-sdk/issues/88). |
| D2 | **Upstream posts** (public, under your account): the 1.4.2 re-test on #56, the D1 defect, a link from #55 to #31. | **Resolved: post.** On 05/10: #56 answered (the maintainer closed it: fixed in 1.4.0 and later), #55 linked to #31, #88 filed. On 06/10, with relevant findings posted in your name: #57 commented, #91, #92, #93 and #94 filed. Detail in [`docs/upstream/issues/`](../upstream/issues/README.md). |
| D3 | **Release:** v0.2.0 was never published. Cut 0.2.1 once CI is green and Codex's installer qualification lands, or retag? | **Resolved: nothing is published for now.** Codex qualifies the 0.2.0 installer. |
| D4 | **Label "Approve on my behalf":** the app approves nothing itself; the engine simply does not ask inside the isolation. Rename it? | **Resolved: renamed "Ask only for more access".** Settings and the composer show it since 05/10 ([`m0-05-06-approvals.json`](../evidence/2026-10-05-roadmap-closure/m0-05-06-approvals.json), phase `texts-final`). |

## Windows session with you (about 1 h 15, when you say so)

1. **Screen reader, M0-12 and M1-13 (20 min).** NVDA 2026.2 portable is ready on `G:\muse-proofs\nvda\portable` (signed NV Access, SHA-1 checked). NVDA takes the keyboard and the audio: the agent starts it with a logged silent voice, drives the app over CDP, and records every spoken phrase. You only need to say "go" and not type meanwhile.
2. **Voice, M4-08 (10 min).** You dictate a sentence through the Logitech headset, interrupt mid-sentence, edit before sending. Per the 05/10 decision, audio goes to Microsoft's speech service.
3. **Second device, M4-06 (5 min).** The share server runs on this PC's LAN address. You open the published link on your phone, then again after revoke: it must give the 404.
4. **Sleep, lock and clock change, M3-07 (20 min).** A "Once" automation is set a few minutes ahead. You lock the session (Win+L), then put the PC to sleep, and wake it after the time. Then you move the clock forward one hour and back. The agent may not change system settings.
5. **Computer use "Observe and act", M0-13 and M4-04 (20 min).** The agent sets an isolated test instance to "Observe and act" and checks that its service starts on its own pipe. Then one real act turn on a test application: an action that changes it, a refused permission, its window closed meanwhile, you taking the mouse back, and no action after Stop. You watch, hands off unless asked.

The M3-02 expired-token item is no longer needed: it was proved on 06/10 against a local bearer-protected server ([`m3-02-remote-mcp-token.json`](../evidence/2026-10-05-roadmap-closure/m3-02-remote-mcp-token.json)).

## Infrastructure you own

- **M0-10, clean machine:** a Windows VM or a second PC with no WSL, no Muse and no history, plus a real sign-in. This PC runs Windows Home, which has no Windows Sandbox.
- **M4-07, separate host (optional):** M4-07 closed on 06/10 against an sshd in the WSL2 VM on this PC, with that limit stated. A real separate machine needs one of your hosts (one of the two non-GitHub entries in your `known_hosts`, or a Tailscale device).
- **Housekeeping:** in WSL, `~/.ssh/id_ed25519_etiennelescot.fr` is owned by root with mode 0644. ssh refuses such a key. Fix with `chown etienne: … && chmod 600 …`.

## macOS session (about 3 h 20, on your Mac)

Evidence goes to `docs/evidence/2026-10-xx-macos/`: screenshots and shell output, with commit,
build, `sw_vers` and result. The CDP harnesses do not work on WKWebView. Safari Web Inspector needs
a dev/debug build, since the release build has no `devtools` feature.

| # | Time | Tickets | Steps |
|---|---|---|---|
| 0 | 15 min | M0-14 | `sw_vers; uname -m`, `git pull`, `npm ci && npm test && cargo test --manifest-path src-tauri/Cargo.toml`, `sh scripts/build-macos.sh --bundle all` |
| 1 | 10 min | M4-09 | Mount the DMG, drag to Applications, `spctl -a -vv /Applications/Muse-Desktop.app`, first launch with no warning |
| 2 | 20 min | M0-10 | In a fresh macOS account: Install CLI, device-code sign-in, folder in ~/Documents (TCC prompt), first turn |
| 3 | 15 min | M0-04 / M0-03 / M0-07 | Turn, then Stop, then relaunch; `/definitelynotaskill`; double Enter |
| 4 | 10 min | M0-02 | Draft and turn in flight, `kill -9` the app, relaunch: draft and threads intact |
| 5 | 15 min | M0-01 | Two projects, concurrent turns, `kill -9` B's `muse serve`: A completes |
| 6 | 10 min | M1-05 / M1-06 | zsh in the cwd, python3 REPL, Ctrl+C on ping, ANSI, `stty size` after resize, `echo é€😀`, Add output to prompt, no orphan |
| 7 | 10 min | M3-02 | Remote connector with a dummy token, `security find-generic-password -s com.muse.desktop.mcp`, relaunch, Forget token: entry gone |
| 8 | 25 min | M3-06 / M3-07 / M3-09 | Enable notifications (prompt shown). Once at +3 min then Cmd+Q: `~/Library/LaunchAgents` plist and `launchctl print gui/$(id -u)/com.muse.desktop.automation-wake`, app relaunches, run completes, notification arrives. Once at +4 min then `pmset sleepnow`, wake after the time: the run fires. App open but hidden: measure the App Nap delay |
| 9 | 20 min | M4-04 | Install cua-driver, grant Accessibility and Screen Recording to CuaDriver.app, Observe level, `get_screen_size` turn, click refused, Revoke, `pgrep -fl cua-driver` empty |
| 10 | 20 min | M0-12 / M1-13 | VoiceOver (Cmd+F5): Tab to the composer, Stop/Ready announcements, Cmd+F. Increase Contrast, Reduce Motion, 200 % zoom |
| 11 | 10 min | M4-08 | Voice with the built-in mic: dictation, interruption, edit before send (needs the 05/10 Info.plist and entitlement fix in the build) |
| 12 | 15 min, optional | M4-03 | Attach toggle, Chrome or Edge, a turn that reads the tab title |
| 13 | 10 min | M4-09 | DMG N+1 over it: data identical in `~/Library/Application Support/com.muse.desktop` and `~/Library/WebKit/com.muse.desktop`; app to the Bin: data kept |

Only you can do these steps on the Mac:
- WKWebView rendering;
- the CLI install and Meta sign-in;
- the Keychain, TCC and Notification prompts;
- the launchd wake with the app closed, sleep and lock;
- VoiceOver;
- dictation;
- model turns on your account;
- DMG install, update and uninstall.
