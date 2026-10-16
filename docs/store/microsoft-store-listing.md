# Microsoft Store listing — MuDesktop

Listing of Partner Center product `9NBPFWQBGLZG`, reserved on 14/10/2026 and submitted for
certification on 15/10/2026 (0.4.0, manual publishing after certification). Rejected on 16/10/2026
under 10.1.1.1 ("Desktop for Muse Code" names another product); renamed **MuDesktop**, reserved
on the same product, package identity unchanged.

## Product identity (MSIX manifest)

| Field | Value |
|---|---|
| `Package/Identity/Name` | `EtienneLescot.DesktopforMuseCode` |
| `Package/Identity/Publisher` | `CN=03B0FC8C-2067-45D9-BE82-9F15CE264B4A` |
| `Package/Properties/PublisherDisplayName` | `Etienne Lescot` |
| Package Family Name | `EtienneLescot.DesktopforMuseCode_hedpjctvqwhq0` |
| Store link | https://apps.microsoft.com/detail/9NBPFWQBGLZG |

## Properties

- **Category:** Developer tools (subcategory: none).
- **Privacy policy URL:** https://github.com/EtienneLescot/muse-desktop/blob/main/docs/PRIVACY.md
- **Support contact:** GitHub issues, https://github.com/EtienneLescot/muse-desktop/issues

## Listing — English (en-us)

**Description**

> MuDesktop is an independent desktop app for Muse Code. It is not made, endorsed or
> supported by Meta.

Run your Muse Code coding agent in a real desktop app instead of a terminal. Open several projects
side by side, follow every turn of the agent, review the files it changed and ship them, without
leaving the window.

The app holds no agent logic of its own: it drives the Muse Code engine, which stays the only source
of authentication, models and tools. Your conversations stay on your machine.

- Conversations per project, searchable, resumable after a crash or a restart.
- Review the real diff, comment a line, stage, commit, push and open a pull request.
- A built-in terminal the agent can read, and the project's real files.
- Isolated worktrees for parallel work, and sub-agents you can follow.
- MCP servers, skills and extensions, scheduled runs with notifications.
- A built-in browser the agent can drive, and computer use with your consent.

Requires a Muse Code account.

**Product features** (one per line, 200 characters max)

- Run the Muse Code AI coding agent in a desktop app
- Several projects and conversations side by side
- Review diffs, commit, push and open pull requests
- Built-in terminal and file browser
- Isolated Git worktrees for parallel tasks
- MCP servers, skills and scheduled runs
- Built-in browser and computer use, with consent

**Search terms** (7 max)

`muse code` · `ai coding agent` · `coding assistant` · `ai code editor` · `developer tools` ·
`git client` · `mcp`

**What's new in this version**

First Store release: 0.4.0, qualified on Windows with the Muse Code 1.4.2 engine.

## Listing — Français (fr-fr)

**Description**

> MuDesktop est une application de bureau indépendante pour Muse Code. Elle n'est ni
> créée, ni approuvée, ni prise en charge par Meta.

Utilisez l'agent de code Muse Code dans une vraie application de bureau plutôt que dans un
terminal. Ouvrez plusieurs projets côte à côte, suivez chaque tour de l'agent, relisez les fichiers
modifiés et livrez-les sans quitter la fenêtre.

L'application ne contient aucune logique d'agent : elle pilote le moteur Muse Code, seule source
d'authentification, de modèles et d'outils. Vos conversations restent sur votre machine.

- Conversations par projet, recherchables, reprises après un plantage ou un redémarrage.
- Relecture du vrai diff, commentaire de ligne, stage, commit, push et pull request.
- Un terminal intégré que l'agent sait lire, et les vrais fichiers du projet.
- Worktrees isolés pour travailler en parallèle, sous-agents suivis.
- Serveurs MCP, skills et extensions, exécutions planifiées avec notifications.
- Un navigateur intégré pilotable par l'agent, et le computer use avec votre accord.

Nécessite un compte Muse Code.

**Search terms**

`muse code` · `agent ia` · `assistant de code` · `éditeur de code ia` · `outils développeur` ·
`client git` · `mcp`

## Submission assets

- **Package:** `scripts/build-msix.mjs`, built by the release workflow as the `store-msix` artifact
  (kept 30 days).
- **Screenshots:** `docs/store/screenshots/` (1920×1080, real app, demo repo), uploaded to both
  listings.
- **Logos:** `docs/store/logos/`, generated from `src-tauri/icons/macos-icon-1024.png`. The 1:1 tiles
  (300, 150, 71) keep the icon's transparent corners; the poster and box art, used by games only,
  sit on white.
- **Age rating:** IARC 3+ (PEGI 3, ESRB Everyone, "Users Interact"), answered in Partner Center.
