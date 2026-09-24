# Muse-Desktop — desktop mockup

Open `index.html` directly, or run `node ../serve.cjs`, then browse to http://127.0.0.1:4174/prototype/.

A standalone HTML/CSS/JavaScript prototype, in French. No build step and no API key. The DM Sans font loads from Google Fonts; a system font takes over offline.

## Interactive flows

- A complete initial task: conversation, steps, changed files, diff, terminal and preview.
- A new task: suggestions, typing, model choice, Agent/Plan/Discussion mode and Local/Worktree/Cloud environment.
- A simulated answer and authorization, stopping, relaunching, an attachment (name only).
- Search with Ctrl+K, a new task with Ctrl+N, a conversation variant, archiving and restoring.
- A simulated commit, file selection, demonstration terminal commands.
- Creating and editing automations, enabling and disabling them.
- A filterable extension catalogue; adding and removing locally.
- Light and dark themes, collapsible navigation.

Tasks, automations, extensions and the theme are kept in localStorage. Follow-up conversations are temporary. No AI engine, Git, cloud, real terminal or scheduler is connected. The permission and notification controls illustrate the UX. This mockup follows the main Codex flows; it is not an implementation of its full functionality.

## Visual direction and references

Meta action blue, cool whites, slate grey, rounded surfaces and sans-serif typography. A dark variant inspired by the developer site. The logo was supplied by the user and is kept in assets/muse-logo.png.

- https://ai.meta.com/muse/
- https://developer.meta.com/ai/products/muse-code/
- https://developers.openai.com/codex/app/features (redirects to https://learn.chatgpt.com/docs/features)

References consulted on 13 September 2026. The Atelier project's content, test results and diffs are fictitious examples, there to make the flows explorable.
