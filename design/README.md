# Muse-Desktop · Design

A UX/UI deliverable independent of the Tauri application: an interactive mockup and a design system sharing the same tokens and component styles.

## Viewing it

From the repository root: `node design/serve.cjs`.

- Home: http://127.0.0.1:4174/
- Mockup: http://127.0.0.1:4174/prototype/
- Design system: http://127.0.0.1:4174/system/

The pages can also be opened straight from the filesystem. No build, npm package or secret is required. DM Sans loads from Google Fonts, with Arial as a fallback.

## Layout

- `prototype/`: HTML/CSS/JS application and flow documentation.
- `system/tokens.css`: semantic light and dark colors, typography, spacing and radii.
- `system/index.html`: visual reference for components, states and composition rules.
- `assets/muse-logo.png`: original logo supplied by the client, transparency preserved.
- `serve.cjs`: local static server, scoped to this folder.

## UX principles

The logo and the profile are anchored in the sidebar; only its middle scrolls. The profile block opens settings by click and by keyboard. The conversation and the work panel scroll independently. The composer stays reachable at the bottom. Scrollbars are 6 px, soft blue at rest and Muse blue on hover. Moderate radii, 8 to 16 px, on surfaces.

The mockup covers the main flows: tasks, review, preview, terminal, automations and extensions. AI results, commands, authorizations and commits are simulated. The environment and model pickers connect to no service. Tasks and preferences persist in localStorage; follow-up answers are temporary. No browser test data ships with it.

## References

- https://ai.meta.com/muse/
- https://developer.meta.com/ai/products/muse-code/
- https://developers.openai.com/codex/app/features

References consulted on 13 September 2026. This proposal is not an official Meta or OpenAI specification, nor a guarantee of exhaustive parity with Codex.
