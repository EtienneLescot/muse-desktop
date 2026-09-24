# Muse-Desktop

**A desktop app for Muse Code — and it can use your computer.**

Muse Code is Meta's coding agent, and it lives in a terminal. Muse-Desktop gives it a
window: conversations organised by project, the work visible as it happens, and an
opt-in switch that lets the agent see your screen and drive your applications.

![Muse-Desktop on Windows](assets/screenshot-windows.png)

> **Windows x64 · beta.** Muse must already be installed in your default WSL
> distribution. The installer is unsigned, so Windows will show a SmartScreen warning.
> [Download the latest release](https://github.com/EtienneLescot/muse-desktop/releases).

## What it does

**Let the agent use your computer.** Turn it on and Muse can look at your screen and
work in your applications — open a file, fill a form, click through a tool that has no
API. Two levels, and it starts at neither:

| Level | What Muse may do |
|---|---|
| Off | Nothing. This is the default. |
| Observe only | Take screenshots, read windows. No clicks, no typing. |
| Observe and act | Mouse, keyboard, clipboard. |

You choose the level, you can revoke it at any moment, and the permission is a list of
named tools rather than a blanket "allow". It runs on the open-source
[cua driver](https://github.com/trycua/cua) (MIT), installed separately — Settings walks
you through it.

**Work by project.** A project is a folder. Conversations are grouped under the folder
they run in, and each one carries its own model, reasoning effort and permissions.

**See what the agent is doing.** Tool calls appear live, then fold into one line when
they are done. Markdown answers with tables and copyable code blocks. A browser, a
terminal, and a review panel for the files that changed.

**Branch a conversation.** Fork it from any turn, or continue it in a git worktree so
the agent works on a copy while your folder stays untouched.

**Bring your own tools.** MCP servers, local or remote, with the tool catalogue verified
before it is saved. Skills from the host and from your workspace, offered as you type `/`.

## Install

Download the installer from [Releases](https://github.com/EtienneLescot/muse-desktop/releases)
and run it. Windows will warn that the publisher is unknown — the build is not code-signed
yet. You need WSL with Muse already set up; see the
[Windows setup notes](scripts/wsl-bridge/README.md).

For computer use, install the cua driver when Settings offers to.

## Build it yourself

```sh
npm install
npm run tauri -- dev
```

`npm run dev` alone opens the interface in a browser, which is useful for UI work but
cannot talk to the engine. On Windows, `npm run dev:clean:windows` clears a stale Vite
cache first.

To build the installer (the matching `muse` sidecar must be in `src-tauri/binaries/`):

```sh
npm run tauri -- build --bundles nsis
```

Release tooling — manifests, signing, delta updates, channel indexes — is documented in
[docs/SPEC.md](docs/SPEC.md) and the `scripts/release-*.mjs` files.

## Status

Windows is the platform that is actually qualified. A macOS build exists and is not
proven. Linux is not started. Feature-by-feature status lives in
[docs/ROADMAP.md](docs/ROADMAP.md) — it is honest about what is measured and what is not.

## Documentation

- [Product and technical specification](docs/SPEC.md)
- [Roadmap and feature status](docs/ROADMAP.md)
- [What the Muse sidecar really supports](docs/SIDECAR-CONTRACT-GAPS.md)

Built with Tauri, React and Vite. Some planning documents are in French.
