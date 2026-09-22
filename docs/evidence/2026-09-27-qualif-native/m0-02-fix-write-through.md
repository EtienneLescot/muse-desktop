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

## Rejeu du `taskkill /F` réel — RÉUSSI (kill « sale » en plein tour)

Sur le build corrigé, tour lancé (« Reply with exactly the word: KILLTEST », écritures en vol :
log, session, active) puis **`taskkill /F /PID 23040` à +3 s**, relance :

| | Avant kill | Après kill + relance |
|---|---|---|
| Clés localStorage | 36 | **36** ✓ |
| `projects.v1` | 172 o (1 projet) | **172 o (1 projet)** ✓ octet à octet |
| `sessions.v1` | 13 557 o (59 fils) | **13 578 o (61 fils)** ✓ JSON valide, enrichi |

**Aucune corruption, aucune perte** : projets et fils intacts après un kill brutal en plein tour.
Avec le correctif, même si une valeur venait à être corrompue en vol, le repli ne serait plus
persisté (test du marqueur ci-dessus) et le host reconstruirait les fils (rédemption ci-dessus).

## Brouillon du composeur — DÉFAUT : non conservé (pièce manquante de M0-02)

« Conserver le travail non envoyé (brouillon) » — **non implémenté** : saisi `draft-marker-M02-unsent`
dans le composeur (clavier réel, sans envoi), attendu 7 s :

- **aucune clé localStorage** ne contient le marqueur (aucune clé de type brouillon n'existe) ;
- `taskkill /F` + relance : **brouillon perdu** (champ vide, stockage vide).

La valeur vit uniquement dans l'état React du composeur — toute extinction (crash, kill, fermeture)
la perd. Correctif attendu : persistance debouncée du brouillon par fil (une clé
`muse-desktop.drafts.v1` par exemple) avec restauration au montage du fil.

## Reproductibilité

```powershell
# 1. build corrigé : npm run build ; cargo build (depuis src-tauri) ; relancer l'exe
# 2. dans la console CDP (scripts/cdp-drive.mjs eval) :
localStorage.setItem("muse-desktop.projects.v1", "not-json-M02c"); location.reload();
# 3. après 2 s et 10 s :
localStorage.getItem("muse-desktop.projects.v1"); # attendu : "not-json-M02c" (avant : "[]")
```
