<div align="center">

# Muse-Desktop

**The desktop app Muse Code was missing.**

[![Release](https://img.shields.io/github/v/release/EtienneLescot/muse-desktop?style=flat-square&color=0b7285&label=release)](https://github.com/EtienneLescot/muse-desktop/releases/latest)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows-495057?style=flat-square)](#install)
[![License](https://img.shields.io/badge/license-MIT-495057?style=flat-square)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20%C2%B7%20React-495057?style=flat-square)](https://tauri.app)

</div>

![Muse-Desktop on Windows](assets/screenshot-windows.png)

Muse Code is Meta's coding agent, and it ships as a CLI. Muse-Desktop is the harness that
goes with it: the kind of client Claude Code and Codex users take for granted, built for
Muse. Projects, git worktrees, subagents, MCP, a diff review panel. And an agent that can
see your screen and use your applications.

> **0.1.0 · macOS (Apple Silicon) and Windows x64.**
> [Download the latest release](https://github.com/EtienneLescot/muse-desktop/releases/latest).
> The macOS DMG is signed and notarised. The Windows installer is not signed yet.

## What it does

**Let the agent use your computer.** Turn it on and Muse can look at your screen and work
in your applications: open a file, fill a form, click through a tool that has no API.
Two levels of access, and it starts at neither:

| Level | What Muse may do |
|---|---|
| **Off** | Nothing. This is the default. |
| **Observe only** | Take screenshots, read windows. No clicks, no typing. |
| **Observe and act** | Mouse, keyboard, clipboard. |

You choose the level, you can revoke it at any moment, and the permission is a list of
named tools rather than a blanket "allow". It runs on the open-source
[cua driver](https://github.com/trycua/cua) (MIT), installed separately. Settings walks you
through it.

**Work by project.** A project is a folder. Conversations are grouped under the folder they
run in, reorderable by drag, and each one carries its own model, reasoning effort and
permissions. They survive a restart.

**See what the agent is doing.** Thinking shows up before the first word of the answer, in
a block you can fold away. Tool calls stream live, then collapse into one line when they
are done. Sub-agents get their own lane. Answers are Markdown, with tables and copyable
code blocks.

**Decide what it may do.** Three postures: ask every time, approve on your behalf for
anything that stays inside the working folder, or let it run. An approval is bound to the
conversation that asked for it, and a stale one is refused rather than silently applied.

**Branch a conversation.** Fork it from any turn, or continue it in a git worktree so the
agent works on a copy while your folder stays untouched.

**Keep the tools next to the work.** A browser with tabs, a terminal that opens in the
conversation's folder, a file tree, and a review panel for what changed.

**Bring your own tools.** MCP servers, local or remote, with the tool catalogue verified by
a real handshake before it is saved. Remote tokens go to the system keychain. Skills from
the host and from your workspace, offered as you type `/`.

**Stay ahead of the context window.** A meter next to the model picker shows how full the
conversation is; one click compacts it.

## Install

**macOS (Apple Silicon).** Open the DMG and drag the app into Applications. It is signed
and notarised, so there is no Gatekeeper warning. On first launch the app offers to install
the Muse CLI for you.

**Windows x64.** Run the installer. Windows will warn that the publisher is unknown: the
build is not code-signed yet. It installs per-user, with no administrator rights. You need
WSL with Muse already set up; see the [Windows setup notes](scripts/wsl-bridge/README.md).

Either way you need a Muse Code account: authentication and model choice come from the
engine, not from this app. For computer use, install the cua driver when Settings offers to.

## Build it yourself

```sh
npm install
npm run tauri -- dev
```

`npm run dev` alone opens the interface in a browser, which is useful for UI work but
cannot talk to the engine. On Windows, `npm run dev:clean:windows` clears a stale Vite
cache first.

To build a package:

```sh
sh scripts/build-macos.sh --bundle dmg      # macOS
npm run tauri -- build --bundles nsis       # Windows, sidecar in src-tauri/binaries/
```

Release tooling (manifests, signing, delta updates, channel indexes) is documented in
[docs/SPEC.md](docs/SPEC.md) and the `scripts/release-*.mjs` files.

## Status

macOS and Windows both ship. Windows is the platform with a native qualification campaign
behind it; the macOS port is newer. Linux is not started. Feature-by-feature status lives
in [docs/ROADMAP.md](docs/ROADMAP.md), which is honest about what is measured and what is not,
including the defects still open.

## Documentation

- [Product and technical specification](docs/SPEC.md)
- [Roadmap and feature status](docs/ROADMAP.md)
- [What the Muse sidecar really supports](docs/SIDECAR-CONTRACT-GAPS.md)
- [Release notes](docs/releases/)

Built with Tauri, React and Vite. Some planning documents are in French.
