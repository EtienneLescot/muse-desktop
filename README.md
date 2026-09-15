# Muse-Desktop

A desktop workspace for Muse Code, built with Tauri, React, and Vite.

![Muse-Desktop on Windows — English interface with integrated window controls](assets/screenshot-windows.png)

Organize conversations by project, work with Muse, and review activity and generated content in a focused desktop interface.

The agent engine runs through the `muse` CLI sidecar. The current Windows build uses Muse installed in the default WSL distribution; WSL and Muse must already be configured. See the [Windows build instructions](scripts/wsl-bridge/README.md).

## Development

```sh
npm install
npm run dev
```

The browser preview displays the interface. Working with the engine requires the desktop app and a compatible sidecar:

```sh
npm run tauri -- dev
```

## Documentation

- [Product and technical specification](docs/SPEC.md)
- [Implementation plan](docs/plans/2026-09-07-muse-desktop.md)
- [Roadmap and progress](docs/plans/2026-09-13-roadmap-progress.md)
- [Conversation UX refinements](docs/plans/2026-09-14-conversation-polish.md)

The screenshot shows the native Windows application. Some planning documents are currently in French.
