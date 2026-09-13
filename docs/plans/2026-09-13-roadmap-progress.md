# Roadmap — état d'avancement (2026-09-13, `main` @ `4d1f92c`)

Arbre propre, poussé sur `origin/main`. Gates : `tsc` propre, 343/343 tests
node, 23/23 tests Rust, `vite build` vert (node Linux
`~/.nvm/versions/node/v22.16.0`, le `node` du PATH étant un shim Windows cassé).

## Stories : 33/34 mergées, 2 partielles

V1 Must 11/11 : US-1, US-2, US-6, US-10, US-11, US-14, US-17, US-18, US-22,
US-29, US-33.
V2 Should 20/22 : US-3, US-4 (compaction **locale** extractive), US-5, US-7
(fan-out via tour parent — aucun spawn au schéma), US-8 (plan worktree +
snippet manuel), US-9 (scheduling client-side), US-12, US-15, US-16, US-19
(iframe + permission par app), US-20, US-21, US-23, US-24/25/26 (annuaire
local, 1 remote guard), US-27 (bundles locaux), US-30, US-32, US-34.
Partielles : US-28 (stub expérimental "non connecté"), US-31 (registre
sample, `model/list` serveur non branché). US-13 = Won't (SSE, par spec).

## SDK Meta (`@muse-code/sdk@0.1.1`, épinglé)

Adoption partielle actée : `src/lib/msp.ts` + `test/msp-conformance.test.ts`
valident nos 8 méthodes / 15 notifications contre les unions officielles à
la compilation (`import type` uniquement — bundle identique, zéro runtime).
Audit schéma vs `msp.rs` : **zéro écart**. Transport Rust conservé (le SDK
exige Node+spawn, indisponible en webview). Reste ouvert : fingerprint du
binaire embarqué (`checkServedFingerprint`).

## Reste à faire (ordre suggéré)

1. ~~US-31~~ **fait** (`8f98fa1`) : `model/list` + `session/setModel`
   réels, prouvés sur le binaire (`accepted`, `isActive` bascule ; id
   invalide → `-32030 invalid_model`). Picker live avec fallback sample.
   Note : le binaire annonce le fingerprint `sha256:03312c21…` alors que le
   SDK épingle `sha256:cfd31ee7…` (schéma avancé côté host — warning, pas
   erreur ; à surveiller).
2. ~~US-4 serveur~~ **fait** (`5539be3`) : commande `compact_session`
   (`session/compact`, statuts `accepted`/`noop`, rejets `missing_run` /
   `run_active` mappés — tous prouvés live), routage
   `session/contextUsage` → barre d'occupation + bouton « Compact server »
   suggéré dès `warning` (jamais auto). Récap local inchangé.
3. US-28 : channels temps réel (transport à spécifier) ou déclasser en
   Won't documenté.
4. Capacités serveur non exploitées : `turn/steer`, `session/fork`,
   `turn/cancel`/`unqueue`, `view/page`, `approval/listPending`.
5. Vérification live/E2E : subagents réels, `check_scope`, sidecar
   (jamais exercés dans cette session ; pas d'automatisation sous WSLg).
6. Ménage : branches `impl/w-*`, `impl/us-32-a11y`, `impl/v2-batch2`
   encore sur origin ; worktrees déjà supprimés.

## Sidebar UX — threads first, maquette `design/prototype` (`be54165` → `4d1f92c`)

- Threads d'abord, sections secondaires en labels statiques (pas de
  `<details>` — la maquette n'a aucun dépliant) : Projets, Automatisations,
  Intégrations, Bibliothèque, Archivés.
- Labels au token maquette (`.section-label` : 11px, capitales espacées,
  muted, `margin: 28px 12px 9px`) ; bouton `+` discret comme le `[+]`
  Projets de la maquette.
- Workspace par thread (façon Codex) : picker de dossier à la création,
  défaut réglable dans Settings ; plus de verrou global « Choose workspace
  folder ».

## Risques connus

- Merges croisés sur `App.tsx` / `useMuseSessions.ts` / `App.css` résolus à
  la main : gates verts mais régression UX silencieuse possible.
- `wire_log` (`/tmp/muse-wire.log`, prompts en clair) toujours présent :
  à retirer avant release (cf. SPEC).
