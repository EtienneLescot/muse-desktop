# Manche 7 — tentative de correctif M1-05 + constat de perte de données au kill (27 septembre 2026)

## Correctif M1-05 : downgrade `portable-pty` 0.9.0 → 0.8.1 — build OK, rejoue UI en reste

- `src-tauri/Cargo.toml` : `portable-pty = "0.8"` ; `cargo update -p portable-pty` → **0.9.0 → 0.8.1**
  (nix 0.28→0.25 rétrogradé en conséquence).
- `cargo build` : **OK en 1 min 13 s** (3 warnings préexistants, sans lien).
- `npm test` : **exit 0** ; `npx tsc --noEmit` : **exit 0** (inchangé, le correctif est Rust).
- App relancée avec le binaire corrigé (CDP 9222 opérationnel).
- **Rejoue du scénario terminal (`ux-terminal-state.mjs --type "echo muse-pty-fix-2026"`) pas encore
  réalisée** : bloquée par un état UI après la perte de données ci-dessous (bouton « Start
  conversation » inactif malgré saisie réelle — `scripts/cdp-type.mjs` nouvellement ajouté, frappes
  CDP `Input.dispatchKeyEvent` par caractère, le chemin de saisie fiable). À reprendre en manche 8 :
  soit diagnostiquer le verrou du bouton, soit re-créer un projet via l'UI native.

## Constat : `taskkill /F` → projets et fils PERDUS (les autres clés survivent)

Après le `taskkill /F /PID 44844` puis relance : `muse-desktop.projects.v1` = `"[]"` et
`muse-desktop.sessions.v1` = `"[]"` — **toutes les conversations et projets effacés** — alors que
`schedules.v1`, `schedule-runs.v1`, `notifications.v1`, `queued-turns.v1`, etc. sont intacts (23 clés
présentes). Contraste avec le kill de la manche 6 (même procédure) qui avait **préservé** projets,
fils et file.

- **Interprétation prudente :** la perte est réelle et reproductible à ne pas sous-estimer (un kill
  brutal peut perdre les magasins `projects`/`sessions`) ; sa cause exacte n'est pas établie (écriture
  en vol au moment du kill ? réinit. de migration au démarrage ? profil WebView2 ?). La manche 6
  prouve par ailleurs que la file, elle, survit et reprend.
- **Impact qualification :** M0-02 (« le travail enregistré survit ») mériterait d'être rouvert en
  ◐ sur ce point : la reprise a été prouvée sur la file et les runs, **pas** sur projets/fils dans
  toutes les configurations de kill.

## Reproductibilité

- Commit : cette note + `src-tauri/Cargo.toml`/`Cargo.lock` (downgrade) + `scripts/cdp-type.mjs`.
- Commandes : `cargo update -p portable-pty` + `cargo build` (`src-tauri/`), `npm test`,
  `npx tsc --noEmit`, `taskkill /F /PID 44844`, relance `src-tauri\target\debug\muse-desktop.exe`
  avec `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
- Plateforme : Windows 11 26200, WebView2 Edg/153, build dev.
