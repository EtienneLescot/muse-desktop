# Roadmap opérationnelle — Muse-Desktop

État de référence : **20 septembre 2026**, dépôt à `064e210` (main, après fusion des PRs #18–#153).
Mis à jour le **27 septembre 2026** par une campagne de **qualification native Windows** (dépôt à `362c8bb`, PRs jusqu'à #227) : preuves dans [`docs/evidence/2026-09-27-qualif-native/`](evidence/2026-09-27-qualif-native/). Objectif : finir les parcours existants, puis atteindre la parité des workflows desktop de Codex en conservant le branding Muse. Ordre M0 → M4 validé par Étienne.

Ce document est la source de vérité de l'avancement produit. Il est découpé **par plateforme** parce que la majorité des tickets restants ne se ferment pas au même moment selon l'OS. La [SPEC](SPEC.md) conserve les intentions initiales ; le [bilan du 13 septembre](plans/2026-09-13-roadmap-progress.md) est historique. L'[audit de parité](plans/2026-09-15-codex-parity-audit.md) contient les constats techniques et références officielles. Les chiffres de stories fusionnées ne sont pas un taux de parité.

**Pour les agents de codage :** le [plan d'implémentation détaillé](plans/2026-09-15-agent-implementation-plan.md) couvre les 53 IDs ci-dessous : code à lire, contrats proposés, étapes, dépendances, tests d'acceptation et format de livraison. Ce plan complète les statuts ; il ne constitue pas une preuve d'implémentation.

> **Révision du 20 septembre 2026.** Cette roadmap remplace la version précédente, organisée par axes (Design / UI / Fonction / Validation) et enrichie de bilans de livraison détaillés. Elle est désormais organisée par **état d'avancement** et par **plateforme**, avec trois états seulement. La version antérieure reste consultable dans l'historique Git :
>
> ```sh
> git show 064e210:docs/ROADMAP.md        # version par axes, 720 lignes, blob 319cb128
> ```
>
> Rien n'a été perdu : les bilans de livraison, les mesures de tests et les empreintes de bundles de l'ancienne version restent dans cet historique. Les constats de limites qui conditionnent les critères de sortie ont été repris ici ticket par ticket.

## Point d'étape — qualification native Windows (27 septembre 2026)

Campagne de qualification native (app Tauri + webview, pilotage CDP ; preuves dans
[`docs/evidence/2026-09-27-qualif-native/`](evidence/2026-09-27-qualif-native/)).

**Prouvé nativement cette campagne :** M0-01 deux projets simultanés · M0-02/03 arrêt du host →
message honest « Its process exited… » + recovery en 7,6 s (cause racine : drop stdin) · M0-04
Stop → terminal avec `turnId` + phases **avant premier token / réponse tardive / après la fin** +
variante « pendant outil » (lane sous-agent en vol) · M1-05 PTY : défaut isolé sur
`portable-pty 0.9.0` · M1-06 chaîne Run in Muse prouvée + déclenchement corrigé + défaut
environnement de spawn isolé · M1-10 queue : course propre à deux tours + **restauration et reprise
après `taskkill /F`** · M1-11 modèle effectif par session + défaut de label UI · M2-03/07 worktrees
et lanes sous-agents + défaut « Create & open » · M3-06/07 run sans clic, bail natif, claim
anti-doublon, DST résolus · M3-08 cartes de run · M3-09 notification persistée.

**Défauts ouverts à corriger (preuves jointes) :** sandbox shell indisponible pour un host lancé
par l'app (`m1-06-run-in-muse-sandbox.md`) · PTY sans sortie (`m1-05-pty-sortie-vide.md`) · label
de modèle partagé entre fils (`m1-11-bascule-modele.md`) · worktree créé mais inutilisé
(`m2-worktrees.md`) · comparaison de chemins `G:\…` vs `\\?\G:\…` qui rend toute cible sur
conversation existante impossible (`m3-automations-reveil.md`) · « Review needed » jamais marqué
après redémarrage · avertissements DST absents · libellés de boutons (« Stop the running sidecar »,
`terminal.read-output` en contenu au lieu de rôle).

**Reste à qualifier :** M0-05/07/11-14 (stale races, support macOS/Linux, CI, installations), M1
restants (PTY en commande interactive, outil pendant outil strict, clavier et attachments en UI
réelle, empaqueté), M2 restants (fermeture avec agents actifs, Local↔Worktree, fan-out de
sous-agents), M3-01 à 05 (MCP, extensions, skills), réveil `AutomationWake` réel.

## Comment lire cette roadmap

### Trois états, un seul critère

| État | Signification |
|---|---|
| ☐ **Pas commencé** | Aucun code, aucune interface, ou ticket volontairement reporté faute de spécification produit. |
| ◐ **Commencé** | Du code ou une interface existe et est couvert par des tests, **mais au moins un critère de sortie n'est pas prouvé** sur la plateforme concernée. |
| ☑ **Terminé** | Tous les critères de sortie du ticket sont prouvés **sur cette plateforme précise**, avec une preuve reproductible. |

**Règle de fermeture.** Un ticket n'est **Terminé** que lorsque l'effet réel est obtenu, les erreurs et la reprise sont traitées, les permissions effectives sont respectées, le scénario a été validé nativement **et** les limites sont documentées. Une interface présente, un test unitaire vert ou un accusé de réception du host ne suffisent jamais à clore un ticket.

**Règle de plateforme.** Un ticket sans dépendance OS est évalué une seule fois (colonnes `Global` fusionnées). Un ticket dépendant d'un runtime natif est évalué **par OS**, et un statut favorable sur Windows ne dit rien de macOS ni de Linux.

### Conventions de plateforme

- **Windows** — cible principale. WebView2, sidecar Muse x64 et smoke natif sur deux hôtes réels. Toutes les validations natives existantes ont été produites ici.
- **macOS** — cible annoncée, **aucune validation native produite à ce jour**.
- **Linux** — cible annoncée et **plateforme de la CI**. Attention : la CI (`ubuntu-latest`) exécute `npm test`, `npm run build` et `cargo test` — c'est-à-dire les contrats purs et le superviseur Rust — mais **ne lance ni webview, ni sidecar Muse réel, ni installeur**. Une CI verte sur Linux n'est pas une preuve d'exécution Linux.
- **`n/a`** — la plateforme n'est pas concernée par ce ticket.

### Notes de lecture

- **« Câblée » n'est pas « Terminé ».** La quasi-totalité des tickets M0–M4 a du code livré et des tests unitaires ; ce qui bloque la fermeture est presque toujours la **preuve native**. C'est pourquoi le statut dominant est ◐ Commencé.
- **L'exécution des futurs tickets est à planifier** : un état ◐ décrit le code existant, pas un chantier en cours.
- Les dépendances ne sont pas levées partout : `M1-01 → M1-02/03/04`, `M0-01 → M1-05/06/09/10`, `M2-03 → M2-04/05/06/08`, `M3-06/07 → M3-09`. Une dépendance non levée interdit de déclarer son résultat livré.

## Point d'étape — 20 septembre 2026

**Preuves reproductibles actuelles :** mesurées sur **Windows** le 20 septembre 2026 au commit `064e210` — `npm test` : **829 tests Node, 193 suites, 0 échec** (11,0 s) ; `npm run build` : **vert** (`tsc --noEmit` + Vite) ; `cargo test --manifest-path src-tauri/Cargo.toml` : **200 tests Rust, 0 échec**. La CI exécute les deux suites sur `ubuntu-latest` avec des placeholders de frontend et de sidecar, sans credential ni tour modèle.

> **Le nombre de tests Rust dépend de la plateforme.** `scheduler_wakeup.rs` porte des tests gatés par `#[cfg(target_os = …)]` (Task Scheduler / `launchd` / `systemd`) : au même commit `064e210`, la mesure Windows donne **200** tests là où les publications antérieures annonçaient **194**. Ne pas comparer un total Rust obtenu sous Linux avec un total obtenu sous Windows sans le dire.
>
> Pour rejouer ces mesures localement, deux prérequis non versionnés sont nécessaires : `npm ci`, puis un placeholder de sidecar (Tauri valide chaque `externalBin` et `frontendDist` à la compilation) et un `dist/` produit par `npm run build`. Les tests Rust n'exécutent aucun sidecar.
>
> Les totaux Node sont, eux, identiques sur les trois OS — mais n'ont été exécutés nativement que sous Windows et Linux (CI).

**Campagne native du 20 septembre 2026 (groupe 1, pilotage CUA puis CDP) :** [`docs/evidence/2026-09-20-windows-group1/`](evidence/2026-09-20-windows-group1/). Premier exercice de l'application Tauri avec le **binaire Muse Windows natif** comme sidecar, et non le pont WSL utilisé jusqu'ici : tour modèle live complet dans la webview, détection de la mort du host (`Disconnected`, pastille `Connection error`, envoi bloqué, transcript intégralement conservé), récupération explicite échouant proprement sur une session `ephemeral`, et texte conservé sans host disponible.

**Déblocage du pilotage UI (round 3) :** l'arbre UI Automation n'expose pas le DOM de la webview et l'entrée clavier synthétique ne l'atteint pas ; les scénarios d'acceptation « depuis la webview » étaient donc hors de portée. Lancer la version de développement avec `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` expose un endpoint CDP, exploité par **`scripts/cdp-drive.mjs`** (inspection, remplissage, clic sur le DOM réel) et **`scripts/cdp-scenario.mjs`** (scénario borné, `--live` pour un tour modèle). Instrumentation de développement uniquement : elle active une fonctionnalité de WebView2, elle ne modifie pas le code de l'application. Un premier scénario live a observé l'admission en file (`muse-desktop.queued-turns.v1`), le panneau **Queued messages** ordonné avec son action d'enlèvement, l'état **`Stopping…`**, puis l'absence de terminal et la bascule en stale.

**Aucun ticket du groupe 1 n'est clos pour autant** — les critères restants sont listés dans le document de preuves.

**Campagne du 20 septembre 2026 — état consolidé (27 PR mergées, #154 à #180) :** les preuves natives sont regroupées sous [`docs/evidence/`](evidence/), un dossier par sujet, et le contrat du sidecar est analysé dans [`SIDECAR-CONTRACT-GAPS.md`](SIDECAR-CONTRACT-GAPS.md).

| Ticket | Ce qui est désormais mesuré | Livrable |
|---|---|---|
| **M0-03** | **les 4 critères du ticket** : envoi rejeté (skill inconnue) conserve le texte · double Entrée n'admet qu'un tour (1 identifiant client) · brouillon et envoi en cours survivent au rechargement · Entrée pendant une composition IME **ne soumet pas** | [#177](https://github.com/EtienneLescot/muse-desktop/pull/177) [#178](https://github.com/EtienneLescot/muse-desktop/pull/178) [#179](https://github.com/EtienneLescot/muse-desktop/pull/179) [#180](https://github.com/EtienneLescot/muse-desktop/pull/180) |
| **M0-10** | guidance d'échec exercée sur un cas réel : sidecar neutralisé → panneau `sidecar`/`binary`/`triple`/`folder` avec **Try again** et **Choose workspace folder**, aucune installation implicite | [#172](https://github.com/EtienneLescot/muse-desktop/pull/172) |
| **M0-12** | `forced-colors` honoré (couleurs système sur les 5 contrôles) · 24 arrêts de tabulation sans piège · `Ctrl+F` lié au finder · contraste AA sur 60 textes · **un défaut corrigé** : la règle `prefers-contrast` était inerte, avec test de non-régression | [#162](https://github.com/EtienneLescot/muse-desktop/pull/162) [#163](https://github.com/EtienneLescot/muse-desktop/pull/163) [#165](https://github.com/EtienneLescot/muse-desktop/pull/165) |
| **M1-13** | fenêtre DOM bornée à **160 articles sur 2 001** · chargement incrémental de **120 entrées** avec DOM constant · finder atteignant un résultat **hors fenêtre** · coût de rendu mesuré (layout 12 ms, script 2,02 s, +160 KiB de tas) | [#166](https://github.com/EtienneLescot/muse-desktop/pull/166) [#167](https://github.com/EtienneLescot/muse-desktop/pull/167) [#169](https://github.com/EtienneLescot/muse-desktop/pull/169) [#170](https://github.com/EtienneLescot/muse-desktop/pull/170) |
| **M4-01 / M4-02** | navigation native, isolation par `sessionId`, annotation créée, **garde de contexte après navigation** prouvée | [#154](https://github.com/EtienneLescot/muse-desktop/pull/154) [#155](https://github.com/EtienneLescot/muse-desktop/pull/155) |
| **M4-09** | installation, désinstallation et **mise à jour de version montante** exécutées sans perte : 64 conversations et 2 projets identiques après chaque transaction | [#174](https://github.com/EtienneLescot/muse-desktop/pull/174) [#176](https://github.com/EtienneLescot/muse-desktop/pull/176) |
| **M0-01 / M0-14** | deux hosts simultanés · mort d'un host sans effet sur l'autre · tour mené à terme **pendant** la mort de l'autre host, sans stale | [#158](https://github.com/EtienneLescot/muse-desktop/pull/158) [#159](https://github.com/EtienneLescot/muse-desktop/pull/159) |

**Ce qui bloque encore, par nature :**

- **M1-06 : RÉFUTÉ le 21/09/2026.** Le « blocage côté host » venait d'une sonde qui demandait la capacité sous une forme que le host lit comme « aucune capacité demandée ». Avec la forme correcte, le sidecar 1.3.0 **publie bien** les items `userShell` **et** leur sortie. Détail et mesures dans la ligne M1-06 plus bas ; **ne citez plus `SIDECAR-CONTRACT-GAPS.md` pour ce ticket.**
- **M0-04, M1-11 : revérifiés le 27/09/2026 — les deux « blocages sidecar » étaient faux.** Le host **émet** bien une notification terminale (`turn/completed` à **+36 ms** après `turn/interrupt`) et **rapporte** bien les projections de modèle (`model_id` sur la session, `is_active` sur `model/list`) ; la mesure qui les étayait partageait le harnais `--no-session-log` de M1-06 (voir [`session-log-expique-tout.md`](evidence/2026-09-27-qualif-native/session-log-expique-tout.md)). **Seul `outputRef` reste plausible** dans [`SIDECAR-CONTRACT-GAPS.md`](SIDECAR-CONTRACT-GAPS.md). M0-04 garde ses phases d'arrêt spéciales à qualifier — côté scénario, pas côté host.
- **Révision du 27/09/2026 :** M0-02 et M0-03 **fermés sur Windows** (preuves : [`m0-02-reprise-apres-mort-host.md`](evidence/2026-09-27-qualif-native/m0-02-reprise-apres-mort-host.md), [`M0-03-texte-en-rejet-conserve.md`](evidence/2026-09-20-windows-group1/M0-03-texte-en-rejet-conserve.md)) ; M0-04 **avancé à la preuve du `turnId` transmis et de la résolution en ~1 s** ([`m0-04-stop-terminal.md`](evidence/2026-09-27-qualif-native/m0-04-stop-terminal.md)).
- **M0-01** : le critère « approbations simultanées » reste ouvert — le plafond du host est `promptUnmatched` et aucune demande d'approbation n'a pu être provoquée, même en mode `ask`.
- **M0-10, M4-09** : la « machine propre » n'est pas couverte — la machine de test a déjà WSL, Muse et 64 conversations. La signature des installeurs est également absente (`NotSigned`).
- **M0-12, M1-13** : la qualification par un **lecteur d'écran réel** n'a pas été faite ; les rôles et libellés observés sont une condition nécessaire, pas une preuve d'annonce correcte.
- **M4-01, M4-02** : la qualification **macOS et Linux** n'existe pas.
- **M0-11, M1-10** : partiels.

**Trois erreurs de la campagne, corrigées et conservées** : un faux positif sur l'indicateur de focus (mesuré sur le champ au lieu du conteneur), un diagnostic erroné sur `prefers-contrast` (spécificité au lieu de l'ordre de déclaration, avec correctif retiré puis validé autrement), et une confusion sur l'ordre des entrées du transcript qui avait produit un « succès » sans valeur. Les documents concernés gardent les deux versions.

**Preuve navigateur intégré (20/09/2026) :** [`docs/evidence/2026-09-20-windows-browser/`](evidence/2026-09-20-windows-browser/M4-01-M4-02.md). Les onglets de la barre de travail n'existent dans le DOM qu'une fois le panneau latéral déplié — un point qui avait fait conclure à tort à leur inaccessibilité. Sur une conversation ouverte, les sept onglets **Content · Review · Terminal · Files · Browser · Desktop · Memory** sont présents. En **M4-01**, la navigation native est prouvée dans la webview : `<input type="url">`, `iframe` montée sur `https://example.com/`, persistance par onglet et **isolation par `sessionId`** (deux clés `browser.tabs.v1.session.*` distinctes). En **M4-02**, les trois champs d'annotation sont présents, une **annotation a réellement été créée** (ancre URL normalisée, citation de sélection, commentaire, identifiant et horodatage persistés), et la **garde de contexte après navigation est prouvée** : après passage de l'onglet à un autre domaine, les notes ancrées sur la première page cessent d'être affichées (2 → 0) tout en restant persistées avec leur ancre d'origine. Restent ouverts pour M4-02 le recadrage de région et la capture visuelle.

**Dernière preuve native (Windows, 19–20 septembre 2026) :** deux sidecars Muse Code 1.3.0 réels, deux sessions et workspaces distincts ; smoke `--exercise-control --exercise-errors --exercise-approval --exercise-isolation --exercise-user-shell --exercise-reconnect --exercise-history --exercise-reasoning --exercise-model --exercise-queue --exercise-compaction` réussi ; dogfood natif du 20/09 sur le pont MCP direct (parcours Tab, frappe, Ctrl+F, zoom natif Ctrl+0 puis Ctrl+Plus×2).

**Limites de plateforme connues :**

- Le host Muse 1.3.0 observé reste **`ephemeral`** : `session/read` et `view/page` répondent `methodNotFound`, donc la reprise durable et la réconciliation native restent non démontrées, quel que soit l'OS. **Correction (20/09/2026) :** `approval/listPending` **est** disponible dès qu'on lui passe un `sessionId` et retourne `{approvals, userInputs}` — c'est un appel sans `sessionId` qui produit `methodNotFound`. Les mentions antérieures qui le classaient comme absent doivent être relues ; voir [`msp-probe.mjs`](../scripts/msp-probe.mjs) et le [rapport de campagne](evidence/2026-09-20-windows-group1/).
- **Aucune preuve native macOS ni Linux** n'existe dans ce dépôt à ce jour, pour aucun ticket.
- Le contrôle desktop (`desktop_control.rs`) et le navigateur natif (`muse-browser`) sont **Windows uniquement** ; macOS et Linux renvoient explicitement `supported: false`.
- **`turn/completed`, `turn/retracted` et `turn/stopped` ne sont jamais émis**, même après `turn/interrupt` ou un `Stop` utilisateur : l'état final d'un tour est **déduit** côté client, jamais reçu. Constaté sur deux hosts réels et depuis l'interface.

**Prochaine reprise :** les preuves natives M0 sur Windows sont largement avancées (voir le tableau consolidé ci-dessus). Ce qui reste dépend de trois natures de travail :

1. **Côté sidecar** — **plus aucun blocage mesuré** (révision du 27/09/2026). La notification terminale de tour existe (`turn/completed` à +36 ms), les projections de modèle existent, la reprise `session/read`/`session/resume` fonctionne. Seul `outputRef` reste à confirmer dans [`SIDECAR-CONTRACT-GAPS.md`](SIDECAR-CONTRACT-GAPS.md). La leçon de méthode reste valable : mesurez avec les formes du contrat (`capabilities` imbriqué, host avec log de session), sinon vous fabriquez des blocages fictifs.
2. **Côté infrastructure** — machine propre pour M0-10 et M4-09, signature Authenticode des installeurs, hébergement du canal de mise à jour, VM macOS et Linux pour M4-01/M4-02.
3. **Côté méthode** — qualification par un lecteur d'écran réel pour M0-12 et M1-13 ; compléter les variantes de scénarios déjà couverts (IME chinois et coréen, rechargement avant acquittement, double clic à la souris pour M0-03 ; les phases d'arrêt restantes de M0-04 : avant premier token, pendant outil, après fin, réponse tardive ; services nommés et verrous pour M1-05 et M2-08) ; M0 et M1 restants en qualification native Windows (scénarios outillés : `cdp-concurrent-turns`, `cdp-queue-race`, `cdp-ab-projects`, `cdp-stop-terminal`).

Les critères restants et leurs limites précises sont énumérés dans chaque document de [`docs/evidence/`](evidence/) : aucun des documents de cette campagne ne déclare un ticket clos sur un seul scénario.

## Récapitulatif

### Par état

| État | Total | Répartition |
|---|---|---|
| ☐ Pas commencé | **1** | M4-06 |
| ◐ Commencé | **49** | tout le reste |
| ☑ Terminé | **3** | M1-12, **M0-02** et **M0-03** (prouvés sur Windows le 20-27/09) |
| **Total** | **53** | |

Ce récapitulatif est volontairement sévère : 49 tickets ont du code livré, mais ne réunissent pas encore l'ensemble de leurs critères de sortie sur une plateforme. Les trois tickets clos : M1-12 sans **aucune** dépendance OS ni native ; M0-02 et M0-03 dont les critères sont entièrement prouvés dans la webview Windows ([preuves](evidence/2026-09-27-qualif-native/)) — les colonnes macOS/Linux de ces deux-là restent ◐, faute de preuve native sur ces plateformes.

### Par plateforme

Les 53 tickets se répartissent en trois groupes, dénombrés depuis les tableaux ci-dessous.

| Groupe | Tickets | ☐ | ◐ | ☑ |
|---|---|---|---|---|
| **A** — sans dépendance OS (colonne `Global` renseignée) | 34 | 1 | 31 | 2 |
| **B** — dépendants d'un runtime natif (colonne `Global` = `—`) | 18 | 0 | 18 | 0 |
| **C** — M1-12, clos et identique sur les trois OS | 1 | 0 | 0 | 1 |
| **Total** | **53** | **1** | **49** | **3** |

Le groupe B est le seul à porter du code **différent** selon la plateforme : c'est là que la distinction par OS change réellement la réponse.

Répartition exacte des 18 tickets du groupe B (◐ sur Windows, ☐ sur macOS et Linux) :

- **M0** (5) : M0-01, M0-05, M0-06, M0-08, M0-10
- **M1** (4) : M1-06, M1-09, M1-10, M1-11
- **M2** (3) : M2-02, M2-05, M2-07
- **M3** (1) : M3-05
- **M4** (5) : M4-01, M4-02, M4-03, M4-04, M4-09

Les 18 tickets du groupe B sont donc les seuls dont la fermeture est **atteignable à court terme sur Windows** : leur code existe et la chaîne de preuve native y est déjà outillée (`smoke:native`, bundles NSIS/MSI, dogfood). Hors Windows, aucun d'eux n'est commencé.

À l'inverse, **15 tickets du groupe A affichent ◐ sur macOS et Linux alors que le code est partagé et non spécifique** : M0-02, M0-03, M0-09, M1-01, M1-02, M1-03, M1-04, M1-07, M1-08, M1-13, M3-01, M3-03, M3-04, M3-08, M4-07. Pour eux, le ◐ hors Windows reflète **l'absence de preuve native**, pas un défaut de code : ils sont mécaniquement moins chers à fermer que le groupe B.

Parmi les tickets du groupe A, **trois** restent ☐ sur macOS et Linux au lieu de ◐ : **M0-04**, **M3-02** et **M4-06**. Les deux premiers portent une dépendance OS réelle malgré une colonne `Global` favorable — la preuve terminale dépend du comportement du host pour M0-04, le trousseau macOS et Secret Service Linux n'ont jamais été exercés pour M3-02 — tandis que M4-06 est reporté faute de spécification produit. Tous les autres tickets du groupe A se contentent d'attendre une preuve native sur du code déjà partagé.

> **Convention de la colonne `Global` :** elle porte l'état du ticket considéré indépendamment de l'OS, c'est-à-dire **le meilleur état atteint**. Elle n'affirme pas que les trois plateformes sont au même niveau — seules les colonnes par OS le font.

---

## M0 — Fiabiliser et finir l'existant

*Priorité immédiate. Ne pas ajouter de nouvelles surfaces avant de sécuriser ces parcours.*

| ID | Résultat attendu | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M0-01 | A continue à travailler quand on ouvre le projet B | — | ◐ | ☐ | ☐ |
| M0-02 | Reprendre une conversation après fermeture ou panne du moteur | ☑ | ☑ | ◐ | ◐ |
| M0-03 | Ne perdre aucun texte lors d'un envoi rejeté | ☑ | ☑ | ◐ | ◐ |
| M0-04 | Arrêter et reprendre avec des états fiables | ◐ | ◐ | ☐ | ☐ |
| M0-05 | Répondre aux permissions/questions même après incident | — | ◐ | ☐ | ☐ |
| M0-06 | Afficher la politique de permissions réellement effective | — | ◐ | ☐ | ☐ |
| M0-07 | Protéger les diagnostics et éviter un crash sur Unicode | — | ◐ | ◐ | ◐ |
| M0-08 | Détecter une incompatibilité du moteur | — | ◐ | ☐ | ☐ |
| M0-09 | Conserver les données sans échec silencieux | ◐ | ◐ | ◐ | ◐ |
| M0-10 | Réussir le premier lancement | — | ◐ | ☐ | ☐ |
| M0-11 | Finir l'anglais et les détails de navigation | — | ◐ | ◐ | ◐ |
| M0-12 | Utiliser l'existant au clavier et au lecteur d'écran | — | ◐ | ◐ | ◐ |
| M0-13 | Identifier clairement les capacités non connectées | — | ◐ | ◐ | ◐ |
| M0-14 | Disposer de contrôles reproductibles avant fusion | — | ◐ | ◐ | ◐ |

### Détail

- ◐ **M0-01 — A continue à travailler quand on ouvre le projet B** *(Global : —)*
  - Windows ◐ — routage isolé par chemin canonique, appartenance explicite des sessions, isolation des approbations ; prouvé par deux processus enfants réels (Rust + Node) avec mort subite de B et complétion de A. **Reste :** E2E WebView2 empaquetée.
  - **Progrès natif (20/09/2026, CUA puis CDP) :** deux hosts simultanés observés ; mort du host B **sans effet** sur l'application, la conversation servie par A, les 58 sessions ou la file (aucun respawn, application toujours `Responding`). Puis, sur le host survivant : **nouvelle session créée (58 → 59), tour réel admis, conversation restée connectée, sous-agents passés de 1 à 3 `Completed`**.
  - **Critère manquant du 20/09 PROUVÉ le 27/09/2026** ([`m0-01-deux-projets.md`](evidence/2026-09-27-qualif-native/m0-01-deux-projets.md)) : tours longs concurrents dans les deux projets → host de B tué à 15:37:24 en plein tour → **tour A terminé à 15:38:10 sans erreur**, statut honnête de B à la seconde près. **Reste :** E2E WebView2 empaquetée (le scénario ci-dessus tourne en build dev) et répétition sur sessions fraîches.
  - macOS ☐ / Linux ☐ — qualification multi-OS non commencée. La webview n'est pas WebView2 hors Windows.
  - *Critère de sortie :* isolation prouvée depuis l'interface Tauri empaquetée, sur chaque OS annoncé.

- ◐ **M0-02 — Reprendre une conversation après fermeture ou panne** *(sans dimension OS)* — **rouvert le 27/09/2026 :** `taskkill /F` + relance peut **effacer `projects.v1` et `sessions.v1`** (toutes les conversations) tandis que file/runs/notifications survivent — alors qu'un kill identique plus tôt avait tout préservé ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)) ; la survie de la file et des runs est prouvée ([`m1-10-course-de-file.md`](evidence/2026-09-27-qualif-native/m1-10-course-de-file.md)), pas celle de projets/fils dans tous les modes de kill. **Cause trouvée dans le code :** `useMuseSessions.ts` L1875 + L2361-2383 — `useState(() => loadProjects())` avec repli `[]` sur lecture invalide, puis **write-through `useEffect` qui persiste `[]` au montage** : corruption transitoire → effacement permanent. Correctif suggéré : pas d'écriture au montage / jamais persister un repli de lecture invalide. **→ Correctif implémenté le 27/09/2026 :** gardes `sessionsHydratedRef`/`projectsHydratedRef` dans `useMuseSessions.ts` — l'état hydraté (éventuellement le repli) n'est **jamais** persisté, seules les mutations (nouvelle identité de tableau) écrivent (`npm test` 1133/1133 + `tsc` verts) ; reste à **rejouer le kill** pour prouver le comportement corrigé. **→ CORRECTIF CONFIRMÉ par rejeu le 27/09/2026 :** valeur corrompue `not-json-M02c` survit aux rechargements (+2 s, +10 s) sur le build corrigé — là où l'ancien build la remplaçait par `"[]"` en < 1 s ([`m0-02-fix-write-through.md`](evidence/2026-09-27-qualif-native/m0-02-fix-write-through.md), qui documente aussi le piège du front embarqué et la **rédemption par le host** : 59 fils reconstruits depuis son historique). État : pièces « panne » et « effacement » traitées ; reste le test du `taskkill /F` réel en conditions variées pour la clôture totale. **→ `taskkill /F` réel en plein tour RÉUSSI le 27/09/2026 :** kill brutal à +3 s d'un tour → projets **172 o octet à octet** + fils **13 557 → 13 578 o (59 → 61, JSON valide)** + 36 clés intactes — aucune corruption ni perte. Toutes les pièces de l'acceptation sont prouvées (non-envoyé = file prouvée M1-10, historique par fil = ce test, pas de second host = stop/relance immédiate) — seul le **brouillon** du composeur reste à éprouver directement.
  - Reconnexion explicite via `session/read` + `session/resume`, état de connexion par conversation (`disconnected / connecting / connected / error`), réhydratation des items pliés par `itemId`, liveness visible avec état stale, réconciliation bornée après 15 s de silence, fallback `view/page` par curseur, `session/list` paginé, pont **Muse is resuming**, bouton **Sync now**, détection de perte du ring d'événements.
  - **Prouvé le 27/09/2026 sur Windows** ([`m0-02-reprise-apres-mort-host.md`](evidence/2026-09-27-qualif-native/m0-02-reprise-apres-mort-host.md)) : mort du host en fonctionnement → statut honnête « Muse stopped because the host process ended. Reconnect to continue. » → `resume_session` sur host relancé (`loaded: true`, grants, modèle) → **historique complet relu** (`read_session_history`) → **nouveau tour exécuté**. Les trois critères du ticket sont couverts.
  - **Note du 27/09 :** l'ancien « Reste bloquant » (« le sidecar est `ephemeral` et ne sert pas `session/read`/`session/resume` ») était **faux** — mesuré avec un host `--no-session-log` (mémoire seule). Voir [`session-log-expique-tout.md`](evidence/2026-09-27-qualif-native/session-log-expique-tout.md).
  - macOS ◐ / Linux ◐ — code partagé, aucune preuve native sur ces plateformes.
  - *Critère de sortie :* reprise d'un tour réellement rejouée contre un host durable. **✓ fait sur Windows (27/09).**

- ☑ **M0-03 — Ne perdre aucun texte lors d'un envoi rejeté** *(sans dimension OS)*
  - Outbox durable par envoi (`clientMessageId`, `sending/accepted/failed`), brouillon vidé seulement à l'acquittement, vérification serveur avant retransmission, miroir natif sous `app_data/outbox/`, sidebar signalant les envois conservés.
  - **Prouvé le 20/09/2026 sur Windows** pour les 4 critères ([`M0-03-texte-en-rejet-conserve.md`](evidence/2026-09-20-windows-group1/M0-03-texte-en-rejet-conserve.md)) : envoi rejeté (skill inconnue) conserve le texte · double-Entrée n'admet qu'un tour · brouillon et envoi en cours survivent au rechargement · Entrée pendant une composition IME ne soumet pas.
  - **Reste (non bloquant) :** variantes de méthode — moteur coupé pendant l'envoi, double-clic souris, IME chinois et coréen (§Méthode) ; preuve macOS/Linux.
  - *Critère de sortie :* aucun texte perdu sur les quatre scénarios du ticket. **✓ fait sur Windows (20/09).**

- ◐ **M0-04 — Arrêter et reprendre avec des états fiables**
  - Windows ◐ — distinction demande acceptée (`Stopping Muse`) / terminal confirmé, `turnId` transmis, alias `turn/completed|retracted|stopped`, récupération bornée après accusé sans terminal, double-clic ignoré.
  - **Progrès décisif (27/09/2026, preuve native) :** [`m0-04-stop-terminal.md`](evidence/2026-09-27-qualif-native/m0-04-stop-terminal.md) — clic Stop depuis la webview → `cancel_session` avec **`turnId` non vide et correct** → état résolu en **1 s** (terminal serveur) → **relance immédiate**. La phrase « le host 1.3.x n'émet aucun terminal après `turn/interrupt » » est **fausse** (`turn/completed` à +36 ms, prouvé) et l'ancien « Stopping… » figé ne se reproduit pas au HEAD.
  - **Reste (Windows) :** uniquement la variante stricte **arrêt pendant un outil du tour parent** — inaccessible ici (muse-spark déporte toutes ses recherches en sous-agents ; outil shell bloqué par le défaut [`m1-06-run-in-muse-sandbox.md`](evidence/2026-09-27-qualif-native/m1-06-run-in-muse-sandbox.md)). **Variante mesurée le 27/09/2026 :** arrêt pendant une **lane sous-agent « Running »** (travail d'outil en vol dans la session enfant) — `cancel_session`+`turnId`, tour résolu, lanes closes. **Phases fermées** ([`m0-04-stop-terminal.md`](evidence/2026-09-27-qualif-native/m0-04-stop-terminal.md)) : **avant le premier token** (arrêt à +1,5 s pré-sortie, `turnId` transmis, résolution 1,0 s, relance immédiate), **réponse tardive** (arrêt à +45 s sur tour vivant, idem), **après la fin** (plus de bouton Stop, UI au repos, tour suivant immédiat). La distinction « demande acceptée / terminal confirmé » est prouvée avec son libellé exact (`Stopping Muse…` capturé en direct, résolution en 1,0 s). **Défaut de libellé restant :** le bouton Stop du tour porte le titre `Stop the running sidecar`.
  - macOS ☐ / Linux ☐ — non commencé.

- ◐ **M0-05 — Répondre aux permissions/questions même après incident**
  - Windows ◐ — `list_pending_requests` relit `approval/listPending` et reconstruit les cartes par session, déduplication par identifiant, refus ne peignant pas un faux état de reprise, bascule stale avec actions. **Reste :** validation native des courses stale. Le sidecar 1.3.0 ne sert pas `approval/listPending`.
  - macOS ☐ / Linux ☐ — non commencé.

- ◐ **M0-06 — Afficher la politique de permissions réellement effective**
  - Windows ◐ — sélecteur global Ask / Approve on my behalf / YOLO, mapping vers l'enum MSP, persistance, `session/setApprovalMode`, distinction posture locale / plafond host. Contrat vérifié sur le binaire 1.3.0 : `promptUnmatched` accepté, `approval_mode_ceiling` pour `onRequest` et `allowAll`.
  - macOS ☐ / Linux ☐ — le binaire de référence testé est Windows/WSL ; la matrice d'anciennes versions et les autres OS restent à qualifier.
  - *Critère de sortie :* changement de posture sans redémarrage, conservation après relance, test natif de la décision refusée/stale.

- ◐ **M0-07 — Protéger les diagnostics et éviter un crash sur Unicode**
  - Windows ◐ / macOS ◐ / Linux ◐ — le code est **commun** (renderer + bridge) : aucun wire log brut par défaut, stderr borné à 20 lignes / 8 000 caractères, secrets masqués, troncature UTF-8 sûre, `collect_diagnostics`, export Settings borné, erreurs terminales MSP structurées.
  - **Reste :** qualification native des erreurs moteur détaillées, pour chaque OS — même si le chemin est partagé, la preuve ne l'est pas.

- ◐ **M0-08 — Détecter une incompatibilité du moteur**
  - Windows ◐ — handshake exigeant `serverInfo`, version, `schema.version=1` et fingerprint `sha256:*` ; registre compile-time des RPC émises ; erreur actionnable au démarrage. Binaire Windows/WSL 1.3.0 validé.
  - macOS ☐ / Linux ☐ — matrice d'anciennes versions et autres OS à qualifier.

- ◐ **M0-09 — Conserver les données sans échec silencieux** *(sans dimension OS)*
  - Façade défensive sur tous les modules de persistance connus, signalement corruption/quota, export/import sélectif avec aperçu, classification durable/UI, checksum FNV-1a vérifié avant restauration, migration des alias `muse.*`, brouillons `sessionStorage` défensifs.
  - **Reste :** qualification des formats externes et reprise après interruption avant tout changement de format de clé.

- ◐ **M0-10 — Réussir le premier lancement**
  - Windows ◐ — guidance contextuelle (sidecar, WSL, Muse CLI, authentification, dossier), sonde `probe_startup` bornée affichée dans la récupération et Settings, états lisibles sans couleur, sorties UTF-16 décodées, `dev:clean:windows` borné au checkout.
  - **Reste (Windows) :** détection sur machine propre, distributions WSL non par défaut, parcours d'authentification réel. **Prérequis découvert le 27/09/2026 :** `muse sandbox windows setup` (élevé) doit être exécuté avant tout shell — sinon `sandbox_users_missing` et tout `userShell` échoue ; à intégrer à la guidance de premier lancement ([`m1-06-run-in-muse-sandbox.md`](evidence/2026-09-27-qualif-native/m1-06-run-in-muse-sandbox.md)).
  - macOS ☐ / Linux ☐ — la sonde et la guidance sont spécifiques à la chaîne sidecar Windows/WSL ; un équivalent natif reste à écrire.

- ◐ **M0-11 — Finir l'anglais et les détails de navigation** *(sans dimension OS, vérifié sur Windows)*
  - Libellés résiduels harmonisés, recherche indépendante de la locale française, infobulles `Ctrl`/`Cmd` via `primaryModifier()`, copie d'erreur centralisée `userFacingError`, chemin natif lisible `displayPath`, infobulle zoom documentée et vérifiée en dogfood le 20/09.
  - **Reste :** checklist native finale des titres et erreurs spécifiques dans la webview empaquetée.

- ◐ **M0-12 — Utiliser l'existant au clavier et au lecteur d'écran**
  - Windows ◐ — parcours Tab validé en dogfood (ordre logique, anneau de focus, activation Enter Summary→Content), frappe livrée, Ctrl+F correctement ignoré dans un input, zoom natif vérifié via `zoomHotkeysEnabled`, contraste forcé `Highlight`/`ButtonText`/`LinkText`.
  - macOS ◐ / Linux ◐ — le code d'accessibilité est partagé, mais `forced-colors` est un mécanisme Windows et **aucune** preuve assistive n'existe hors Windows.
  - **Reste :** lecteur d'écran réel, contraste natif, parcours complet sans souris — sur les trois OS.

- ◐ **M0-13 — Identifier clairement les capacités non connectées** *(sans dimension OS)*
  - Vocabulaire commun `Available` / `Local` / `Manual` / `Not connected` avec raison et prochaine étape, badges sur connecteurs, channels, exports, worktrees, index, import CLI/IDE, Browser et Desktop control.
  - **Reste :** qualification native du consentement et des capacités annoncées par le host.

- ◐ **M0-14 — Disposer de contrôles reproductibles avant fusion**
  - Linux ◐ — c'est la **seule** plateforme où une vérification automatisée tourne : CI `ubuntu-latest` avec `npm ci`, `npm test`, `npm run build`, `cargo test` (dépendances Tauri Linux installées, placeholders de frontend et de sidecar), artefacts d'échec bornés et masqués. Fixtures MCP et Muse MSP livrées, `pump_stdout` validé sur un vrai processus enfant (`powershell.exe` sous Windows, `sh` ailleurs).
  - Windows ◐ — smoke natif opt-in `npm run smoke:native` sur deux sidecars réels, hors CI.
  - macOS ☐ — rien.
  - **Reste :** scénario A/B depuis l'interface Tauri et sa webview empaquetée.

**🚦 Sortie M0 :** scénario natif créer → envoyer → stream → approuver → répondre → interrompre → réessayer, puis redémarrage et deux projets simultanés. Aucun réglage ne prétend modifier une capacité qu'il ne contrôle pas. **Validation Windows d'abord ; support macOS/Linux qualifié séparément.**

---

## M1 — Terminer le workflow quotidien de développement

*La maquette `design/prototype` ne constitue pas une implémentation native. Les contrats d'erreur et les opérations destructives restent à concevoir même lorsqu'un écran existe.*

| ID | Résultat attendu | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M1-01 | Voir les fichiers réellement modifiés | ◐ | ◐ | ◐ | ◐ |
| M1-02 | Commenter une ligne de diff et demander sa correction | ◐ | ◐ | ◐ | ◐ |
| M1-03 | Indexer ou annuler une modification | ◐ | ◐ | ◐ | ◐ |
| M1-04 | Synchroniser, commit, push et création de PR | ◐ | ◐ | ◐ | ◐ |
| M1-05 | Ouvrir et utiliser un terminal du projet | — | ◐ | ◐ | ◐ |
| M1-06 | Faire lire au moteur la sortie du terminal | — | ◐ | ☐ | ☐ |
| M1-07 | Consulter les vrais fichiers du projet | ◐ | ◐ | ◐ | ◐ |
| M1-08 | Ajouter fichiers et images à une demande | ◐ | ◐ | ◐ | ◐ |
| M1-09 | Créer une branche de conversation fidèle | — | ◐ | ☐ | ☐ |
| M1-10 | Réorienter une exécution ou mettre en attente | — | ◐ | ☐ | ☐ |
| M1-11 | Choisir un modèle disponible et suivre le contexte | — | ◐ | ☐ | ☐ |
| M1-12 | Retrouver et organiser les conversations | ◐ | ☑ | ☑ | ☑ |
| M1-13 | Lire une longue conversation confortablement | ◐ | ◐ | ◐ | ◐ |

### Détail

- ◐ **M1-01 → M1-04 — revue Git et livraison** *(code partagé, preuves natives manquantes)*
  - ◐ M1-01 — baseline Git capturé avant chaque tour avec délai borné, comparaison HEAD/fingerprint/chemins sans lire le texte de Muse ; listing paresseux, lecture bornée, watcher natif, handoff texte vers le prompt, tableaux CSV/TSV/JSON. **Reste :** E2E webview/live, gros dépôts, formats bureautiques.
  - ◐ M1-02 — file multi-commentaires persistante bornée (40 entrées, 8 000 caractères), garde de fraîcheur refusant une ancre déplacée, ancres `stale` jamais déplacées silencieusement. **Reste :** qualification native avec moteur live, envoi collaboratif distant.
  - ◐ M1-03 — stage/unstage/discard fichier et hunk, sélection multiple, garde HEAD/statut/patch avant écriture, non-suivis jamais supprimés. **Reste :** qualification native.
  - ◐ M1-04 — commit, push à refspec explicite, PR idempotente via `gh`, **Fetch** et **Pull latest** en `--ff-only`. Rejets locaux prouvés sur dépôts temporaires avec le vrai binaire git. **Reste :** rejet d'authentification/permission distant live, aller-retour PR live, revue native.
  - *Note :* ces quatre tickets sont **Git/OS-agnostiques** dans leur logique, mais aucune preuve native n'existe hors Windows — la colonne macOS/Linux reflète cette absence, pas un défaut de code.

- ◐ **M1-05 — Ouvrir et utiliser un terminal du projet** *(Global : —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — registre PTY Rust persistant via `portable-pty`, shell lié au cwd de la conversation, sortie bornée à 200 000 caractères, resize, fermeture contrôlée, rendu ANSI SGR 16/256/24 bits, raccourcis Ctrl+C/Ctrl+D/Ctrl+L/Tab/Échap. Le PTY survit au changement d'onglet car détenu par le superviseur.
  - **Défaut majeur mesuré le 27/09/2026** ([`m1-05-pty-sortie-vide.md`](evidence/2026-09-27-qualif-native/m1-05-pty-sortie-vide.md)) : **la sortie du PTY ne revient jamais** — `cmd.exe` et `conhost.exe` vivants, écritures acceptées (`write_all+flush`), ~700 `terminal_read` tous à `output: ""`, bannière de démarrage elle-même jamais reçue, resize sans effet. Piste racine : `portable-pty` **0.9.0** verrouillé, version réputée pour gels ConPTY Windows ([turborepo#11816](https://github.com/vercel/turborepo/pull/11816)). Remédiation : rétrograder/patcher la crate, rejouer le scénario.
  - **CORRIGÉ le 27/09/2026** ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)) : cause racine **confirmée** = `portable-pty 0.9.0` ; **downgrade en 0.8.1** (`Cargo.toml` + lock, `cargo build` OK, `npm test` + `tsc` verts) et la boucle complète du PTY revient : **bannière `cmd.exe` rendue, commande saisie en clavier réel, sortie `muse-pty-fix-2026` affichée, prompt de retour** — sans aucun changement dans `terminal.rs`.
  - **Reste :** commande interactive longue (éditeur/REPL), autres raccourcis (Ctrl+D/L/Tab/Échap). **ANSI + Ctrl+C prouvés le 27/09/2026 (run5) :** SGR `31m`/`32m` rendus en couleurs distinctes (`RED`→`rgb(239,68,68)`, `GREEN`→`rgb(34,197,94)`) ; `ping -n 20` interrompu à ~6 réponses avec marque `^C`. **Resize : DÉFAUT CONFIRMÉ le 27/09/2026 (run4)** — le volet suit la fenêtre (506×820 → 332×520 via `set_window_frame`) mais `mode con` reste **28×100** aux trois mesures : la géométrie du PTY ne bouge jamais (`terminal_resize` non appelé ou ignoré) ; localisé côté app, pas `portable-pty` ([`m1-05-fix-portable-pty.md`](evidence/2026-09-27-qualif-native/m1-05-fix-portable-pty.md)). **Aller-retour interactif prouvé le 27/09/2026** (run3) : `set /p ANS=Name?` en attente → saisie `interactive-ok` livrée → `echo %ANS%` → **`interactive-ok`** (capture côté processus). Le défaut historique ci-dessous garde sa trace.

- ◐ **M1-06 — Faire lire au moteur la sortie du terminal**
  - Windows ◐ — **Add output to prompt** (fallback borné à 12 000 caractères), **Run in Muse** négociant `userShell`, repli des `item/completed` sans delta, lecture différée `item/readOutput` par blocs de 64 KiB.
  - **Constat bloquant du 19/09/2026 : RÉFUTÉ le 21/09/2026 — c'était un artefact de mesure.** Le harnais envoyait la capacité **à plat** (`capabilities: {}` **plus** `requestedCapabilities: ["userShell"]`), forme que le host lit comme « aucune capacité demandée ». Il obtenait donc `grantedCapabilities: []`, l'appel répondait `capabilityRequired`, et la sonde concluait « aucun item `userShell` ». Avec la forme que l'application utilise depuis toujours — **imbriquée**, `capabilities.requestedCapabilities` (`src-tauri/src/main.rs`) — la même sonde mesure : `grantedCapabilities: ["userShell"]`, `session/userShell` → **`accepted`** avec `commandId`, puis **`item/started` et `item/completed` de type `userShell`** (à 1 867 et 1 922 ms), et le marqueur de la commande **restitué**. Verdict de la sonde corrigée : « the host DOES publish 2 userShell item(s) — the gap report is wrong here ».
  - **Conséquence :** le blocage n'est **pas** côté host. `SIDECAR-CONTRACT-GAPS.md` ne doit plus être invoqué pour M1-06, et le chemin `Run in Muse` côté client fonctionne : capacité projetée par Rust, fusionnée par le renderer, bouton activé dès qu'une commande est saisie.
  - **Deuxième défaut trouvé, de synchronisation (21/09/2026) :** la carte `grantedCapabilitiesBySession` du renderer n'est peuplée **qu'au montage**, par un `restore_sessions` qui s'exécute avant que les hôtes par workspace soient lancés. Sur un lancement frais elle ne contient donc qu'une partie des sessions, et **rien ne la repeuple** — le bouton annonce « did not grant the userShell capability » alors que le host l'a accordée. Mesuré : pont `["userShell"]` pour les 13 sessions, carte du renderer réduite à `01a0c2d7`. Détail dans [`evidence/2026-09-21-ux/m1-06-capacites-au-montage.md`](evidence/2026-09-21-ux/m1-06-capacites-au-montage.md).
  - **`sessionNotLoaded` n'est plus un échec opaque :** le host rapporte `status: "notLoaded"` pour **toutes** les sessions persistées après une relance — y compris à 27 tours — donc « listée » et « chargée » sont deux états. `SessionMeta` porte désormais `loaded` et le bouton est indisponible avec un motif exact tant que la conversation n'est pas chargée, au lieu d'échouer après le clic.
  - **Reste :** (1) repeupler la carte des capacités après le lancement des hôtes — amorcé : les réponses `start_session`/`resume_session` portent `granted_capabilities` et le renderer les hydrate à la (re)connexion (**mesuré 27/09** : `["userShell"]` propagé) ; (2) **afficher la sortie `userShell` dans la carte Run in Muse** (les items et leur `output` sont bien publiés par le host — `msp-user-shell-items.mjs`) ; (3) qualification native interactive sur les trois OS.
  - **Qualification 27/09/2026** ([`m1-06-run-in-muse-sandbox.md`](evidence/2026-09-27-qualif-native/m1-06-run-in-muse-sandbox.md)) : la chaîne complète est prouvée — clic **Run in Muse** → item `userShell` + sortie **affichés dans le fil en 1 s**. La commande **exécute réellement** en host externe (`markerEchoed: true`, 78 ms) avec le binaire, les flags et le workspace de l'app. **Défaut restant :** un host lancé **par** l'application répond `managed shell sandbox is unavailable` — même après `muse sandbox windows setup` (obligatoire : `sandbox_users_missing` sur machine neuve) et même sur session fraîche. Piste : contexte de spawn depuis le processus Tauri. **Add output to prompt** reste à valider dès qu'une commande aboutit dans l'app.
  - macOS ☐ / Linux ☐ — non commencé ; qualification native sur les trois OS requise par le ticket.

- ◐ **M1-07 → M1-08 — fichiers et pièces jointes** *(code partagé)*
  - ◐ M1-07 — `files_list`/`file_read`/`file_open` sessionnés, gardes de racine/absolu/traversal/symlink, listing 500 entrées, lecture 512 Ko, images et PDF sous 5 MiB en base64 borné, watcher natif signalant l'obsolescence, **Add to prompt** avec provenance. **Reste :** qualification native Windows/macOS/Linux, renommages, racines supprimées, formats bureautiques.
  - ◐ M1-08 — parts MSP `text` et `image` réelles (le schéma n'accepte **pas** de part fichier arbitraire), validation Rust du type/MIME/base64/dimensions/bornes (8 parts, 120 000 caractères, 5 Mo), outbox persistant les parts exactes, brouillon borné avec **Reselect** au-delà. **Reste :** validation live sur les modèles image, qualification native.

- ◐ **M1-09 — Créer une branche de conversation fidèle** *(Global : —)*
  - Windows ◐ — `session/fork` vérifié dans le schéma du binaire Windows, `excludeItems: true`, ancre MSP `lastTurnId` précise via **Fork from here**, notification `session/branchChanged` persistée, récupération explicite sur ancre indisponible.
  - **Limite host observée :** rejet `fork seed materialized 3 run ids for 2 stored turns` sur une session dogfood âgée avec sous-agents ; fork **OK** sur session fraîche à 1 tour le 20/09. Échec circonscrit au host 1.3.0, rien à corriger côté superviseur.
  - macOS ☐ / Linux ☐ — contrat vérifié sur un binaire **Windows** uniquement.

- ◐ **M1-10 — Réorienter une exécution ou mettre en attente** *(Global : —)*
  - Windows ◐ — queue MSP par défaut, dispositions `queued`/`steered` visibles, ordre persisté sous `muse-desktop.queued-turns.v1`, `turn/unqueue`, réconciliation sur `history.snapshot.queuedTurns`. Smoke `--exercise-queue` réussi sur deux sessions : `disposition: queued` puis `turn/unqueue` accepté.
  - **Progrès (27/09/2026) :** course de suppression en webview jouée pour de vrai ([`m1-10-course-de-file.md`](evidence/2026-09-27-qualif-native/m1-10-course-de-file.md)) : suppressions en rafale depuis le contexte de page pendant un premier tour — **aucun tour retiré n'a jamais démarré** (ni accusé ni réponse), file vidée, premier tour mené à son terminal. **Run de clôture de course le 27/09 au soir :** deux tours **correctement et distinctement enfilés** (A et B, sans doublon — la duplication venait du harnais : Enter synthétique double, corrigé), retirés pendant l'exécution, **jamais lancés** (file vide dès le retrait, premier tour toujours seul à +20 s), trace « non envoyé » au journal pour les deux.
  - **Reste :** uniquement l'exécution en webview empaquetée (build dev ici). **Restauration après redémarrage prouvée le 27/09/2026** ([`m1-10-course-de-file.md`](evidence/2026-09-27-qualif-native/m1-10-course-de-file.md)) : deux tours enfilés → `taskkill /F` en plein tour → relance → stockage intact **et la file reprend toute seule, dans l'ordre** (A→ALPHA puis B→BETA), sans doublon ni inversion.
  - macOS ☐ / Linux ☐ — non commencé.

- ◐ **M1-11 — Choisir un modèle disponible et suivre le contexte** *(Global : —)*
  - Windows ◐ — `model/list` comme source de vérité, `session/setModel`, compaction en geste séparé avec cycle `pending → accepted/noop/error`, `session/contextUsage` et `session/tokenUsage` affichés tels que fournis, effort de raisonnement **les huit valeurs du contrat** (`none`→`ultra`, `max` compris) persisté global/projet et appliqué via `session/setReasoningEffort`, dernier modèle conservé dans `StoredSession.model_id`.
  - **Preuves natives :** les **huit** niveaux sont acceptés par un host 1.3.0 vivant et chacun émet `session/reasoningEffortChanged` avec la valeur envoyée (`node scripts/msp-reasoning-tiers.mjs`) — le « sept sur huit » venait de notre liste, pas du moteur. **Mesures du 27/09/2026 :** l'« effectif du modèle » **est** visible côté host — `list_models` rend `is_active: true` sur le modèle courant, `start_session`/`resume_session` rapportent `model_id`, et `session/setModel` se projette sur la session (`msp-projection-check.mjs`) ; le vieux `isActive: false` de `--exercise-model` venait du host `--no-session-log` du harnais ([preuve](evidence/2026-09-27-qualif-native/session-log-expique-tout.md)). **Reste :** suivi du contexte (`contextUsage`) et qualification native.
  - **Qualification 27/09/2026** ([`m1-11-bascule-modele.md`](evidence/2026-09-27-qualif-native/m1-11-bascule-modele.md)) : la bascule est prouvée sur le fil (`set_model` avec `modelId`+`providerId`+`profileId` par `sessionId` ; `list_models`→`is_active` suit) et **l'état du host est bien par session** (deux conversations du même workspace divergent). **Défaut bloquant la clôture : le libellé du sélecteur n'est pas par conversation** — au switch, l'UI annonce le dernier modèle choisi ailleurs (mesuré : A affiche `muse-spark-1.3` alors qu'elle tourne sur `muse-spark-1.2-contributor`) ; le libellé colle par contre exactement au modèle effectif après hydratation `resume_session` (`model_id` ↔ libellé). Secondaire : bascule sur conversation non chargée → rejet net du host (« conversation engine is unavailable — start or restore the conversation first ») sans explication dans le sélecteur.
  - macOS ☐ / Linux ☐ — non commencé.

- ☑ **M1-12 — Retrouver et organiser les conversations** *(sans dimension OS — seul ticket clos)*
  - Recherche sur titre, dossier et texte des journaux locaux avec extrait ; épinglage persisté ; **Move up**/**Move down** attribuant des rangs persistants ; marqueur `new` effacé via `setActive` ; `session/rename` propagé au host quand disponible ; restauration `session/list` paginée (curseur opaque, 200/page, 20 pages max) avec déduplication et échec explicite sur curseur répété ou malformé.
  - **Pourquoi clos :** tous les critères de sortie sont satisfaits et prouvés par les tests Node, sans aucune dépendance native ni OS. La virtualisation complète de la sidebar reste conditionnée à une mesure de performance — c'est un travail d'optimisation distinct, suivi par M1-13, pas un critère de ce ticket.

- ◐ **M1-13 — Lire une longue conversation confortablement** *(sans dimension OS)*
  - Fenêtre DOM bornée au-delà de 600 entrées (160 visibles, 120 anciens chargés), espaces virtuels proportionnels au journal complet, hauteurs mesurées par ResizeObserver, scroll compensé, position et index persistés sous `muse-desktop.stream-position.v1`, finder complet **Ctrl/Cmd+F** avec saut vers un résultat hors fenêtre, métadonnées `aria-posinset`/`aria-setsize`, navigation Home/End/PageUp/PageDown.
  - **Reste :** mesure native à 2 000 entrées dans la webview empaquetée et qualification assistive.

**Dépendances :** M1-01 → M1-02/03/04 ; M0-01 → M1-05/06/09/10 ; capacités moteur à vérifier avant M1-08/09/10.
**🚦 Sortie M1 :** réaliser, inspecter, corriger, tester et livrer une modification de dépôt depuis Muse, avec un chemin de récupération en cas d'erreur.

---

## M2 — Projets et travail parallèle isolé

| ID | Résultat attendu | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M2-01 | Un projet représente des dossiers persistants | — | ◐ | ☐ | ◐ |
| M2-02 | Les paramètres projet s'appliquent réellement | — | ◐ | ☐ | ☐ |
| M2-03 | Créer automatiquement un worktree | — | ◐ | ◐ | ◐ |
| M2-04 | Préparer l'environnement du worktree | — | ◐ | ☐ | ◐ |
| M2-05 | Passer de Local à Worktree et inversement | — | ◐ | ☐ | ☐ |
| M2-06 | Nettoyer les worktrees sans supprimer du travail | — | ◐ | ◐ | ◐ |
| M2-07 | Piloter les sous-agents réels | — | ◐ | ☐ | ☐ |
| M2-08 | Exécuter plusieurs writers sans collision | — | ◐ | ☐ | ◐ |

### Détail

- ◐ **M2-01 — Un projet représente des dossiers persistants** *(Global : —)*
  - Windows ◐ — racines multiples persistantes avec `workspace` conservé comme racine primaire, migration guidée **N projects need a folder**, sonde native `inspect_workspace_root` (`Available`/`Not a folder`/`Missing`), sélecteur d'environnement `projectId:rootIndex` à la création de conversation.
  - Windows ◐ — **règles du dossier** : sonde native `rules_scan` en lecture seule (`AGENTS.md` prioritaire, `CLAUDE.md` seulement en repli, règles personnelles en repli conditionnel), affichées dans le projet avec leur statut. Le champ d'instructions client a été **retiré** — un projet ne possède pas d'instructions, le CLI lit celles du dossier. Détails et limites : [regles-du-dossier](evidence/2026-09-21-ux/regles-du-dossier.md).
  - Windows ◐ — **sélecteur de projet** : « Start in » devient « Project », l'option par défaut « No project », et le dossier n'est affiché que lorsqu'il distingue — un projet né de son propre dossier n'affiche plus « openscreen · openscreen » sous un sélecteur de dossier qui dit déjà « openscreen ». Deux racines qui se liraient encore pareil retombent sur le chemin entier (`projectOptionLabels`).
  - **Reste :** `workspaces[]` n'a aucun équivalent backend (un projet = un dossier côté CLI).
  - Linux ◐ — le chemin pur (modèle, migration, projection) est couvert par les tests Node et la CI tourne sur Linux ; la sonde native n'y est pas exercée.
  - macOS ☐ — non commencé.

- ◐ **M2-02 — Les paramètres projet s'appliquent réellement** *(Global : —)*
  - Windows ◐ — héritage global/projet via `settingsForThread` avec source visible (`g:`), modèle effectif appliqué après `session/start`, `autoCompact` respecté, et surtout **projection sandbox au lancement du host** : `workspace` → `--sandbox-network restricted`, `network` → `--sandbox-network enabled`, `elevated` → `--disable-sandbox --sandbox-network enabled`, projet `read-only` → `--disable-write --disable-shell`. Un host déjà lancé refuse explicitement une posture différente et demande **Restart workspace host**.
  - **Reste :** qualification native de deux projets avec postures différentes et reconnexion durable après redémarrage. Le host ne fournit aucune mutation sandbox par MSP — toute bascule exige un redémarrage de processus.
  - macOS ☐ / Linux ☐ — non commencé.

- ◐ **M2-03 — Créer automatiquement un worktree** *(Global : —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — `git_worktree_create(sessionId, branch, relativePath, baseRef)` confiné à `.muse/worktrees/`, `git worktree add -b` hors thread UI, refus des chemins existants / références de type option / traversées, action atomique **Create & open** avec rollback d'admission. Git est identique sur les trois OS, mais **aucune preuve native** n'existe hors Windows.
  - **Qualification 27/09/2026** ([`m2-worktrees.md`](evidence/2026-09-27-qualif-native/m2-worktrees.md)) : mécanisme **PASS intégral** (`ux-start-worktree.mjs` : création, branche `muse/…`, base `HEAD`, refus « worktree path must be relative and stay inside .muse/worktrees », rollback). **Défaut de raccordement mesuré au fil :** la case « Create a new worktree » crée le worktree (`git_worktree_create_for_workspace` → `…\.muse\worktrees\openscreen-rn3d0`) mais **la conversation démarre dans le dépôt principal** — `start_session` reçoit `workspacePath: G:\repos\openscreen` et `git_status` annonce `branch: "pr620"`, jamais `muse/openscreen-rn3d0`. Le `path` renvoyé n'est pas transmis à `start_session` : « Create & open » n'ouvre pas.
  - **Reste :** qualification native et pannes après admission.

- ◐ **M2-04 — Préparer l'environnement du worktree** *(Global : —)*
  - Windows ◐ / Linux ◐ — profils persistants par workspace, commande utilisateur bornée à 2 000 caractères exécutée uniquement après **Run setup**, états `ready`/`failed`/`timedOut`/`cancelled`, annulation native ciblée, runner refusant les dossiers hors `.muse/worktrees` et tuant au-delà de dix minutes, **Check readiness** détectant `package.json`/`Cargo.toml`/`pyproject.toml`/`go.mod`.
  - Linux ◐ — le runner purge l'environnement hérité et conserve `PATH`, dossiers temporaires, domicile et locale, plus des variables Windows (`PATHEXT`, `ComSpec`) neutralisées ailleurs : le chemin Linux est plausible et testé en Rust, non exercé nativement.
  - macOS ☐ — non commencé.
  - **Reste :** qualification native de la création atomique et du setup sur chaque plateforme.

- ◐ **M2-05 — Passer de Local à Worktree et inversement** *(Global : —)*
  - Windows ◐ — **Prepare handoff** produit un plan local en lecture seule (workspace source, worktree cible, conflits, changements non commités, état cible, disponibilité de branche), checks `pass`/`warn`/`blocked`, invalidation en **refresh required**, **Open with handoff context** plaçant une note éditable bornée dans le composer.
  - **Bloquant :** le transfert effectif (arrêt/reprise atomique du host, déplacement du contexte, rollback) reste **bloqué par l'absence de contrat MSP multi-workspace**. Aucune bascule implicite n'est déclenchée.
  - macOS ☐ / Linux ☐ — non commencé.

- ◐ **M2-06 — Nettoyer les worktrees sans supprimer du travail** *(Global : —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — **Inspect** lisant le statut Git réel, refus de suppression d'un checkout sale ou attaché à des conversations Muse, confinement `.muse/worktrees/`, politique de rétention par dépôt (7/14/30/90 jours ou indéfini) calculée **uniquement après inspection propre**, **Inspect all** en parallèle, intention de nettoyage persistante reprise après interruption. Git garde la décision finale si un checkout est verrouillé.
  - **Reste :** qualification des processus externes — l'inspection ne peut pas connaître tous les processus hors Muse.

- ◐ **M2-07 — Piloter les sous-agents réels** *(Global : —)*
  - **Qualification 27/09/2026 (concurrence) :** deux lanes `subagent-running` **simultanées** observées en direct (`e8af2a61` + `47a01e3d`), mais **reproduction contrôlée hors de portée du modèle** — muse-spark sérialise sa délégation malgré ordre de chevauchement (20 échantillons/30 s : `maxConcurrentRunning=1`) ; reste la reproduction propre multi-fils ([`m2-worktrees.md`](evidence/2026-09-27-qualif-native/m2-worktrees.md)). **→ CONCURRENCE PROUVÉE par la suite (run2) :** 3 lanes `running` simultanées dans un fil + 2 lanes `running` dans un second fil en même temps — l'app rend/suit/encontrôle plusieurs enfants en parallèle, multi-fils et intra-fil.
  - Windows ◐ — états host normalisés et visibles, snapshots `item/updated` remplacés par révision dans la lane sous-agent, contrôles bornés selon le cycle de vie.
  - **Reste :** qualification native sur agents vivants et événements terminaux entrelacés. **Pièces mesurées le 27/09/2026** ([`m2-worktrees.md`](evidence/2026-09-27-qualif-native/m2-worktrees.md)) : le host publie de vrais items **`childSessionId`** (sessions enfants créées par le modèle) et l'UI rend des **voies sous-agents avec boutons stop** (`title="subagent/stop"`, capturés dans les runs `cdp-stop-terminal`) — reste le scénario fan-out complet avec reprise du parent.
  - macOS ☐ / Linux ☐ — non commencé.

- ◐ **M2-08 — Exécuter plusieurs writers sans collision** *(Global : —)*
  - Windows ◐ / Linux ◐ — pré-vol des fichiers cibles persisté par workspace, détection des recouvrements bloquant deux writers sur un fichier ou sous-dossier commun, lanes `cores - 2` bornées à 4–8 et file FIFO, dispatch explicite vers la conversation du worktree via le chemin normal start/send, **lease renderer** borné au workspace + **verrou OS advisory Tauri** par cible libéré par l'OS après crash, accusé de Stop conservant le lease jusqu'au terminal, résumé extractif local.
  - Linux ◐ — le verrou OS advisory est du Rust Tauri et donc portable en principe ; non exercé nativement.
  - macOS ☐ — non commencé.
  - **Reste :** annulation atomique MSP confirmée et collecte de résultat métier complète — le protocole MSP actuel ne fournit ni verrou de fichiers, ni résultat writer structuré, ni annulation atomique confirmée.

**Dépendances :** M0-01/02 et M1-01 avant M2-03 ; M2-03 avant M2-04/05/06/08.
**🚦 Sortie M2 :** deux conversations modifient/testent des espaces indépendants ; redémarrage, transfert et nettoyage préservent les changements.

---

## M3 — Extensions et automatisations opérationnelles

| ID | Résultat attendu | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M3-01 | Connecter un serveur MCP local | ◐ | ◐ | ◐ | ◐ |
| M3-02 | Connecter un serveur MCP distant | ◐ | ◐ | ☐ | ☐ |
| M3-03 | Installer/désactiver une extension utilisable | ◐ | ◐ | ◐ | ◐ |
| M3-04 | Découvrir les skills du disque et du projet | ◐ | ◐ | ◐ | ◐ |
| M3-05 | Invoquer une skill avec son vrai contexte | — | ◐ | ☐ | ☐ |
| M3-06 | Exécuter un travail planifié sans clic préalable | — | ◐ | ◐ | ◐ |
| M3-07 | Gérer sommeil, reprise, doublons et échecs | — | ◐ | ◐ | ◐ |
| M3-08 | Examiner les résultats des runs | ◐ | ◐ | ◐ | ◐ |
| M3-09 | Recevoir une notification utile | — | ◐ | ◐ | ◐ |

### Détail

- ◐ **M3-01 — Connecter un serveur MCP local** *(sans dimension OS dans le transport)*
  - Transport stdio réel avec handshake `initialize` → `notifications/initialized` → `tools/list`/`tools/call`, frames `Content-Length` et JSON par ligne, processus persistant explicite **Start server**/**Stop server**, rafraîchissement manuel **Refresh tools**, hot-reload borné sur `tools/list_changed`, injection opt-in `config.mcpServers` sur start/resume/worktree, autorisation suivant la posture globale, **Reconnect with current connectors**.
  - **Reste :** catalogue d'outils réellement exposé par le host Muse, autorité de permission native, qualification native. Les outils découverts ne sont **pas** copiés dans le catalogue MSP — l'injection laisse au host le soin d'initialiser ses propres capacités.

- ◐ **M3-02 — Connecter un serveur MCP distant**
  - Windows ◐ / macOS ◐ / Linux ◐ *(code)* — transport streamable HTTP/SSE, `Mcp-Session-Id` repris, bearer en mémoire puis dans le **gestionnaire de credentials natif** via la crate `keyring` : Windows Credential Manager, macOS Keychain, Secret Service/keyutils sous Linux. **Forget token** révoque la copie native sans supprimer le connecteur. Endpoint public HTTPS obligatoire, refus des adresses privées, renouvellement automatique borné d'une session expirée (401/403, une seule fois).
  - macOS ☐ / Linux ☐ *(preuve)* — le backend `keyring` est multi-plateforme mais **seul Windows est qualifié** : ni le trousseau macOS ni Secret Service Linux n'ont été exercés. Le réseau distant n'a pas été testé hors Windows.
  - **Reste :** OAuth/refresh fournisseur, catalogue distant côté host, qualification réseau macOS/Linux.

- ◐ **M3-03 — Installer/désactiver une extension réellement utilisable** *(code partagé)*
  - Enregistrement après probe `tools/list` réussi, runtime persistant explicite, hot-list, rollback de catalogue et de révision `.mcpb`/ZIP avec validation de `manifest.json`, semver, runtime et entry point, écriture sous `app_data/mcp-packages/<id>/<version>` par staging + renommage atomique, révisions immuables, le serveur n'est **jamais** exécuté pendant l'installation. Provenance, version et source affichées.
  - **Reste :** catalogue d'outils réellement visible par le host et autorité de permission native ; qualification native d'un serveur packagé.

- ◐ **M3-04 — Découvrir les skills du disque et du projet** *(code partagé)*
  - `skills_scan` borné aux racines `.agents/skills`, `.muse/skills`, `.claude/skills` et `skills`, limité à 100 documents et 20 000 caractères par fichier, liens symboliques sortants ignorés, frontmatter exigeant `name` et `description`, ressources strictement relatives, précédence projet > repo > équipe > builtin, rechargement explicite.
  - **Reste :** le catalogue hôte est chargé séparément via M3-05 pour éviter deux sources de vérité ; qualification du contrat host.

- ◐ **M3-05 — Invoquer une skill avec son vrai contexte** *(Global : —)*
  - Windows ◐ — `skills_read_resources` relit les ressources juste avant envoi avec vérification Rust du chemin et du workspace, contexte balisé `<skill-resource>` avec indication de troncature, erreur de ressource créant une entrée système sans envoi partiel, catalogue `skill/list` hydraté par session et invalidé sur `skill/changed`, commande `/selector arguments` devenue part MSP `{type: "skill"}`, progression `preparing`→`failed`/`unknown` exposée.
  - macOS ☐ / Linux ☐ — qualification du contrat host non commencée.

- ◐ **M3-06 — Exécuter un travail planifié sans clic préalable** *(Global : —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — chaque schedule capture workspace, projet, modèle, politique et fuseau ; `ask` reste en revue, `workspace`/YOLO dispatchent ; journal local borné des runs ; fin de tour structurée marquant `completed`/`failed` ; **prochain déclenchement** calculé depuis le même curseur cron/fuseau que le dispatcher ; **réveil ponctuel multi-plateforme livré** : tâche `Muse-Desktop\AutomationWake` (Windows), job `com.muse.desktop.automation-wake` sous `~/Library/LaunchAgents` (macOS), timer `muse-desktop-automation-wake.timer` (Linux).
  - **Reste :** le réveil relance l'exécutable avec `--automation-wakeup` — c'est un **mécanisme de relance, pas un service de fond**. Il dépend de la session utilisateur et n'est qualifié sur **aucun** OS (poste verrouillé, sommeil, crash du host). Signal métier fourni directement par le host encore ouvert.
  - **État du réveil mesuré le 27/09/2026 :** `schtasks /query /tn "Muse-Desktop\AutomationWake"` → **tâche introuvable** (non enregistrée ici) — le statut de l'app « Native wake-up is unavailable; keep Muse open for automations. » est **exact** ; l'enregistrement de la tâche est le point d'entrée de qualification restant ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)).
  - **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)) : **exécution sans clic prouvée en app ouverte** — automatisation `Once` créée pour 16:34:00, run créé 16:34:11, `completed` en 12 s, **nouvelle conversation** créée (`threadReuse: new` + `sessionId`), réponse `WOKEN` capturée. L'app déclare elle-même l'état du réveil natif : **« Native wake-up is unavailable; keep Muse open for automations. »** — le mécanisme `AutomationWake` reste à qualifier (il ne s'est pas déclaré disponible ici).
  - **Cible sur conversation existante (27/09/2026, suite) :** refus honnête mesuré sur un fil occupé (run `failed`, `sessionId: ""`, erreur explicite, notification `run-failed` persistée — aucun état incohérent) — **mais défaut bloquant** : le dispatch compare `workspace: "G:\repos\openscreen"` (planification) à `workspace: "\\\\?\\G:\repos\\openscreen"` (conversation, forme brute de `start_instance`/`start_session`) → **même répertoire, deux orthographes, échec systématique**. La « réutilisation du même fil » est injouable tant que cette comparaison n'est pas normalisée.
  - *Note :* **seul ticket M3 avec trois implémentations natives distinctes**, donc le seul où la colonne par OS reflète du code différent et non seulement une preuve manquante.

- ◐ **M3-07 — Gérer sommeil, reprise, doublons et échecs de planning** *(Global : —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — politique skip/latest, curseur d'occurrence stable, bail inter-fenêtres, claim anti-doublon, retries bornés (3 tentatives, backoff 15/30/60 s) annulables, réveil immédiat au retour de fenêtre, fuseau IANA capturé en heure murale avec résolution des trous et doublons DST, chaîne `setTimeout` unique, **bail natif exclusif Tauri** récupérable après crash avec fallback local en preview, miroirs natifs atomiques sous `app_data/scheduler/`, runs non terminaux marqués **Review needed** après redémarrage et bloqués jusqu'à réconciliation explicite.
  - **Reste :** qualification native du bail et des déclencheurs **sur chaque OS** (Task Scheduler / `launchd` / `systemd` sont trois implémentations distinctes), preuve d'état du host après crash, poste verrouillé, sommeil/réveil.
  - **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)) : pièces prouvées — **bail natif exclusif actif** (`scheduler_claim` → `{"acquired":true,"native":true}`, TTL 30 s, ownerId affiché dans le panneau), **claim anti-doublon** persisté (`occurrenceKey = scheduleId:occurrenceAt`), politique `missedPolicy` et curseur d'occurrence (`No further runs` après consommation d'un `once`). Reste : crash/relancement (« Review needed »), épuisement de tentatives, sommeil.
  - **DST/fuseau mesurés le 27/09/2026 :** trous et doublons d'heure **résolus déterministiquement** (trou `28/03/2027 02:30` → `03:30` heure d'été ; doublon `31/10/2027 02:30` → **premier passage**), `timeZone` IANA persistée par planification — **mais aucun avertissement n'est affiché** pour ces ajustements : la moitié « affiche les avertissements » de l'acceptation fuseau reste ouverte.
  - **Redémarrage en plein run (27/09/2026) :** run non terminal tué par `taskkill /F` puis app relancée → le run **affiche toujours « Running »** (travail mort) — **le marquage « Review needed » n'a pas lieu** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)) : l'acceptation « bloqué jusqu'à réconciliation explicite » n'est pas remplie, état affiché incohérent.

- ◐ **M3-08 — Examiner les résultats des runs** *(code partagé)*
  - Historique borné, aperçu, statut, non-lu, lien vers la conversation, archivage, filtres, retry manuel, inspecteur de contexte ; résumé extractif local borné (headline, compteurs, jusqu'à 12 fichiers, jusqu'à 12 issues) **sans appel modèle** ; lignes explicites **Issues / Warnings / Blockers / Risks** et **Next steps / Todo / Follow-up / Remaining** extraites séparément et persistées sans inférence ; aperçu structuré `result/output/summary/text` du host traversant le bridge Rust et conservé après bornage.
  - **Reste :** résumé métier sémantique et fin de run native — dépend du host. **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)) : carte de run complète mesurée — `resultPreview: "WOKEN"`, `attempt`, `unread`, filtres `Queued/Running/Completed/Failed/Archived`, actions `Inspect run` / `Open conversation` / `Mark read` / `Archive` et retry manuel présents.

- ◐ **M3-09 — Recevoir une notification utile** *(Global : —)*
  - Windows ◐ / macOS ◐ / Linux ◐ — inbox locale dédupliquée par clé d'idempotence, non-lus, filtres All/Unread, silence persistant, routage vers la conversation ciblée avec clic conservé pendant la réhydratation, ledger natif borné sous app data, acquittement unitaire ou global, issues et prochaines étapes structurées transportées.
  - **Reste (bloquant par OS) :** la **qualification native du prompt de permission** reste à exécuter sur Windows/macOS/Linux, via `tauri-plugin-notification` avec fallback webview. L'application doit rester ouverte pour recevoir les événements du host — **pas de service persistant quand l'app est fermée**.
  - **Qualification 27/09/2026** ([`m3-automations-reveil.md`](evidence/2026-09-27-qualif-native/m3-automations-reveil.md)) : **notification utile prouvée en app** — « Automation completed: Qualif M3 wake — NEW — WOKEN — 16:34:23 » avec **résultat du run**, actions **Open conversation** et **Mark read**, compteur `Unread (1)`, filtres All/Unread. Seul le prompt de permission natif (bannière système) reste.

**Dépendances :** M0-06/08 avant MCP ; M2-01 et M0-02/09 avant M3-06 ; M2-03 si run isolé ; M3-06/07 avant inbox.
**🚦 Sortie M3 :** un run programmé utilise un vrai outil/skill, s'exécute selon la politique et produit un résultat consultable. Pour les runs locaux, app et ordinateur allumés restent une contrainte explicitée.

---

## M4 — Parité étendue

*Ces écarts restent visibles pour une ambition de parité complète. Leur faisabilité doit être vérifiée avec le moteur Muse avant engagement d'implémentation.*

| ID | Résultat attendu | Global | Windows | macOS | Linux |
|---|---|---|---|---|---|
| M4-01 | Naviguer dans un vrai navigateur intégré | — | ◐ | ☐ | ☐ |
| M4-02 | Annoter visuellement une page | — | ◐ | ☐ | ☐ |
| M4-03 | Faire piloter le navigateur par Muse | — | ◐ | ☐ | ☐ |
| M4-04 | Faire piloter une application desktop | — | ◐ | ☐ | ☐ |
| M4-05 | Produire/consulter des images et documents riches | — | ◐ | ◐ | ◐ |
| M4-06 | Partager par URL et révoquer l'accès | ☐ | ☐ | ☐ | ☐ |
| M4-07 | Contrôler une exécution sur un autre host / cloud | ◐ | ◐ | ◐ | ◐ |
| M4-08 | Interagir par la voix | — | ◐ | ◐ | ◐ |
| M4-09 | Installer et mettre à jour sur les plateformes annoncées | — | ◐ | ☐ | ☐ |

### Détail

- ◐ **M4-01 / M4-02 / M4-03 — navigateur intégré, annotations, pilotage** *(Global : —)*
  - Windows ◐ — navigation normalisée, historique et huit onglets isolés par `sessionId` sous `muse-desktop.browser.tabs.v1`, téléchargement explicite same-origin borné à 10 MiB avec `credentials: omit` et refus des redirections, interception des liens `<a download>`, **Open native** ouvrant une webview Tauri dédiée `muse-browser` avec profil privé non persistant, **Close native** idempotent.
  - **Fondamental :** la surface native repose sur **WebView2**, donc Windows. Les tickets parlent explicitement de « qualification WebView2 » — l'équivalent macOS (WKWebView) et Linux (WebKitGTK) n'est **pas commencé**. La sandbox iframe reste le repli du web preview.
  - **Reste :** qualification native, pages cross-origin, réponses de téléchargement initiées par la navigation, capture automatique de la seule iframe, workflow complet.

- ◐ **M4-04 — Faire piloter une application desktop** *(le ticket le plus asymétrique)*
  - Windows ◐ — **computer use repose désormais sur le driver open source CUA** ([trycua/cua](https://github.com/trycua/cua), MIT) : l'application démarre **son propre service** sur un canal nommé privé, en mode `bounded`, avec un **manifeste de capacités qu'elle génère et approuve**, et remet au host Muse l'entrée MCP qui pointe dessus. Un interrupteur, trois niveaux (19 / 38 / 57 outils mesurés sur 0.28.2), aucune liste d'applications. **Vérifié de bout en bout** : `get_screen_size` répond, `click` est refusé par le driver lui-même (`outside the capability manifest`), la révocation arrête le service. Plan et mesures : [2026-09-22-computer-use-cua](plans/2026-09-22-computer-use-cua.md).
  - Windows ◐ — l'ancienne surface native reste : inventaire borné des fenêtres visibles, observation read-only via UI Automation (rôle sémantique, identifiant d'automatisation, géométrie, visibilité, état), valeurs `ValuePattern`/`RangeValuePattern`/`SelectionItemPattern`/`TogglePattern`/`TextPattern` bornées pour les contrôles non sensibles, masquage `value hidden` des contrôles password/credential-like, repli Win32 explicite, focus/texte/touches/clics derrière le consentement **Allow desktop control** (OFF par défaut, réaffirmé dans un verrou natif volatile), capture via sélecteur OS, adaptateur `computer.*` conditionné au catalogue host, **Stop Muse action**.
  - **Dogfood du 20/09 :** panneau atteint via onglets UIA, consentement OFF par défaut observé, badge `Available`, capture non automatique — consentement volontairement **non accordé**, donc les actions ne sont pas prouvées en conditions réelles.
  - macOS ☐ / Linux ☐ — **non commencé, et explicitement hors périmètre du code** : `desktop_control.rs` renvoie `supported: false` avec la raison « Desktop control is not available on this platform yet » au lieu de simuler une disponibilité.
  - **Reste :** un tour réel où le modèle appelle un outil `computer_*` ; appliquer un changement de niveau à une conversation déjà ouverte (la liste MCP est fixée à `session/start`/`session/resume`, donc il faut une reprise) ; installation du driver guidée plutôt qu'automatique ; runtimes macOS/Linux. Cette tranche **ne doit pas** être présentée comme un contrôle autonome du bureau tant que le tour réel n'est pas mesuré.

- ◐ **M4-05 — Produire/consulter des images et documents riches** *(code partagé)*
  - Artefacts Markdown versionnés avec **Preview/Source**, édition locale **Save as new version**, notes avec citation bornée à 240 caractères, export texte UTF-8 borné à 2 MiB par sélecteur natif ; CSV/TSV/JSON en tableau accessible (100 lignes, 20 colonnes, 400 caractères/cellule) ; DOCX/XLSX/PPTX/ODT/ODS/ODP jusqu'à 5 MiB décompressés avec `fflate` en ne retenant que les parties XML utiles (plafonds 4 MiB/entrée, 8 MiB cumulés, 500 entrées) ; **extraction RTF bornée** ; sorties binaires `item/readOutput` par blocs de 64 KiB avec aperçu image/PDF/document, enregistrement natif et **Open in app** ; PDF complets dans le lecteur du WebView.
  - Windows ◐ / macOS ◐ / Linux ◐ — parsing et rendu en JavaScript, donc réellement portables ; **aucune preuve native hors Windows**.
  - **Reste :** génération effective par le moteur, formats hors OOXML/ODF/RTF, qualification native multi-plateforme.

- ☐ **M4-06 — Partager par URL et révoquer l'accès** *(Global : ☐ — reporté)*
  - Windows ☐ / macOS ☐ / Linux ☐ — **décision : reporté en attente de spécification produit.**
  - Ce qui existe : export local Markdown/JSON, bundles bornés (400 entrées, 12 000 caractères/entrée, corps 240 000 caractères), valeurs credential-shaped remplacées, métadonnées `redacted`/`truncated`/`omittedEntries`, sauvegarde native, rétention de 100 bundles, révocation **locale** dans la SSOT du profil.
  - Ce qui manque : hébergement, identité, permissions et révocation réelle entre clients. **Aucun serveur, token, compte ou lien public n'est simulé.** C'est le seul ticket au statut ☐ : il est bloqué par une décision produit, pas par un manque de code.

- ◐ **M4-07 — Contrôler une exécution sur un autre host ou dans le cloud** *(sans dimension OS dans le modèle)*
  - Abstraction `HostConnection` pure sous `muse-desktop.host-connections.v1` : typage strict `local`/`remote-ssh`/`cloud-runner`, machine d'états `disconnected`/`connecting`/`connected`/`reconnecting`/`error`, masquage des secrets, assainissement des endpoints SSH/HTTPS, backoff de reconnexion borné, évaluation de heartbeat, routage isolé de sessions, destruction d'environnement sans orphelins, gestionnaire d'environnements dans Settings.
  - **Reste :** authentification interactive par clé SSH native et runtime de conteneur cloud distant — le transport réel n'existe pas encore, seuls le modèle pur et 11 tests unitaires.

- ◐ **M4-08 — Interagir par la voix** *(sans dimension OS dans le code)*
  - Windows ◐ / macOS ◐ / Linux ◐ — **Voice** dans le composer via `SpeechRecognition`/`webkitSpeechRecognition` après geste utilisateur, résultats intermédiaires et finaux restant dans le brouillon éditable, pré-essai `getUserMedia({audio:true})` avec arrêt immédiat des pistes temporaires, refus éditable comme texte, aucun audio persisté ni envoyé au host, erreurs micro traduites en messages calmes.
  - **Reste :** le runtime dépend du support Speech API du WebView — **WebView2, WKWebView et WebKitGTK ne l'exposent pas de la même façon**. Conversation temps réel, fournisseur distant et qualification du dialogue de permission Tauri par plateforme restent ouverts.

- ◐ **M4-09 — Installer et mettre à jour sur les plateformes annoncées** *(le ticket de distribution)*
  - Windows ◐ — bundles x64 **NSIS et MSI reproductibles** avec sidecar, icônes et manifestes d'intégrité SHA-256 ; manifeste `muse-desktop.release-manifest.v1` sans chemin machine ni horodatage, signable en Ed25519 et revalidé à chaque étape ; plan d'update `muse-desktop.release-update.v1`, staging recopié publié par renommage atomique, bascule `current`/`previous` avec rollback, `release:launch` demandant l'arrêt borné du PID puis relançant l'exécutable sans shell, handoff `release:installer` vers NSIS `.exe` ou `msiexec.exe`, `release:delta` vérifié SHA-256, `release:channel` signé, `release:fetch` refusant les redirections, `release:orchestrate sync` vérifiant puis stagant un candidat.
  - **Reste (Windows) :** hébergement opérationnel, rotation des clés de confiance, publication du sidecar (fourni par l'environnement de build, **non versionné**), installation sur machine propre, branchement du rollback au programme d'installation.
  - macOS ☐ / Linux ☐ — **non commencé**. Aucun bundle `.dmg`/`.app` ni `.deb`/`.rpm`/AppImage. Le sidecar est un `externalBin` à triple suffixe (`muse-x86_64-unknown-linux-gnu` en CI) : chaque OS exige son propre binaire Muse, non disponible dans ce dépôt. La `tauri.conf.json` déclare `minimumSystemVersion: 11.0` pour macOS et `targets: "all"`, mais aucune cible n'a été construite ni qualifiée hors Windows x64.

---

## Périmètres à ne pas confondre avec la parité

- **US-28 coédition temps réel** : stub déconnecté, hors chemin critique. Besoin produit à confirmer ; ne pas le comptabiliser comme acquis ni comme prérequis Codex démontré.
- **US-13 SSE** : choix de transport, pas résultat utilisateur. Aucun chantier de migration tant que le transport actuel répond aux critères.
- **Providers arbitraires, quotas simulés et RAG annoncé** : ambitions de la SPEC initiale, pas capacités attestées de Muse. Ne pas promettre une liste de modèles indépendante du moteur.
- **Mémoire proactive multi-services** : seules mémoire locale et références textuelles existent. Dépend de vrais connecteurs et d'une politique de fraîcheur ; à spécifier après M3, pas « terminée » avec le CRUD local.
- **Import de configuration US-34** : import local existant ; migration fidèle de sessions moteur non prouvée. Étendre M0-02/M0-09 seulement après vérification des formats compatibles.

## Correspondance avec les anciennes stories

| Stories historiques | Nouveau suivi |
|---|---|
| US-1/2/5/10/11/29 | M0-01 à 05, M0-09, M1-09/10/12/13 |
| US-3/30 | M2-01/02 ; partage distant séparé M4-06 |
| US-4/31 | M1-11 ; pas d'assimilation résumé local/fork serveur |
| US-6/7/8 | M2-03 à 08 |
| US-9 | M3-06 à 09 |
| US-12/21 | M1-01/02/07, M4-05 ; snippets et vrais fichiers séparés |
| US-14/15/16/17/22 | M0-05/06 |
| US-18/23 | M1-07/08 |
| US-19 | M4-01 à 05 |
| US-20 | M1-08 et mémoire proactive à spécifier après M3 |
| US-24/25/26 | M3-01 à 05 |
| US-27/28 | M4-06 ; coédition hors chemin critique |
| US-32/33/34 | M0-10/11/12, M0-02/09 ; M4-09 |
| US-13 | Pas de chantier dédié |

## Règles de mise à jour

1. Chaque PR cite les IDs concernés et met à jour **uniquement les plateformes réellement touchées**. Une correction de contrat partagé ne fait pas passer macOS ou Linux de ☐ à ◐ sans preuve native.
2. La preuve doit préciser **commit, commande ou scénario, plateforme et résultat**. Ne pas appliquer une preuve UI synthétique au moteur natif, ni une CI Linux à une exécution Linux.
3. Un ticket ne passe à **Terminé** que lorsque tous ses critères de sortie sont prouvés **sur la plateforme concernée**. Une livraison partielle crée des sous-tickets (`M0-01a`, `M0-01b`) avec critères séparés ; elle ne clôt pas le parent.
4. Pour déclarer un ticket terminé : effet réel, erreurs et reprise traitées, permissions effectives, validation native du scénario et documentation des limites.
5. Les décisions de faisabilité et de produit sont consignées **avant** de transformer une hypothèse en engagement. Aucun pourcentage global tant que le périmètre et sa pondération ne sont pas fixés.
6. Quand un ticket dépend d'un comportement du host Muse, la limite est écrite dans le ticket et **le statut n'est pas relevé** en attendant un host qui expose le contrat ou un adaptateur vérifié.
