# Index des preuves natives — campagne Windows du 20 septembre 2026

Point d'entrée unique vers les preuves produites par la campagne. Chaque ticket renvoie à ses documents, à **ce qui est prouvé**, à **ce qui reste**, et à **la commande qui reproduit la mesure**.

Mise à jour le 20 septembre 2026, après la fusion de la PR #187.

## Comment lire ce dossier

Un dossier par sujet. **Chaque document déclare ses propres limites** : aucun ne présente un scénario unique comme la preuve qu'un ticket est clos.

| Dossier | Sujet | Documents |
|---|---|---|
| [`2026-09-20-windows-group1/`](2026-09-20-windows-group1/) | parcours M0-03, M1-10, isolation générale | 8 documents + 29 captures |
| [`2026-09-20-windows-ab-projects/`](2026-09-20-windows-ab-projects/) | isolation entre deux projets (M0-01, M0-14) | 1 |
| [`2026-09-20-windows-browser/`](2026-09-20-windows-browser/) | navigateur intégré (M4-01, M4-02) | 1 |
| [`2026-09-20-windows-transcript/`](2026-09-20-windows-transcript/) | fenêtre du transcript (M1-13) | 4 |
| [`2026-09-20-windows-a11y/`](2026-09-20-windows-a11y/) | accessibilité (M0-12) | 1 |
| [`2026-09-20-windows-language/`](2026-09-20-windows-language/) | copie anglaise et navigation (M0-11) | 2 |
| [`2026-09-20-windows-m010/`](2026-09-20-windows-m010/) | premier lancement (M0-10) | 1 |
| [`2026-09-20-windows-release/`](2026-09-20-windows-release/) | distribution (M4-09) | 3 |

Le rapport destiné au mainteneur du sidecar est hors de ce dossier : [`../SIDECAR-CONTRACT-GAPS.md`](../SIDECAR-CONTRACT-GAPS.md).

## Matrice de couverture

