# M0-01 / M0-14 — A continue quand B est ouvert, actif et **coupé** (27 septembre 2026)

**Le critère manquant du 20 septembre est prouvé en une seule exécution :** un tour du projet A
s'achève **sans erreur** — 46 s après la mort du host du projet B en plein tour — pendant que B
est ouvert et actif, et que son host est tué en cours de route.

## Protocole exécuté (webview empaquetée en dev, CDP port 9222)

1. **Projet B** (`C:\Users\etien\Documents\repos\muse-desktop`) : nouvelle conversation via le
   `<details class="project-picker">`, tour long « 2500-word detective story » lancé.
   Trace IPC : `start_session` avec `workspacePath: "C:\\Users\\etien\\Documents\\repos\\muse-desktop"`.
2. **Projet A** (`G:\repos\openscreen`) : nouvelle conversation en **parallèle**, tour long
   « Count slowly from one to five hundred » lancé pendant que B stream.
   Deux hosts `muse.exe serve` distincts vivants : PID 36740 (A, créé 15:23:18) et
   PID 47776 (B, créé 15:36:29).
3. **`taskkill /F /PID 47776`** — le host de B — à **15:37:24**, les deux tours en cours.
4. Observation des deux conversations.

## Résultats

| Fait | Mesure |
|---|---|
| Statut terminal de B à la mort de son host | **« Muse stopped because the host process ended. Reconnect to continue. »** (Information, 15:37:24, à la seconde du `taskkill`) |
| Tour A pendant/après la coupure | **terminé à 15:38:10** — réponse reçue, actions « Fork from here » et `session/read` du tour final visibles, **aucune erreur**, aucun spinner figé |
| Conduite du flux A | ininterrompu (le seul creux observé : 47 s de réflexion modèle, annoncé honnêtement par le bandeau de liveness « Muse may still be working ») |
| Effet de bord sur A | **aucun** — pas de respawn parasite, pas de conversation corrompue |

Captures : [`shots/m0-01-a-termine.png`](shots/m0-01-a-termine.png) (A abouti),
[`shots/m0-01-b-host-mort.png`](shots/m0-01-b-host-mort.png) (statut honnête de B).

Complète la campagne du 20/09 (`evidence/2026-09-20-windows-sessions/`) qui avait déjà mesuré :
deux hosts simultanés, mort de B sans effet sur A ni sur les 58 sessions, nouvelle session et
tour réel ensuite sur le host survivant. Ce qui manquait — **« un tour terminé sur A pendant
que B est encore vivant puis coupé »** — est fait.

## M0-14 (contrôles reproductibles) — état

- Scénarios CDP reproductibles : `scripts/cdp-concurrent-turns.mjs` (M0-01/M0-14,
  `--live` / `--wait-kill`), `scripts/cdp-ab-projects.mjs`, `scripts/cdp-stop-terminal.mjs`
  (M0-04), `scripts/cdp-queue-race.mjs` (M1-10), plus `scripts/cdp-shot.mjs` pour les captures.
- **Reste :** exécution depuis la CI Windows, captures et artefacts produits par la CI, versions
  de test fixées (`muse-bin-1.3.0-R3401.1`). Ticket non clos.

## Reproductibilité

- Commit `89654a8` (scripts) sur l'app à `362c8bb`+ ; Windows 11 26200, WebView2.
- Séquence exacte : sélection projet B → tour long → sélection projet A → tour long →
  `taskkill` du host le plus récent (par `CreationDate`) → lecture des deux conversations.
- Notes de méthode : le picker de projet est `<details class="project-picker-control">` +
  `button.project-option` (le vieux sélecteur « Start in » de `cdp-ab-projects.mjs` n'existe
  plus — le script devra être adapté) ; les deux hosts ont une `CommandLine` identique, seule la
  date de création les distingue.
