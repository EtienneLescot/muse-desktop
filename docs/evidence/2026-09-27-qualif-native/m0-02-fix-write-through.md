# M0-02 — Rejeu du correctif « write-through » : le repli n'est plus persisté

**Plateforme :** Windows 11 (build 26200) · app Tauri native (`http://tauri.localhost/`, WebView2,
CDP 9222) · front embarqué dans `src-tauri\target\debug\muse-desktop.exe` (compilé après
`npm run build`) · **27 septembre 2026**.

## Contexte

La cause de la perte projets/fils était identifiée (voir `m1-05-fix-portable-pty.md`) : une valeur
corrompue/absente hydrate en repli `[]`, puis le write-through du montage persistait `[]`.
Correctif commit `6039510` : gardes `projectsHydratedRef`/`sessionsHydratedRef` — l'état hydraté
n'est jamais écrit, seules les mutations le sont.

## Piège méthodologique découvert (important)

Un premier rejeu a semblé **infirmer** le correctif (`"[]"` réapparaissait en < 1 s) — la cause :
l'app charge le front **embarqué dans le binaire** (`tauri::generate_context!`), pas le serveur
Vite. Modifier le TS sans `npm run build` + `cargo build` + relance ne change rien à l'app
exécutée. Origine mesurée : `location.href = http://tauri.localhost/` ; `fetch('/src/hooks/…')`
renvoie la coquille HTML (fallback SPA de l'asset handler embarqué).

## Protocole

1. Corrompre `muse-desktop.projects.v1` = `not-json-M02c` (simulation exacte de la perte au kill).
2. `location.reload()`, échantillonner la clé à +2 s et +10 s.
3. Comparer ancien build / build corrigé.

## Résultat — CORRECTIF CONFIRMÉ

| Échantillon | Ancien build | Build corrigé (`6039510`) |
|---|---|---|
| +1-2 s | `"[]"` — repli persisté, valeur détruite | **`not-json-M02c`** — intacte |
| +10 s | `"[]"` | **`not-json-M02c`** — intacte |

La valeur corrompue **n'est plus jamais écrasée** : la corruption transitoire ne devient plus un
effacement permanent.

## Observation annexe — rédemption par le host

Après le rejeu de corruption sur `sessions.v1`, l'app a **reconstruit la liste des fils depuis
l'historique du host** (59 sessions restaurées, titres `Session 01a0c9xx`, workspace
`\\?\G:\repos\openscreen`) et l'a persistée (mutation réelle, comportement correct du write-through
corrigé). Les fils survivent donc aussi côté host, indépendamment du localStorage.

Restauration finale : `projects.v1` reintégrée depuis la clé de secours `m02.bak.p`, projet
`openscreen` de nouveau affiché.

## Reproductibilité

```powershell
# 1. build corrigé : npm run build ; cargo build (depuis src-tauri) ; relancer l'exe
# 2. dans la console CDP (scripts/cdp-drive.mjs eval) :
localStorage.setItem("muse-desktop.projects.v1", "not-json-M02c"); location.reload();
# 3. après 2 s et 10 s :
localStorage.getItem("muse-desktop.projects.v1"); # attendu : "not-json-M02c" (avant : "[]")
```