| Ticket | Ce qui est prouvé | Ce qui reste | Blocage | Reproduction |
|---|---|---|---|---|
| **M0-01** | deux hosts simultanés · mort d'un host sans effet sur l'autre ni sur l'application · tour mené à terme **pendant** la mort de l'autre, sans stale | **approbations simultanées** | plafond `promptUnmatched` du host — le mode `ask` n'a présenté aucune demande | `cdp-ab-projects.mjs`, `cdp-concurrent-turns.mjs` |
| **M0-02** | reprise annoncée `ephemeral` · détection de la mort du host · `Disconnected` + envoi bloqué + transcript conservé · échec de reprise **honnête** (`sessionNotFound [retryable=false]`) | reprise durable d'un tour | **contrat sidecar** : `session/read` et `session/resume` absents | `README.md` (groupe 1) |
| **M0-03** | **les 4 critères** : envoi rejeté conserve le texte · double Entrée = 1 tour (1 identifiant client) · brouillon et envoi en cours survivent au rechargement · Entrée en composition IME **ne soumet pas** | variantes : IME chinois/coréen, rechargement **avant** acquittement, double clic **à la souris** | méthode | `cdp-unknown-skill-reject.mjs`, `cdp-double-send.mjs`, `cdp-reload-mid-send.mjs`, `cdp-ime-compose.mjs` |
| **M0-04** | interruption affichée (`Stopping…`) · état stale correctement signalé · aucun faux succès | **terminal confirmé** | **contrat sidecar** : `turn/completed`/`retracted`/`stopped` jamais émis | `native-smoke.mjs --exercise-control` |
| **M0-10** | guidance d'échec exercée sur sidecar neutralisé : `sidecar`/`binary`/`triple`/`folder`, **Try again**, **Choose workspace folder**, aucune installation implicite | **machine propre** | infrastructure (la machine de test a déjà WSL, Muse, 64 conversations) | `M0-10-guidance-echec.md` |
| **M0-11** | copie anglaise sur 7 surfaces + 129 fichiers sources · câblage des helpers de navigation **verrouillé par test** | rendu natif des infobulles · branche `Cmd` sur un vrai macOS | infrastructure | `cdp-language-audit.mjs`, `test/navigationDetails.test.ts` |
| **M0-12** | `forced-colors` honoré (couleurs système) · 24 arrêts de tabulation sans piège · `Ctrl+F` lié · contraste AA sur 60 textes · **un défaut corrigé** (`prefers-contrast` inerte) avec test de non-régression | **lecteur d'écran réel** | je ne peux pas le piloter | `cdp-a11y-probe.mjs`, `cdp-contrast-probe.mjs`, `cdp-focus-pixels.mjs` |
| **M0-14** | idem M0-01 | idem M0-01 | idem M0-01 | idem |
| **M1-06** | `userShell` **négocié et accepté** | item publié, `outputRef`, sortie relisible | **contrat sidecar** | `msp-probe.mjs --user-shell` |
| **M1-10** | admission en file persistée · panneau **Queued messages** ordonné · `Stopping…` · file vidée après Stop · **retrait séquentiel** · **course : les tours retirés ne démarrent pas** | compte exact des clics (évaluation async vide) · accusé `turn/unqueue` du host · une anomalie de journal non expliquée | méthode + contrat sidecar | `cdp-queue-removal.mjs`, `cdp-queue-race.mjs` |
| **M1-11** | `setModel` et `setReasoningEffort` **acceptés** | projection effective | **contrat sidecar** : `projection: not-reported`, `isActive: false` | `native-smoke.mjs --exercise-reasoning --exercise-model` |
| **M1-13** | fenêtre bornée à **160 articles sur 2 001** · chargement incrémental de 120 à DOM constant · finder atteignant un **résultat hors fenêtre** · coût de rendu (layout 12 ms, script 2,02 s, +160 KiB) | **qualification assistive** · mesures sur build de développement seul | je ne peux pas piloter un lecteur d'écran | `cdp-long-transcript.mjs`, `cdp-scroll-window.mjs`, `cdp-finder-jump.mjs`, `cdp-perf.mjs` |
| **M4-01** | navigation native (iframe montée) · persistance par onglet · **isolation par `sessionId`** | qualification macOS/Linux · téléchargements initiés par navigation | infrastructure | `cdp-panel.mjs` |
| **M4-02** | annotation **réellement créée** (ancre URL, citation, commentaire) · **garde de contexte** après changement de domaine | recadrage de région · capture visuelle | infrastructure | `cdp-panel.mjs`, `cdp-annotate.mjs` |
| **M4-09** | build NSIS (SHA-256 vérifié) · **installation et désinstallation sans perte** (64 conversations, 2 projets) · **mise à jour 0.0.9 → 0.1.0 sans perte** · chaîne delta (~1250× plus petite, reconstruction à l'octet près) | **machine propre** · **signature** (`NotSigned`) · MSI · rollback réel | infrastructure | `build-windows.ps1`, `release-delta.mjs` |

Tickets **non entamés** faute d'accès : M2 et M3 demandent un host qui expose les contrats correspondants ; voir leurs lignes dans [`../ROADMAP.md`](../ROADMAP.md).

## Outils de mesure livrés

Tous sous `scripts/`, tous exécutables sans l'application sauf mention.

| Script | Rôle | Coût |
|---|---|---|
| `msp-probe.mjs` | décrit le contrat du host (surfaces, `userShell`, `approval/listPending`) | **aucun tour modèle** |
| `native-smoke.mjs` | contrôle, erreurs, approbation, isolation, file, compaction sur deux hosts | quelques tours |
| `cdp-drive.mjs` | inspection et pilotage du DOM (`snapshot`, `eval`, `click`, `fill`) | aucun |
| `cdp-panel.mjs` | ouvre la barre de travail et exerce le navigateur intégré | aucun |
| `cdp-annotate.mjs` | crée une annotation et vérifie sa persistance | aucun |
| `cdp-scenario.mjs` | tour, file, Stop, stale | un tour |
| `cdp-ab-projects.mjs` | isolation entre deux projets | un tour |
| `cdp-concurrent-turns.mjs` | tours concurrents | un tour |
| `cdp-unknown-skill-reject.mjs` | rejet déterministe d'envoi | aucun |
| `cdp-double-send.mjs` | double soumission | un tour |
| `cdp-reload-mid-send.mjs` | brouillon et envoi face au rechargement | un tour |
| `cdp-ime-compose.mjs` | composition IME | aucun |
| `cdp-long-transcript.mjs` | fenêtre bornée sur un journal fabriqué | aucun |
| `cdp-scroll-window.mjs` | chargement incrémental | aucun |
| `cdp-finder-jump.mjs` | finder vers un résultat hors fenêtre | aucun |
| `cdp-perf.mjs` | coût de rendu et mémoire | aucun |
| `cdp-a11y-probe.mjs` | ordre de tabulation, focus, contraste | aucun |
| `cdp-contrast-probe.mjs` | `forced-colors` et `prefers-contrast` émulés | aucun |
| `cdp-focus-pixels.mjs` | indicateur de focus par comparaison de pixels | aucun |
| `cdp-language-audit.mjs` | copie française dans le DOM rendu | aucun |
| `cdp-queue-removal.mjs` | retrait d'une entrée de file | un tour |
| `cdp-queue-race.mjs` | course file/retrait | un tour |

**Instrumentation de développement** : les scripts `cdp-*` supposent l'application lancée avec `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. Ils activent une fonctionnalité de WebView2 et **ne modifient pas** le code de l'application.

## Documents qui tracent un échec

Quatre documents conservent un résultat négatif ou une erreur de méthode. Ils sont volontairement conservés :

| Document | Ce qu'il trace |
|---|---|
| [`M0-03-envoi-rejete-inabouti.md`](2026-09-20-windows-group1/M0-03-envoi-rejete-inabouti.md) | première tentative d'envoi rejeté, remplacée depuis par `M0-03-envoi-rejete.md` |
| [`M1-10-retrait-file-inabouti.md`](2026-09-20-windows-group1/M1-10-retrait-file-inabouti.md) | file jamais alimentée — préconditions non vérifiées |
| [`finder-hors-fenetre-inabouti.md`](2026-09-20-windows-transcript/finder-hors-fenetre-inabouti.md) | mauvais sélecteur : le conteneur du finder au lieu de son ouvreur |
| [`M0-12.md`](2026-09-20-windows-a11y/M0-12.md) | contient le faux positif « aucun indicateur de focus » **et** sa correction |

## Trois erreurs de méthode, documentées plutôt que corrigées en silence

1. **Indicateur de focus** : conclu absent en cadrant le seul `TEXTAREA`. L'anneau est sur le conteneur — deux captures identiques au bit près ne prouvaient rien.
2. **`prefers-contrast`** : d'abord attribué à la spécificité, correctif tenté, **échec**, correctif retiré, diagnostic corrigé, puis hypothèse réelle testée **hors du dépôt** avant application.
3. **Ordre des entrées du transcript** : `streamWindowStart` est un offset depuis la fin, donc un marqueur « hors fenêtre » était en fait **dedans**. Un « succès » sans valeur, détecté en lisant le code.

## Ce que cette campagne n'a pas fait

- **Aucune preuve macOS ni Linux**, pour aucun ticket.
- **Aucune qualification par un lecteur d'écran réel.**
- **Aucun test sur machine propre** : la machine de test a déjà WSL, Muse et 64 conversations.
- **Aucune installation signée** : les deux installeurs sont `NotSigned`.
- **Aucun test des contrats M2 et M3** (worktrees, MCP, scheduler, notifications) : ils demandent un host qui expose les méthodes correspondantes.
