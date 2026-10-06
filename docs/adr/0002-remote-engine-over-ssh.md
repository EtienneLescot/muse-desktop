# ADR 0002 — Run a remote engine over the system ssh

- **Status:** accepted for M4-07
- **Date:** 2026-10-05
- **Context:** M4-07 asks for a conversation that executes on another host. The product decision of 05/10/2026 (Étienne) closes it on a remote **engine** session; the cloud-runner transport becomes its own ticket. The desktop already drives a local `muse serve` over stdio (MSP JSON-RPC), and `remote_ssh.rs` already resolves the system `ssh` binary and rebuilds a charset-checked argv on the Rust side.

## Decision

A remote conversation's host is `muse serve` started on the other machine by the system ssh, in place of the local sidecar (`spawn_sidecar`):

```
ssh -T -a -x -o ClearAllForwardings=yes -o RemoteCommand=none -o ServerAliveInterval=15 -o ServerAliveCountMax=3 [-p <port>] -o BatchMode=yes -o ConnectTimeout=10 [<user>@]<host> -- cd <folder> && exec env MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0 <muse> serve <posture>
```

Its stdio is the MSP stream. The stdout pump, `MspClient`, the two-step handshake, session routing and reconnect run unchanged. The engine starts in the remote folder, as the local sidecar starts in the local one (`current_dir`): the sandbox and the trusted rules are the folder's, not the remote home's. The posture flags are the ones the local spawn uses (`--sandbox-network …`, `--disable-write`, `--disable-shell`, `--trust-workspace`). The default remote binary is the self-updating launcher: `env` turns off its update and its sign-in prompt, as the startup probe does, so neither can start mid-handshake.

- **The target is the workspace key.** A remote conversation is started and stored under `ssh://[user@]host:port/abs/path`, plus `?muse=<binary>` when the binary is not the default `~/.local/bin/muse`. A reconnect needs nothing but the conversation record, and the key can never equal a local root, which is a canonical absolute path. Rust parses and rebuilds the key (`RemoteEngine`); the renderer never supplies an argv.
- **No crypto in the app.** Authentication is the user's OpenSSH: keys, agent, `known_hosts`, `~/.ssh/config`. `BatchMode=yes` means ssh never prompts, so there is no password field anywhere. The command line beats `~/.ssh/config`, so it pins what a host entry must not change for this link: no tty, no agent, X11 or port forwarding, no `RemoteCommand` in place of the engine, the keepalives (checked with `ssh -G`).
- **No shell string built from user input.** Two fields reach the remote login shell: the remote folder (`cd`) and the Muse path. The folder also travels as the session `workspaceRoot` over MSP. Both paths are one plain word: a `/` (or, for the binary, `~/`) prefix, then `[A-Za-z0-9._/-]` only. User and host keep the existing classes, and neither may start with `-`, so `user@host` can never be read as an ssh option.
- **Honest errors.** ssh's stderr is mapped to one sentence: host key unknown or changed (with the exact `ssh -p <port> <user>@<host>` command to run once), authentication refused, connection refused, unresolved name, timeout, remote folder missing, remote Muse missing. Anything else is reported as a handshake failure with the ssh stderr tail. These reach the existing start and reconnect notices; a link that dies mid-session ends the local ssh after three unanswered keepalives (45 s) and is reported as the host exiting. The remote `muse serve` is sshd's to end: it lives until sshd notices the dead link and closes its stdin.
- **Minimal UI.** Settings → *Remote engine* holds one target (user, host, port, Muse path, remote folder) under `muse-desktop.remote-engine.v1`. The new-conversation project picker lists it as `Remote: user@host · folder`.

## Alternatives rejected

- **An SSH library inside the app (libssh2, russh):** key formats, agent protocols and host-key storage to maintain, and a second configuration that drifts from the user's `~/.ssh`.
- **A password prompt or agent forwarding:** both widen what the remote host can do with the user's identity. Batch mode keeps every failure bounded and explicit.
- **A remote command line typed in the form:** ssh hands the command to the remote login shell, where free text is code.
- **Forwarding a remote TCP port to a local MSP client:** MSP is stdio; a port would add a listener on the remote host for no gain.
- **Proxying files, git and the terminal over ssh:** a second remote filesystem protocol, out of scope for M4-07.

## Consequences

- The local machine needs the OpenSSH client (Windows optional feature, present by default on macOS and Linux). The remote host needs Muse installed and a POSIX login shell, which expands `~` and splits the command words.
- **First contact is manual.** The host key must be accepted once from a terminal; the app shows the exact command and never accepts a key itself.
- **The engine version is the remote binary's.** The app does not install, pin or update Muse on the remote host, and the update is off for the session: whatever that binary is, the handshake checks it like any other host.
- **No forwarding.** The remote engine cannot reach other hosts with the user's keys, nor this computer's ports, unless this is added explicitly later. A `~/.ssh/config` entry that forwards for that host does not apply to the engine link.
- **Paths are remote paths.** The folder must be absolute and contain no space or shell character. It is compared with the host's `workspaceRoot` as that host spells it: a path the host canonicalizes differently, through a symlink for instance, makes a reconnect fail closed.
- **Local-only surfaces stand down.** Changes (git), Terminal (local PTY), Files, the `@`-mention scope check and worktrees read this computer's disk: their panels say "Not available for remote conversations", and the native commands refuse with the same sentence (`workspace_for_inspection`). The Browser panel is not tied to a folder and stays. Connectors and computer use are not passed to a remote session: they run on this machine, and the remote engine would try to launch them on its own host.
- **Proof.** Argv construction, key parsing and hostile values are unit-tested on both sides. A real round trip is to be proved against an sshd in WSL on `127.0.0.1:2222`, which is why the port is part of the target.
