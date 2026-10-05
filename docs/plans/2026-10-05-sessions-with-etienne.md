# What only Étienne can unblock — 5 October 2026

Everything below needs a person, a device or an outward-facing decision. The agent-reachable work
of the [closure audit](2026-10-05-roadmap-closure-audit.md) runs without it.

## Decisions

| # | Decision | Why it matters | Default if no answer |
|---|---|---|---|
| D1 | **Windows workspace isolation is broken on native Muse 1.4.2.** Under `--sandbox-network restricted` the model's shell tool cannot write a file, even inside the root and after approval; network stays blocked. `--disable-sandbox` works. Evidence: [`m0-06-verdict-matrix-1.4.2.json`](../evidence/2026-10-05-roadmap-closure/m0-06-verdict-matrix-1.4.2.json). Options: keep the default and say so in Settings, or default Windows-native projects to the elevated posture until upstream fixes it. | With the default posture, the model cannot change files on Windows native. | Keep the default and state the limit in the UI. |
| D2 | **Upstream posts** (public, under your account): reply to #56 with the 1.4.2 approval measurements, a new issue for the D1 sandbox write defect, and a link from #55 to #31 (the fork defect is still present on 1.4.2). | The maintainer asked for the 1.4.2 re-test on 02/10. | Drafts kept in `docs/upstream/`, nothing posted. |
| D3 | **Release:** v0.2.0 was never published (release run 36792792297: the engine draft is no longer found by tag, and the macOS cargo test was red). Options: cut 0.2.1 once CI is green and Codex's installer qualification lands, or retag. | The 0.2.0 notes promise a notarised DMG that does not exist. | Nothing published. |
| D4 | **Label "Approve on my behalf":** since 05/10 the app approves nothing itself; the engine simply does not ask inside the isolation. Rename (e.g. "Ask only for more access")? | The label describes a behaviour that no longer exists. | Keep it. |

## Windows session with you (about 1 h, one sitting)

1. **Screen reader, M0-12 and M1-13 (20 min).** NVDA 2026.2 portable is ready on `G:\muse-proofs\nvda\portable` (signed NV Access, SHA-1 checked). NVDA takes the keyboard and the audio: the agent starts it with a logged silent voice, drives the app over CDP, and records every spoken phrase. You only need to say "go" and not type meanwhile.
2. **Voice, M4-08 (10 min).** You dictate a sentence through the Logitech headset, interrupt mid-sentence, edit before sending. Per the 05/10 decision, audio goes to Microsoft's speech service.
3. **Second device, M4-06 (5 min).** The share server runs on this PC's LAN address. You open the published link on your phone, then again after revoke: it must give the 404.
4. **Sleep and lock, M3-07 (20 min).** A "Once" automation is set a few minutes ahead. You lock the session (Win+L), then put the PC to sleep, and wake it after the time. Then you move the clock forward one hour and back. The agent may not change system settings.
5. **Expired token, M3-02 (5 min, optional).** It needs a bearer-protected MCP endpoint and a token you create, for example a GitHub PAT for the GitHub MCP server.

## Infrastructure you own

- **M0-10, clean machine:** a Windows VM or a second PC with no WSL, no Muse and no history, plus a real sign-in.
- **M4-07, separate host:** the remote-engine proof runs against an sshd in the WSL2 VM on this PC. A real separate machine needs one of your hosts (one of the two non-GitHub entries in your `known_hosts`, or a Tailscale device).
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
