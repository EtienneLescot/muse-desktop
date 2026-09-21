# Index des preuves natives — campagne Windows du 20 septembre 2026

Point d'entrée unique vers les preuves produites par la campagne. Chaque ticket renvoie à ses documents, à **ce qui est prouvé**, à **ce qui reste**, et à **la commande qui reproduit la mesure**.

Mise à jour après la fusion de la PR #195.

## Comment lire ce dossier

Un dossier par sujet. **Chaque document déclare ses propres limites** : aucun ne présente un scénario unique comme la preuve qu'un ticket est clos.

| Dossier | Sujet | Documents |
|---|---|---|
| [`2026-09-20-windows-group1/`](2026-09-20-windows-group1/) | M0-03 (envoi), M1-10 (file d'attente), campagne générale | 8 documents + 29 captures |
| [`2026-09-20-windows-ab-projects/`](2026-09-20-windows-ab-projects/) | isolation entre deux projets — M0-01, M0-14 | 1 |
| [`2026-09-20-windows-browser/`](2026-09-20-windows-browser/) | navigateur intégré — M4-01, M4-02 | 1 |
| [`2026-09-20-windows-transcript/`](2026-09-20-windows-transcript/) | fenêtre du transcript, persistance, performance — M1-13 | 7 |
| [`2026-09-20-windows-a11y/`](2026-09-20-windows-a11y/) | accessibilité — M0-12 | 1 |
| [`2026-09-20-windows-language/`](2026-09-20-windows-language/) | copie anglaise, navigation, chemins — M0-11 | 4 |
| [`2026-09-20-windows-m010/`](2026-09-20-windows-m010/) | premier lancement et guidance d'échec — M0-10 | 1 |
| [`2026-09-20-windows-release/`](2026-09-20-windows-release/) | distribution — M4-09 | 3 |
| [`2026-09-20-windows-ledgers/`](2026-09-20-windows-ledgers/) | miroirs natifs et testabilité — M3-07, M3-09 | 2 |
| [`2026-09-20-windows-cleanup/`](2026-09-20-windows-cleanup/) | nettoyage des conversations de test | 1 |

Le rapport destiné au mainteneur du sidecar est hors de ce dossier : [`../SIDECAR-CONTRACT-GAPS.md`](../SIDECAR-CONTRACT-GAPS.md).

## Matrice de couverture

| Ticket | Prouvé | Reste | Nature du blocage | Documents |
|---|---|---|---|---|
| **M0-01** | deux hosts simultanés · mort d'un host sans effet sur l'autre · tour mené à terme **pendant** la mort de l'autre, sans stale | **approbations simultanées** | plafond `promptUnmatched` du host — le mode `ask` n'a présenté aucune demande | [M0-01-M0-14](2026-09-20-windows-ab-projects/M0-01-M0-14.md), [groupe 1](2026-09-20-windows-group1/README.md) |
| **M0-02** | `ephemeral` annoncé · détection de la mort du host · `Disconnected` + envoi bloqué + transcript conservé · échec de reprise **honnête** (`sessionNotFound [retryable=false]`) | reprise durable d'un tour | **contrat sidecar** : `session/read` et `session/resume` absents | [groupe 1](2026-09-20-windows-group1/README.md), [écarts](../SIDECAR-CONTRACT-GAPS.md) |
| **M0-03** | **les 4 critères** : envoi rejeté conserve le texte · double Entrée = 1 tour · brouillon et envoi survivent au rechargement · Entrée en composition IME ne soumet pas | variantes : IME chinois/coréen, rechargement **avant** acquittement, double clic **à la souris** | méthode | [rejet](2026-09-20-windows-group1/M0-03-envoi-rejete.md), [double envoi](2026-09-20-windows-group1/M0-03-double-envoi.md), [rechargement](2026-09-20-windows-group1/M0-03-rechargement.md), [IME](2026-09-20-windows-group1/M0-03-ime.md) |
| **M0-04** | interruption affichée (`Stopping…`) · état stale correctement signalé · aucun faux succès | **terminal confirmé** | **contrat sidecar** : `turn/completed`/`retracted`/`stopped` jamais émis | [groupe 1](2026-09-20-windows-group1/README.md), [écarts](../SIDECAR-CONTRACT-GAPS.md) |
| **M0-10** | guidance d'échec exercée sur sidecar neutralisé : `sidecar`/`binary`/`triple`/`folder`, **Try again**, **Choose workspace folder**, aucune installation implicite | **machine propre** | infrastructure (WSL, Muse et des conversations déjà présents) | [M0-10](2026-09-20-windows-m010/M0-10-guidance-echec.md) |
| **M0-11** | copie anglaise sur 7 surfaces et 129 fichiers sources · câblage des helpers de navigation **verrouillé par test** · `displayPath()` couvert, cas UNC limites inclus | rendu natif des infobulles · branche `Cmd` sur un vrai macOS | infrastructure | [copie](2026-09-20-windows-language/M0-11-copie-anglaise.md), [navigation](2026-09-20-windows-language/M0-11-navigation.md), [chemins](2026-09-20-windows-language/M0-11-display-path.md) |
| **M0-12** | `forced-colors` honoré · 24 arrêts de tabulation sans piège · `Ctrl+F` lié · contraste AA sur 60 textes · **un défaut corrigé** (`prefers-contrast` inerte) avec test de non-régression | **lecteur d'écran réel** | hors de portée | [M0-12](2026-09-20-windows-a11y/M0-12.md) |
| **M0-14** | idem M0-01 | idem M0-01 | idem M0-01 | [M0-01-M0-14](2026-09-20-windows-ab-projects/M0-01-M0-14.md) |
| **M1-06** | `userShell` **négocié et accepté** | item publié, `outputRef`, sortie relisible | **contrat sidecar** | [écarts](../SIDECAR-CONTRACT-GAPS.md) |
| **M1-10** | admission en file persistée · panneau **Queued messages** ordonné · `Stopping…` · file vidée après Stop · **retrait séquentiel** · **course : les tours retirés ne démarrent pas** | compte exact des clics · accusé `turn/unqueue` du host · une anomalie de journal non expliquée | méthode + contrat sidecar | [retrait](2026-09-20-windows-group1/M1-10-retrait-file.md), [course](2026-09-20-windows-group1/M1-10-course-file.md) |
| **M1-11** | `setModel` et `setReasoningEffort` **acceptés** | projection effective | **contrat sidecar** : `projection: not-reported`, `isActive: false` | [écarts](../SIDECAR-CONTRACT-GAPS.md) |
| **M1-13** | fenêtre bornée à **160 articles sur 2 001** · chargement incrémental de 120 à DOM constant · finder atteignant un **résultat hors fenêtre** · coût de rendu mesuré · **plafonds de persistance verrouillés par test** · **coût d'écriture chiffré et sa fréquence observée** | **qualification assistive** · mesures sur build de développement seul | hors de portée · infrastructure | [fenêtre](2026-09-20-windows-transcript/M1-13.md), [finder](2026-09-20-windows-transcript/finder-hors-fenetre.md), [rendu](2026-09-20-windows-transcript/perf-rendu.md), [plafonds](2026-09-20-windows-transcript/plafonds-persistance.md), [coût](2026-09-20-windows-transcript/cout-ecriture-journal.md), [fréquence](2026-09-20-windows-transcript/granularite-ecritures.md) |
| **M3-07** | miroir natif du registre des exécutions rendu **importable par un test** et couvert (contrat d'échec, ordre du garde) | appel IPC réel · écriture durable dans l'app empaquetée | hors de portée d'un processus node | [schedule ledger](2026-09-20-windows-ledgers/schedule-ledger-et-garde.md) |
| **M3-09** | miroir natif des notifications couvert · **fusion des écritures** vérifiée | appel IPC réel | idem | [modules inatteignables](2026-09-20-windows-ledgers/modules-inaccessibles-aux-tests.md) |
| **M4-01** | navigation native (iframe montée) · persistance par onglet · **isolation par `sessionId`** | qualification macOS/Linux · téléchargements initiés par navigation | infrastructure | [M4-01-M4-02](2026-09-20-windows-browser/M4-01-M4-02.md) |
| **M4-02** | annotation **réellement créée** (ancre URL, citation, commentaire) · **garde de contexte** après changement de domaine | recadrage de région · capture visuelle | infrastructure | [M4-01-M4-02](2026-09-20-windows-browser/M4-01-M4-02.md) |
| **M4-09** | build NSIS (SHA-256 vérifié) · **installation et désinstallation sans perte** · **mise à jour 0.0.9 → 0.1.0 sans perte** · chaîne delta (~1250× plus petite, reconstruction à l'octet près) | **machine propre** · **signature** (`NotSigned`) · MSI · rollback réel | infrastructure | [build](2026-09-20-windows-release/M4-09.md), [cycle](2026-09-20-windows-release/M4-09-cycle-installation.md), [mise à jour](2026-09-20-windows-release/M4-09-mise-a-jour.md) |

Tickets **non entamés** faute d'accès : M2 et M3 (hors M3-07 et M3-09) demandent un host qui expose les contrats correspondants ; voir leurs lignes dans [`../ROADMAP.md`](../ROADMAP.md).

## Outils de mesure livrés

Tous sous `scripts/`. Les scripts `cdp-*` supposent l'application lancée avec `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` ; ils activent une fonctionnalité de WebView2 et **ne modifient pas** le code de l'application.

| Script | Rôle | Coût modèle |
|---|---|---|
| `msp-probe.mjs` | décrit le contrat du host (surfaces, `userShell`, `approval/listPending`) | **aucun** |
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
| `cdp-stream-granularity.mjs` | nombre et volume des écritures de journal d'un tour | un tour |
| `cdp-delete-conversations.mjs` | supprime des conversations de test par la boîte de dialogue de l'application | aucun |
| `bench-log-append.mts` | coût d'un ajout au journal selon sa taille | aucun |

### Passe UX 1 (21 septembre 2026)

| Script | Rôle | Coût modèle |
|---|---|---|
| `ux-capture.mjs` | 13 surfaces de l'interface, préconditions assertées | aucun |
| `ux-force-conversation.mjs` | force la vue conversation et les 8 onglets du panneau | aucun |
| `ux-contrast-audit.mjs` | ratios WCAG réels, alpha composé, thème clair ou sombre | aucun |
| `ux-panel-overflow.mjs` | débordements par onglet, **auto-test bloquant** | aucun |
| `ux-breakpoint-sweep.mjs` | 13 largeurs de fenêtre, fuites superficielles **et imbriquées** | aucun |
| `ux-review-captures.mjs` | captures + assertions structurelles | aucun |
| `ux-terminal-contrast.mjs` | contraste WCAG des contrôles, état actif **et** désactivé | aucun |
| `ux-target-size-audit.mjs` | cibles < 24×24 px, débordement, éléments rognés par un ancêtre | aucun |
| `ux-session-meta-probe.mjs` | projection brute du pont Rust (autorité sur le rendu) | aucun |
| `ux-react-state-probe.mjs` | prop React lue sur la fibre, quand DOM et pont se contredisent | aucun |
| `ux-verify-pass2.mjs` | vérifie les décisions de la passe 2 au DOM et par capture | aucun |
| `ux-terminal-state.mjs` | état des actions du terminal **et la raison** de leur indisponibilité | aucun |
| `ux-read-logs.mjs` | transcript lu depuis l'état du hook, pas depuis le DOM | aucun |
| `ux-run-in-muse.mjs` | exerce `Run in Muse` : saisie, activation, clic, attente de l'item | un appel shell |
| `msp-user-shell-items.mjs` | le host publie-t-il les items `userShell` ? (**forme de capacité corrigée**) | un appel shell |
| `msp-user-shell-after-resume.mjs` | `userShell` avant/après `session/resume`, sur une session neuve | un appel shell |
| `check-scripts-parse.mjs` | garde-fou : tout script de `scripts/` doit compiler | aucun |

**`ux-panel-overflow.mjs` refuse d'imprimer le moindre chiffre si son auto-test échoue** : une sonde de 300 px dans une boîte de 100 px doit être signalée à +200 px, et la même sonde avec `overflow-x: hidden` doit être ignorée. Ce garde-fou existe parce que trois versions successives de ce détecteur ont produit des rapports plausibles et faux — détails dans [`2026-09-21-ux/debordement-desktop.md`](2026-09-21-ux/debordement-desktop.md).

`ux-review-captures.mjs` porte un avertissement : il force la largeur du panneau **sans** changer celle de la fenêtre, ce qui produit un état qu'aucune fenêtre réelle ne peut atteindre. Pour les questions de mise en page responsive, l'instrument est `ux-breakpoint-sweep.mjs`.

## Documents qui tracent un échec ou une erreur

Six documents conservent un résultat négatif ou une erreur de méthode. Ils sont volontairement conservés :

| Document | Ce qu'il trace |
|---|---|
| [M0-03-envoi-rejete-inabouti](2026-09-20-windows-group1/M0-03-envoi-rejete-inabouti.md) | première tentative d'envoi rejeté, remplacée depuis |
| [M1-10-retrait-file-inabouti](2026-09-20-windows-group1/M1-10-retrait-file-inabouti.md) | file jamais alimentée — préconditions non vérifiées |
| [finder-hors-fenetre-inabouti](2026-09-20-windows-transcript/finder-hors-fenetre-inabouti.md) | mauvais sélecteur : le conteneur du finder au lieu de son ouvreur |
| [M0-12](2026-09-20-windows-a11y/M0-12.md) | contient le faux positif « aucun indicateur de focus » **et** sa correction |
| [modules-inaccessibles-aux-tests](2026-09-20-windows-ledgers/modules-inaccessibles-aux-tests.md) | faux diagnostic initial : 15 modules annoncés au lieu de 2 |
| [nettoyage-conversations](2026-09-20-windows-cleanup/nettoyage-conversations.md) | **trois** méthodes de suppression en échec avant la bonne |
| [debordement-desktop](2026-09-21-ux/debordement-desktop.md) | **trois** bugs d'instrument successifs, dont un `NaN` silencieux qui vidait le rapport ; remplace une version dont tous les chiffres étaient faux |
| [revue-passe2](2026-09-21-ux/revue-passe2.md) | **quatre faux positifs** (dont deux que j'avais relayés) et une hypothèse de doublon **réfutée par les données persistées** |
| [m1-06-blocage-refute](2026-09-21-ux/m1-06-blocage-refute.md) | un « constat bloquant » publié contre le host, réfuté : la sonde demandait la capacité **à plat** et n'exécutait donc jamais la commande |
| [m1-06-capacites-au-montage](2026-09-21-ux/m1-06-capacites-au-montage.md) | trois sources qui se contredisent sur la même capacité, et le défaut de synchronisation qui les explique |

## Erreurs de méthode de la campagne, documentées plutôt que corrigées en silence

1. **Indicateur de focus** : conclu absent en cadrant le seul `TEXTAREA`. L'anneau est sur le conteneur.
2. **`prefers-contrast`** : d'abord attribué à la spécificité, correctif tenté, **échec**, correctif retiré, diagnostic corrigé, hypothèse réelle testée **hors du dépôt** avant application.
3. **Ordre des entrées du transcript** : `streamWindowStart` est un offset depuis la fin, donc un marqueur « hors fenêtre » était en fait **dedans**.
4. **Assertion tautologique sur Windows** : `pathToFileURL(url.pathname).pathname` diffère de `url.pathname` (double barre oblique), ce qui a fait échouer 92 tests pour rien.
5. **Test faux, pas code faux** : `createLatestWriteQueue` fusionne délibérément les écritures ; mon assertion attendait l'inverse.
6. **`returnByValue` oublié** sur `Runtime.evaluate` : renvoie une référence distante, donc `undefined`, indiscernable d'un échec.
7. **Cycles de test sans vérification d'état initial** : quatre tests ont échoué faute d'avoir confirmé l'état de départ ou l'identité de la conversation.

## Ce que cette campagne n'a pas fait

- **Aucune preuve macOS ni Linux**, pour aucun ticket.
- **Aucune qualification par un lecteur d'écran réel.**
- **Aucun test sur machine propre** : la machine de test a déjà WSL, Muse et des conversations.
- **Aucune installation signée** : les deux installeurs sont `NotSigned`.
- **Aucun test des contrats M2 et M3** (worktrees, MCP, scheduler, notifications) hors les deux ledgers.
- **Aucune correction du produit** hors le défaut `prefers-contrast` : cette campagne mesure et documente, elle ne refactorise pas.
