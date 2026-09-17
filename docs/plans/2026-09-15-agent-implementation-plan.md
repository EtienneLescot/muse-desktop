# Plan d'implémentation pour les agents de codage

Référence : [roadmap opérationnelle](../ROADMAP.md). Ce plan précise **comment réaliser le reste**, sans modifier les statuts de livraison. Base observée : `main` après PR #13 ; reprise explicite portée par PR #14 (`69e06a9`). Avant toute intervention, vérifier quelles PR sont fusionnées et lire leur code actuel. Ne pas réimplémenter `hosts.rs`, `resume.rs` ou Reconnect si déjà présents.

Les noms de commandes, modules et structures proposés ci-dessous sont des **contrats à implémenter**, pas des capacités déjà disponibles. Les méthodes MSP doivent être confirmées dans le schéma installé et sur le binaire servi ; ne jamais inventer une RPC pour satisfaire une maquette. Les fonctionnalités dépendantes d'un service distant commencent par une décision d'architecture et une preuve de faisabilité.

## Mode d'emploi et découpage des livraisons

1. Choisir un ID de roadmap, lire sa fiche ci-dessous, ses dépendances et les preuves de l'audit. Vérifier l'arbre Git et les instructions locales avant modification.
2. Décrire dans la PR le scénario avant/après, le périmètre exact et les critères restant hors lot. Garder un seul résultat observable par PR lorsque possible.
3. Relire le code source concerné : les numéros de lignes des audits historiques peuvent avoir changé. Les chemins des fiches sont des points d'entrée, pas une liste exhaustive.
4. Définir les états UX succès/chargement/vide/erreur/reprise avant de brancher l'action. Réutiliser les tokens de `design/system/tokens.css` et les conventions de `src/Desktop.css` ; conserver l'anglais dans le produit.
5. Faire passer les contrôles adaptés, joindre une preuve reproductible et actualiser les quatre axes de la roadmap. Une interface seule ne fait pas passer « Fonction » à « Câblée ».

Pas de lancement implicite de plusieurs agents : ce document prépare des tâches transmissibles, il n'autorise pas à lui seul une délégation. Les fichiers centraux `App.tsx`, `useMuseSessions.ts`, `main.rs` et les migrations doivent avoir un propriétaire de modification à la fois.

### Carte du code

| Responsabilité | Existant à lire | Direction proposée |
|---|---|---|
| Shell/navigation | `src/App.tsx`, `src/Desktop.css`, `SessionSidebar.tsx`, `WindowControls.tsx` | Extraire par fonctionnalité quand le lot l'exige ; éviter une réécriture globale |
| Conversations | `src/hooks/useMuseSessions.ts`, `src/lib/persist.ts`, `poll.ts`, `messageBlocks.ts` | Séparer état de connexion, historique et actions ; garder l'identité serveur |
| Transport/supervision | `src-tauri/src/main.rs`, `msp.rs`, `hosts.rs`, `resume.rs` | Modules de service testables ; commandes Tauri minces |
| Contexte et rendu | `Composer.tsx`, `StreamView.tsx`, `MessageContent.tsx`, `ArtifactsPane.tsx` | Distinguer texte, fichiers, outils, événements et artefacts réels |
| Projets/extensions | `src/lib/projects.ts`, `skills.ts`, `connectors.ts`, `schedules.ts` | Adapter progressivement les registres locaux vers les services réels |
| Vérification | `test/*.test.ts`, tests Rust intégrés | Ajouter fixtures MSP, UI et smoke natif séparés des tests qui utilisent le moteur réel |

### Contrats transversaux à respecter

- Identités distinctes : `projectId`, `workspaceId`, `sessionId` serveur, `hostGeneration`, `requestId`, `runId`. Ne jamais router une action de session par le dossier sélectionné globalement.
- Une opération asynchrone porte sa cible et son état ; un changement de vue ne change pas sa destination. Refuser un résultat périmé après suppression, remplacement de moteur ou changement de génération.
- Séparer admission d'une commande, exécution et terminaison. Un acquittement MSP ne signifie pas que le tour ou l'outil a fini.
- Les verrous mémoire ne traversent pas un `await` sauf mutex asynchrone expressément destiné à sérialiser le cycle concerné. Documenter l'ordre des verrous ; tester les opérations concurrentes.
- Exécuter Git/shell par arguments structurés, pas par concaténation de commandes. Les chemins sont validés/canonicalisés côté Rust. Les secrets ne vont ni dans localStorage, ni dans les logs, ni dans les fixtures.
- Préserver le travail non commité et les données locales. Les migrations sont versionnées, testables et récupérables ; les échecs de stockage doivent être visibles.

### Validation commune

Commandes actuelles : `npm run build`, `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml --bin muse-desktop --quiet`. Build natif Windows si le runtime/packaging change : `npm run tauri -- build --bundles nsis` avec sidecar configuré.

Créer des fixtures minimales pour succès, refus, timeout, événements entrelacés et arrêt du host. Un test navigateur avec IPC simulé vérifie l'UI ; un test moteur direct vérifie le protocole ; **aucun des deux seul ne vaut E2E Tauri**. Pour chaque scénario natif, consigner OS, versions app/bridge/moteur, étapes, résultat, et usage éventuel d'un tour modèle. Ne pas inventer des preuves pour les autres OS.

## Séquence recommandée

1. Terminer les preuves et les chemins de panne de M0-01/02 ; livrer M0-03/04/05 avec la fondation de test M0-14.
2. M0-06/07/08/09/10 ; puis fermeture de M0 avec M0-11/12/13. Les corrections de confidentialité M0-07 peuvent être livrées immédiatement.
3. M1-01 → 02/03/04 ; M1-05 → 06 ; M1-07 → 08 ; puis 09/10/11/12/13.
4. M2-01/02 → 03/04 → 05/06 ; 07 → 08 après isolation réelle.
5. M3-01/02 → 03 ; 04 → 05 ; M3-06/07 → 08/09 sur les environnements M2.
6. M4 par preuves de faisabilité, sans les présenter comme déjà acquises.

## M0 — Reprise et fiabilité

### M0-01 — Isolation : terminer la validation

**Code :** `hosts.rs`, `msp.rs`, `main.rs`, hook de sessions. Réutiliser le registre ajouté en PR #13.

**Travail :** ajouter un scénario Tauri avec deux dossiers temporaires, deux sessions et flux entrelacés. Interrompre/faire mourir B pendant que A travaille ; vérifier routes send/model/approval/input/subagent, sessions supprimées et événements tardifs d'une ancienne génération. Traiter aussi fermeture du canal stdout sans événement Terminated et échec pendant initialize.

**Acceptation :** A conserve son identité, ses requêtes et son flux ; B seul devient déconnecté ; aucun processus/consommateur ne reste après fermeture. Dépendance : harnais M0-14. Ne pas clore avec le seul smoke « deux model/list ».

### M0-02 — Reprise complète et réconciliation

**Code :** `resume.rs`, `resume_session`, `reconnectSession`, `persist.ts`, `poll.ts`. Conserver la validation identité/dossier/durabilité de PR #14.

**Travail :** définir `ConnectionState = disconnected | connecting | connected | error` par session et génération. Persister le dernier curseur serveur observé quand le protocole le garantit ; utiliser resume/history/view-page pour récupérer le suffixe manquant. Dédupliquer par identité serveur des items, pas par leur texte. Réconcilier demandes d'approbation et questions réémises ; conserver les brouillons. Ne pas réattacher un profil éphémère non récupérable. Adapter explicitement les chemins Windows/WSL sans supposer tous les montages identiques.

**Acceptation :** fermer après un message, rouvrir et envoyer dans la même session ; reprise après panne avec suffixe sans doublon ; demande en attente visible une fois ; refus de lease/dossier incorrect préserve les messages. Dépend de M0-01/08/09. La reconnexion de métadonnées seule reste partielle.

### M0-03 — Envoi sans perte et retry

**Code :** `Composer.tsx`, hook `sendInput`, `persist.ts`, `EmptySessionScreen.tsx`.

**Travail :** faire retourner un résultat explicite à l'action d'envoi. Ajouter un message sortant avec `clientMessageId`, texte original, cible, état `sending/accepted/failed`, erreur et clé d'idempotence. Ne vider le brouillon qu'à acquittement, ou conserver un message réessayable durable. Après timeout ambigu, vérifier l'état serveur avant retransmission ; réutiliser la même clé pour le même envoi logique. Les expansions skill/projet doivent rester reproductibles sans doubler le texte.

**Acceptation :** réseau/host coupé, refus serveur, double-clic, fermeture/rechargement, changement de conversation et échec du premier prompt : texte récupérable et un seul tour accepté. Dépend de M0-02/09 ; tester aussi IME et saisie pendant l'attente.

### M0-04 — Arrêt fiable

**Code :** `cancel_session`, `interrupt_session`, `phase.ts`, `StreamView.tsx`.

**Travail :** séparer `interruptRequested` de l'état terminal confirmé. Ne pas annoncer arrêté parce qu'un appel a été tenté. Mapper erreur « déjà terminé » sans fausse panne ; conserver le flux jusqu'au terminal ou à la déconnexion identifiée.

**Acceptation :** arrêt avant premier token, pendant outil, après fin, réponse tardive et double-clic. L'arrêt de A n'affecte pas B ; l'état final correspond au moteur. Dépend M0-01/03.

### M0-05 — Demandes en attente

**Code :** `ApprovalPanel.tsx`, `InputPanel.tsx`, routage MSP, tables d'approbations.

**Travail :** indexer par session + identifiant + génération, conserver le token opaque du serveur, retirer seulement sur règlement confirmé. Réconcilier snapshot et notifications de reprise ; les anciennes décisions ne doivent pas agir sur une nouvelle demande. Garder la réponse éditée si refus de validation.

**Acceptation :** même ID dans deux sessions, demande réémise, token périmé, erreur après clic, redémarrage et double réponse. Un choix n'est envoyé qu'à sa cible. Dépend M0-02/04/08.

### M0-06 — Permissions effectives

**Code :** `SettingsPanel.tsx`, `settings.ts`, `allowlist.ts`, `scope.ts`, spawn du host.

**Travail :** établir une matrice capacités/préférences/posture appliquée depuis le vrai moteur. Définir comment un changement affecte les hosts existants : appliqué, prochain démarrage ou non supporté. Ne pas convertir une préférence locale en autorisation moteur implicite. Afficher origine et portée ; désactiver les options sans contrat vérifié.

**Acceptation :** lecture/écriture hors racine, symlink, réseau et commande refusée ; verdict moteur conforme au texte UI. Dépend M0-01/08 ; profils testés sans élargir les permissions réelles de l'utilisateur.

### M0-07 — Diagnostics

**Code :** `wire_log`, `push_stderr`, `msp.rs`, erreurs affichées.

**Travail :** supprimer la capture brute en usage normal. Si diagnostic activé : événements structurés, métadonnées minimales, masquage, rotation et rétention bornées ; export explicite avec aperçu. Utiliser une troncature respectant les frontières UTF-8.

**Acceptation :** Unicode multioctet à la limite, erreur longue, secret synthétique, volume élevé. Aucun prompt ou secret brut écrit par défaut ; pas de panic. Livrable autonome, sans attendre les autres lots.

### M0-08 — Contrat du moteur

**Code :** `lib/msp.ts`, `msp-conformance.test.ts`, `main.rs`, SDK épinglé.

**Travail :** recenser les RPC réellement envoyées, y compris modèles/compaction/subagents/reprise. Contrôler le registre contre l'implémentation plutôt qu'un nombre constant. Stocker les capacités et version de handshake ; définir incompatible vs ajout compatible. Centraliser les codes d'erreur utiles et masquer les actions non supportées.

**Acceptation :** RPC manquante du registre fait échouer le contrôle ; schéma incompatible produit une erreur exploitable ; notification additive inconnue n'arrête pas le flux. Livrer fixtures anonymisées de versions connues.

### M0-09 — Persistance

**Code :** `persist.ts` et tous les modules utilisant localStorage/sessionStorage.

**Travail :** inventaire des clés et politiques de conservation. La façade versionnée `lib/storage.ts` est maintenant le point d'entrée de tous les lecteurs/écrivains `localStorage` connus, y compris les valeurs scalaires. Elle valide les lectures JSON, conserve les anciennes valeurs en cas d'échec d'écriture, borne les diagnostics et exporte un snapshot de récupération. Les formats `v1` restent inchangés ; la prochaine passe doit ajouter une migration explicite avec copie de secours, validation et reprise après interruption, distinguer données durables et état UI, et traiter suppression/tombstones et quotas sans résurrection.

**Acceptation :** schéma ancien, JSON corrompu, stockage indisponible/saturé, migration interrompue et réouverture. Aucun effacement silencieux ; export de secours accessible. Les migrations précèdent la modification de format M0-02/03 et M2.

### M0-10 — Premier lancement Windows

**Code :** bridge WSL, `SidecarErrorPanel.tsx`, résolution du sidecar, README.

**Travail :** diagnostic sans secrets de WSL/distribution, binaire, version, dossier accessible et authentification. Afficher étapes de correction et bouton Réessayer. Distinguer UI Windows native et moteur WSL ; pas d'installation implicite non maîtrisée.

**Acceptation :** machine propre, Muse absent, auth absente, chemin avec espaces/Unicode, bridge incompatible. Le premier tour est atteignable avec instructions exactes. Dépend M0-08.

### M0-11 — Finition anglais/navigation

**Code :** composants, `App.tsx`, messages produits par le hook, `WindowControls`.

**Travail :** inventaire des libellés et erreurs générées par l'app, cohérence conversation/projet/run, raccourcis Ctrl/Cmd et états focus. `primaryModifier()` fournit maintenant le libellé OS des infobulles globales, sidebar et input. Centraliser les textes réutilisés si utile ; ne pas traduire les contenus utilisateur ou moteur.

**Acceptation :** checklist accueil/conversation/archives/paramètres/extensions et erreurs ; aucune régression du profil fixe, des thèmes ou de la zone de drag. Captures light/dark et tailles desktop cibles.

### M0-12 — Accessibilité

**Code :** `a11y.ts`, dialogues, panneaux de questions, sidebar, composer et stream.

**Travail :** focus initial/retour, navigation des groupes, fermeture Échap, intitulés et annonces live non répétitives. Vérifier contraste et zoom ; annoncer fin/besoin d'action plutôt que chaque token.

**Acceptation :** parcours complet sans souris, lecteur d'écran réel, zoom 200 %, réduction des mouvements. Les tests automatisés complètent mais ne remplacent pas cette vérification.

### M0-13 — États de capacité honnêtes

**Code :** panneaux Settings/Connector/Browser/Share/Orchestration, composants communs.

**Travail :** définir présentation commune `available/local/manual/unavailable` avec raison et action suivante. Le composant partagé est maintenant appliqué aux connecteurs, channels, exports, worktrees, index local et import CLI/IDE ; les badges restent limités aux surfaces dont la capacité peut être confondue avec une connexion réelle. Remplacer promesses « installé/connecté/restauré » lorsque seul un registre ou un préremplissage change. Ne pas ajouter un badge permanent à chaque élément fonctionnel.

**Acceptation :** audit clic → effet réel sur chaque action ; aucune confirmation fictive. Tester backend absent et capacités refusées. Dépend de l'inventaire M0-08.

### M0-14 — Harnais et CI

**Code :** nouveaux tests d'intégration, scripts et `.github/workflows/`.

**Travail :** serveur MSP fixture à scénarios contrôlés et transport injectable ; démarrer l'app isolée avec stockage/dossiers temporaires. Séparer unitaires, UI simulée, intégration superviseur et live optionnel. CI sans credentials : build, Node, Rust, scénarios fixtures. Publier rapports/captures en cas d'échec, sans données utilisateur.

**Acceptation :** depuis un clone propre, commandes documentées reproductibles ; détecter volontairement une mauvaise route A/B et un envoi perdu. Choisir le pilote Tauri selon support réel des plateformes, consigner toute limite dans l'ADR.

## M1 — Développement quotidien

### M1-01 — Statut et diff Git

**Code :** nouveau service Rust Git, nouveau panneau Review ; réutiliser seulement le style de la maquette, pas ses données. Dépend M0-01/14.

**Travail :** commande proposée `git_status(sessionId)` et `git_diff(sessionId, scope, baseRef?)`. Résoudre dépôt via workspace propriétaire, parser sorties sûres avec séparateurs NUL, restituer fichiers/hunks et révision observée. Scopes staged/unstaged/branch ; « dernier tour » exige un snapshot explicite, pas une supposition.

**Acceptation :** repo propre/sale, rename/delete/untracked/binaire/Unicode, hors Git, branche absente et modifications externes ; résultats comparés à Git réel.

### M1-02 — Commentaires de revue

**Code :** panneau Review, composer, nouveau modèle `ReviewAnchor`. Dépend M1-01.

**Travail :** ancre contenant repo, révision/base, chemin, côté et ligne/hunk. Transformer le commentaire en contexte explicite pour la conversation ; signaler une ancre devenue obsolète plutôt que la déplacer silencieusement.

**Acceptation :** commentaire transmis sur bonne ligne/côté ; fichier renommé ou diff modifié entre sélection et envoi ; aucune confusion entre deux dépôts.

**État au 16/09/2026 :** socle livré dans la PR M1. Le panneau Review rend les lignes old/new sélectionnables, vérifie à nouveau le statut et le diff avant envoi, puis transmet un contexte structuré à la conversation. La persistance d’une file de commentaires et le triage multi-commentaires restent à décider avant M1-04.

### M1-03 — Stage et revert

**Code :** service Git et Review. Dépend M1-01.

**Travail :** actions fichier puis hunk, avec version attendue du diff. Refuser si état disque/index a changé ; confirmation proportionnée pour discard. Ne pas utiliser reset --hard comme raccourci.

**État au 16/09/2026 :** stage, unstage et discard fichier sont livrés dans le service Git sessionné. Les commandes exigent l’observation HEAD/statut/patch du panneau et renvoient l’état actualisé ; les fichiers non suivis ne sont pas supprimés. Les actions hunk et multi-sélection restent à compléter.

**Acceptation :** staging partiel, hunk périmé, fichier utilisateur modifié entre deux clics, binaire et échec Git. Les modifications non ciblées restent intactes.

### M1-04 — Commit, push, PR

**Code :** service Git + adaptateur forge à créer, dialogues UI. Dépend M1-03/06 et environnement authentifié.

**Travail :** commit sur index réel, résultat/hash ; push sur remote/branche explicites ; détecter auth/rejet/hooks. Choisir intégration GitHub CLI ou API via ADR, credentials hors stockage web. Création PR retourne URL vérifiée ; pas de merge automatique.

**Acceptation :** dépôt test, hook échoué, rien à commiter, branche sans upstream, push rejeté et PR existante. Aucun push vers une autre branche par défaut implicite.

**État au 16/09/2026 :** commit, push et création de PR GitHub sont câblés dans le service Git sessionné. Le commit est protégé par l’observation de l’index ; le push utilise un refspec explicite et `gh pr create` réutilise l’authentification locale sans credential web. Les hooks/auth live, rejets distants, PR existantes et qualification native restent à couvrir avec un dépôt de test contrôlé.

### M1-05 — Terminal PTY

**Code :** nouveau service PTY Rust et panneau Terminal. Dépend M0-01/14.

**Travail :** contrats create/write/resize/close avec `terminalId`, session, cwd, shell et génération. Sortie bornée, fermeture contrôlée, processus indépendants de l'onglet. Choisir bibliothèque PTY compatible avec les OS annoncés ; ne pas confondre command runner et terminal interactif.

**Acceptation :** saisie interactive, ANSI, resize, serveur long, changement de vue, fermeture/restart et Unicode ; pas de processus orphelin.

**État au 16/09/2026 :** socle livré dans la PR M1-05. `portable-pty` fournit un shell natif Windows/Unix dans un registre Rust persistant ; le panneau Terminal ouvre/réutilise le terminal de la conversation, draine une sortie bornée, écrit l’entrée, redimensionne et ferme explicitement le processus. La validation native interactive, le rendu ANSI riche et les contrôles clavier restent à exécuter séparément.

### M1-06 — Terminal comme contexte

**Code :** PTY, adaptateur outils/contexte. Dépend M1-05 et capacité moteur vérifiée.

**Travail :** lecture d'un snapshot borné avec identifiant, cwd et offset ; exposer au moteur via outil réel ou insertion explicitement étiquetée. Ne pas envoyer l'historique entier à chaque tour.

**Acceptation :** commande de build en échec, sortie disponible au bon agent ; terminal B inaccessible par confusion de cible ; capture non bloquante.

**État au 16/09/2026 :** première tranche locale livrée dans la PR M1-06 : **Add output to prompt** ajoute un snapshot borné et attribué au terminal actif dans le brouillon. L’adaptateur vers un outil ou un contexte MSP automatique reste explicitement en attente de vérification de capability moteur.

### M1-07 — Fichiers réels

**Code :** nouveau service fichiers, panneau Files, `ArtifactsPane`, scope. Dépend M0-06.

**Travail :** listing paresseux, read borné, détection binaire, ouverture externe/preview ; symlinks et racines autorisées. Distinguer fichier du disque et extrait de réponse. Watcher ou rafraîchissement explicite avec état obsolète.

**Acceptation :** gros dépôt, fichier disparu/renommé, hors scope et fichier volumineux ; afficher le contenu réellement sur disque sans bloquer l'UI.

**État au 16/09/2026 :** tranche locale livrée sur `feat/m1-real-files` : commandes sessionnées `files_list`/`file_read`, garde de racine et de symlink, bornage listing/lecture, détection binaire et aperçu réel dans l’onglet **Files**. Le watcher, l’ouverture native externe et la qualification E2E multi-plateforme restent ouverts.

### M1-08 — Pièces jointes

**Code :** Composer, `mentions.ts`, service fichiers, adaptation TurnInputPart. Dépend M1-07 et de la vérification des capacités moteur M0-08.

**Travail :** définir référence structurée type/MIME/taille/nom/source, drag/drop/coller image, suppression avant envoi, limites et erreurs. Employer le format accepté par Muse ; si non supporté, afficher l'indisponibilité, pas un faux nom de fichier dans le prompt.

**Acceptation :** image réellement reçue, fichier texte, limite dépassée, fichier supprimé, annulation et retry sans pièce jointe orpheline.

**État au 16/09/2026 :** contrat stable vérifié depuis le binaire embarqué (`TurnInputPart` = `text|image|skill`). Le composeur envoie les fichiers texte et images via des parts structurées, avec ingestion sélecteur/glisser-déposer/coller, bornes et suppression avant envoi ; l’outbox conserve le payload exact pour les retries. Les essais live par modèle image, la persistance du brouillon avant envoi et la qualification native restent ouverts.

### M1-09 — Fork serveur

**Code :** sessions, actions conversation, MSP session/fork. Dépend M0-02/08.

**Travail :** choix du point de départ parmi les ancres supportées ; retourner le nouvel ID serveur, conserver provenance et workspace ; importer son historique sans partager les brouillons.

**Acceptation :** branche indépendante, source inchangée, point invalide, source active et échec ; ne jamais substituer un résumé au fork demandé.

**État au 16/09/2026 :** `session/fork` est câblé dans le superviseur et l’action d’en-tête crée une nouvelle conversation serveur dans le même workspace, avec continuité locale des entrées terminées. La sélection d’un `lastTurnId` MSP précis, les erreurs de frontière et la qualification live restent ouvertes.

### M1-12 — Recherche et organisation

**État au 16/09/2026 :** la recherche parcourt les métadonnées et les journaux locaux avec extrait contextualisé ; les conversations peuvent être épinglées, réordonnées dans leur niveau et marquées non lues, avec conservation au redémarrage. La virtualisation des très longues listes reste ouverte après mesure.

### M1-10 — Steering et file de messages

**Code :** Composer, `phase.ts`, sessions/MSP. Dépend M0-03/04/08.

**Travail :** mapper les possibilités réelles turn/steer, cancel et unqueue ; modèle de message en attente avec état/order/cible. Distinguer envoyer après le tour et guider le tour courant ; actions d'annulation stables.

**Acceptation :** deux messages en attente, suppression du second, fin simultanée du tour, refus serveur et reboot ; ordre vérifié dans le moteur.

### M1-11 — Modèles et compaction

**Code :** SettingsPanel, CompactBar, RPC existantes. Dépend M0-08.

**Travail :** conserver catalogue live et fallback séparés ; confirmer le modèle effectif après changement ; persister le choix à la bonne portée. Compaction : afficher admission/progression/résultat et distinguer résumé local/contexte serveur.

**Acceptation :** modèle indisponible, changement entre sessions, compaction no-op/run-active/échec ; contexte et choix reflètent le serveur.

### M1-12 — Recherche et organisation

**Code :** sidebar, recherche App, `threads.ts`, stockage. Dépend M0-09/12.

**Travail :** index de recherche locale sur historique, pagination et extraits ; épinglage et ordre explicites ; non-lus distincts de running. Migration du tri existant sans perdre dates/titres. La première tranche fournit recherche, épinglage, ordre et non-lus ; il reste la mesure avant virtualisation.

**Acceptation :** recherche accentuée/multilingue, archive, suppression, gros historique, clavier et restart ; aucune session supprimée réindexée.

### M1-13 — Lecture longue

**Code :** StreamView/MessageContent, blocs et CSS. Dépend M0-14.

**Travail :** mesurer temps de rendu/mémoire/scroll sur fixture longue. La première optimisation applique `content-visibility: auto`, une taille intrinsèque de secours et un scroll instantané pendant le streaming ; le DOM reste complet pour préserver recherche, sélection/copie et les blocs accessibles. Exposer un compteur d’entrées stable pour les mesures UI natives, puis virtualiser seulement si les budgets mesurés l’exigent. Liens/code/outils accessibles, état « nouveaux messages » sans saut si l'utilisateur lit plus haut.

**Acceptation :** streaming entrelacé, sélection/copie, blocs volumineux, retour bas de page et thème ; fixer les budgets mesurés dans la PR.

## M2 — Environnements isolés

### M2-01 — Racines de projet

**Code :** `projects.ts`, ProjectsPanel, persistance et backend workspace. Dépend M0-09.

**État :** Câblé côté modèle et UI locale. `Project.workspace` est optionnel et persiste sous le schéma existant ; le panneau Projects fournit le sélecteur natif, l’édition et la remise à zéro du dossier. `New conversation here` réutilise le chemin `start_session` du hook, crée la session dans la racine choisie puis rattache la conversation au projet.

**Reste :** migration guidée des anciens groupes sans racine, validation native d’un dossier déplacé ou supprimé, et choix explicite d’un environnement/worktree. Ne jamais déduire un dossier depuis le nom du projet.

**Acceptation :** projet multi-dossiers, dossier déplacé, ancien groupe sans racine et nouvelle conversation dans le bon workspace.

### M2-02 — Configuration héritée

**Code :** projets/settings/skills/connectors, configuration host. Dépend M2-01/M0-06.

**État :** héritage global → projet visible via `settingsFor`, avec diff d’override et contexte de la conversation. Le modèle effectif est appliqué au nouveau session après `session/start` via `session/setModel`; la valeur `default` conserve le choix du moteur.

**Reste :** le schéma MSP vérifié n’expose pas de mutation sessionnelle pour sandbox, réseau ou auto-compact. Conserver ces préférences locales et afficher leur origine sans les annoncer comme appliquées au moteur jusqu’à preuve du contrat ; ajouter ensuite une application sessionnelle et des tests d’isolement pour deux projets.

**Acceptation :** deux projets aux réglages différents, suppression override, redémarrage et host déjà actif ; afficher ce qui est effectivement appliqué.

### M2-03 — Worktree géré

**Code :** remplacer helper `worktrees.ts` par service Rust Git ; nouvelles actions de création. Dépend M2-01/M1-01/M0-01.

**État :** le service Rust `git_worktree_create` crée un checkout réel sous `.muse/worktrees/` depuis une base et une branche explicites. Le panneau d’orchestration garde le plan manuel, ajoute une action par agent et reçoit le chemin canonique retourné ; les segments issus des identités sont nettoyés et dédoublonnés. Les records sont persistés sous `muse-desktop.worktrees.v1` et peuvent être supprimés après confirmation via `git_worktree_remove` avec garde de confinement.

**Reste :** ajouter retention/état Git détaillés et une transaction création-worktree → session. Le host MSP actuel étant lié à un workspace à la fois, ne pas basculer automatiquement une conversation tant que ce cycle n’est pas conçu.

**Acceptation :** deux créations simultanées, branche absente, espace disque, échec partiel ; checkout de départ inchangé.

### M2-04 — Setup d'environnement

**Code :** nouveau modèle LocalEnvironment, PTY/runner et worktrees. Dépend M2-03/M1-05.

**État :** une commande saisie par l'utilisateur peut être lancée explicitement dans un worktree géré déjà créé. Le runner Rust valide le confinement, borne la commande et la sortie, neutralise stdin, expose les états `ready/failed/timedOut`, conserve la durée et le code de sortie, puis permet une relance depuis le panneau d'orchestration. Aucun setup importé n'est exécuté au démarrage.

**Reste :** profils de setup persistants par projet, variables d'environnement autorisées, annulation live/PTY et signal de readiness partagé avec la création de session. Ces extensions doivent conserver la commande explicite et la SSOT du hook de sessions.

**Acceptation :** dépendances installées dans le bon worktree, setup échoué/cancelled et retry ; aucun premier tour annoncé prêt prématurément.

### M2-05 — Handoff

**Code :** services Git/hosts/projets, dialogue dédié. Dépend M2-03/04 et M1-03.

**État :** le panneau d'orchestration propose un plan de handoff local et en lecture seule pour chaque worktree créé. Les préconditions source/cible sont évaluées avec les statuts `pass/warn/blocked` : workspace et cible, conflits, changements non commités, état Git cible observé et branche déjà utilisée. Le plan propose ensuite les étapes d'observation, snapshot et transfert sans déclencher de bascule.

**Reste :** transfert atomique du host MSP, déplacement du contexte, inspection de fichiers ignorés, verrou de processus et rollback explicite. Tant que le host reste mono-workspace, aucun bouton ne doit présenter une conversation comme transférée avant confirmation native.

**Acceptation :** aller/retour Local ↔ Worktree avec fichiers suivis/non suivis ; conflit volontaire et échec intermédiaire sans perte.

### M2-06 — Rétention et nettoyage

**Code :** worktree store, archive, service Git. Dépend M2-03/05.

**État :** le panneau expose **Inspect** pour relire le statut Git d'un checkout géré (branche, changements, conflits, horodatage). La suppression reste distincte de l'archivage d'une conversation, exige une confirmation et le service Rust refuse tout worktree sale avant `git worktree remove`.

**Reste :** détection de processus actifs et de références restantes, politique de rétention configurable, aperçu multi-cibles et reprise d'un nettoyage interrompu. Ne jamais transformer un record archivé en suppression implicite.

**Acceptation :** worktree propre nettoyé, sale conservé, cible hors racine refusée, interruption du nettoyage récupérable.

### M2-07 — Sous-agents live

**Code :** subagent.ts, panels, RPC existantes. Dépend M0-01/05/08.

**Travail :** vérifier la table d'identités parent/agent/enfant ; état demandé vs confirmé ; contrôle followup/stop/resume et drilldown avec pagination disponible. Conserver résultat d'un enfant terminé.

**Acceptation :** deux enfants entrelacés, action sur terminé, host perdu, résultat volumineux ; commande sur A ne touche jamais B.

### M2-08 — Writers concurrents

**Code :** fanout.ts, orchestration, worktrees. Dépend M2-03/07.

**Travail :** vérifier comment l'orchestration moteur reçoit les dossiers des writers ; ne pas promettre une isolation que le prompt seul ne garantit pas. Modéliser quota/file réelle, espace attribué et collecte des résultats ; intégration des changements séparée de l'exécution.

**Acceptation :** deux writers modifient le même nom de fichier dans deux checkouts ; aucun overwrite ; limites et annulation correspondent aux états réels.

## M3 — Outils et exécution planifiée

### M3-01 — MCP local

**Code :** ConnectorPanel/connectors.ts, nouvel adaptateur runtime. Dépend M0-06/08/14.

**État :** `mcp_local_probe` et `mcp_local_call` lancent une commande locale uniquement sur geste utilisateur, parlent le framing MCP stdio (`Content-Length` ou ligne JSON), exécutent `initialize` + `notifications/initialized`, puis `tools/list` ou `tools/call`. La réponse est bornée, le processus est tué après l'échange ou le timeout, et l'UI expose les outils/arguments/résultat.

**Reste :** maintenir un serveur persistant par connecteur, propager `notifications/tools/list_changed`, brancher les tools découverts au catalogue observé par Muse et appliquer la politique d'autorisation du host à chaque appel.

**Acceptation :** serveur fixture expose puis exécute un outil, redémarre, change sa liste et échoue ; appel observé dans une session Muse.

### M3-02 — MCP distant

**Code :** transport/auth dédiés et stockage sécurisé. Dépend M3-01.

**Travail :** ADR transports supportés, OAuth/tokens et règles réseau. Connexion/refresh/révocation, expiration, reconnexion et isolation des comptes ; ne pas conserver secrets dans le registre frontend.

**Acceptation :** serveur réel de test, token expiré, refus réseau et déconnexion ; statut UI confirmé par échange effectif.

### M3-03 — Cycle de vie extension

**Code :** ConnectorPanel/registry/runtime. Dépend M3-01/02.

**État :** un probe local réussi peut enregistrer la commande et les outils découverts dans le registre persistant. Une nouvelle liste remplace l'entrée existante sans réactiver une extension désactivée ; `listConnectorTools` retire immédiatement ses outils lorsque le statut passe à `disabled`.

**Reste :** runtime persistant par connecteur, package/version/source, mise à jour/rollback, arrêt pendant appel et bridge vers les outils réellement visibles par le moteur Muse.

**Acceptation :** installation ratée, mise à jour incompatible, désactivation pendant appel et suppression ; registre et runtime cohérents.

### M3-04 — Découverte SKILL.md

**Code :** skills.ts/SkillPanel, nouveau scanner natif. Dépend M2-01/M0-06.

**Travail :** définir scopes et précédence, parseur des métadonnées, chemins des ressources, déduplication et rechargement. Une ressource relative reste liée au dossier de la skill ; lecture bornée et erreurs visibles.

**État au 16/09/2026 :** `skills_scan` lit les racines conventionnelles du workspace avec bornage de profondeur, taille et nombre de documents. Le parseur frontmatter, la validation des ressources relatives, la priorité projet > repo > équipe > builtin et le rafraîchissement explicite sont livrés ; le panneau affiche provenance et erreurs. Les resources ne sont pas encore chargées dans le contexte moteur, ce qui reste M3-05.

**Acceptation :** skills homonymes, fichier malformé, ressource manquante, scope projet et modification sur disque ; provenance exacte.

### M3-05 — Invocation skill

**Code :** Composer, resolver skills et adaptateur moteur. Dépend M3-04/M0-08.

**Travail :** invocation explicite, chargement des instructions et ressources via contrat moteur ; progression/découverte avec trace compréhensible. Les suggestions ne doivent pas prétendre exécuter une skill.

**État au 16/09/2026 :** une invocation slash d'une skill découverte relit ses ressources relatives juste avant l'envoi via `skills_read_resources`. Les contenus sont bornés, balisés avec leur chemin, et un fichier disparu fait échouer l'envoi avec une entrée système explicite ; les retries réutilisent l'expansion de l'outbox. Le host reçoit encore du texte enrichi, faute de part `skill` documentée avec ressources.

**Acceptation :** invocation réelle avec ressource, skill supprimée entre suggestion et envoi, permission refusée ; pas de double insertion au retry.

### M3-06 — Scheduler réel

**Code :** schedules.ts/SchedulesPanel, nouveau service de scheduling hors cycle React. Dépend M0-09/M2-01 ; M2-03 pour worktree.

**Travail :** séparer Schedule et Run ; capturer projet/workspace/modèle/skills/politique, jamais « session active au moment du tick ». Occurrence crée un run durable puis exécute ; l'inbox contient le résultat, pas une demande de cliquer avant chaque run.

**État au 16/09/2026 :** `Schedule` et `ReviewItem` capturent désormais workspace, projet, modèle et politique d'autorisation au moment de la création. L'approbation vérifie le workspace de la conversation cible et réapplique le modèle/politique capturés avant l'envoi ; un mismatch est refusé explicitement. Les modes workspace et YOLO dispatchent maintenant sans clic et alimentent un journal local borné `ScheduleRun`, visible dans Automations ; `completed` signifie admission du tour (`send_input` acquitté), pas encore la fin du streaming. M3-07 ajoute le rattrapage `latest/skip`, une clé schedule+occurrence, des retries bornés (15/30/60 s, trois tentatives) et l'annulation des retries en attente. Le scheduler natif multi-instance, la reprise après crash/sommeil et la sortie métier restent à implémenter.

**Acceptation :** one-shot/récurrent, cible fixe malgré navigation, échec de démarrage, dispatch automatique selon la politique et historique local ; le run reste explicitement borné à l'admission du tour tant que le host ne fournit pas d'événement de complétion exploitable.

### M3-07 — Reprise du scheduler

**Code :** scheduler/store ; dépend M3-06.

**Travail :** clé unique schedule + occurrence, transactions de claim, politique de rattrapage, fuseau/DST, retry borné avec backoff et annulation. Distinguer machine/app fermée et run interrompu ; ne jamais relancer aveuglément une opération externe au résultat ambigu.

**État au 16/09/2026 :** les occurrences portent maintenant `occurrenceAt`/`occurrenceKey`, les cron manqués suivent `latest` ou `skip`, et le journal limite les échecs à trois tentatives avec backoff 15/30/60 secondes. Une retry en attente est annulable depuis Automations ; les timeouts ambigus ne sont jamais relancés automatiquement. Le claim reste local au renderer : une seule instance Muse doit être active pour garantir l'exclusion.

**Acceptation :** sommeil/réveil, changement d'heure, double instance, crash entre claim et démarrage, suppression schedule ; pas de doublon d'occurrence.

### M3-08 — Inbox de résultats

**Code :** ReviewQueuePanel à faire évoluer, store Runs ; dépend M3-06/07.

**Travail :** statuts queued/running/succeeded/failed/cancelled, timestamps, résumé, cible et lien conversation. Actions ouvrir/retry/archiver ; non-lu séparé de statut métier.

**État au 16/09/2026 :** Automations affiche les huit derniers runs avec statut, horodatage, aperçu borné, erreur, indicateur non-lu, ouverture de la conversation et marquage lu. Un run passe à `completed` au premier statut d'arrêt du host et conserve l'aperçu de la dernière réponse assistant ; avant cet événement, il reste `running` même si `send_input` a été acquitté. Le filtrage, l'archivage et les résumés riches restent à faire.

**Acceptation :** aucun résultat présenté avant terminaison, historique durable et ouverture de la bonne session après restart.

### M3-09 — Notifications

**Code :** `src/lib/notifications.ts`, `useMuseSessions` et `SchedulesPanel` ; dépend M3-08/M0-12.

**État au 16/09/2026 :** l'inbox locale est livrée pour les runs terminés/échoués et pour les demandes d'autorisation ou de réponse utilisateur : chaque entrée conserve une clé d'idempotence, un aperçu, la session cible et un état non-lu ; Automations permet l'ouverture de la conversation et le marquage lu. L'API `Notification` du webview est utilisée à la demande quand la permission est accordée, avec un fallback explicite dans l'app et sans rejouer les historiques au démarrage. Le plugin Tauri officiel est enregistré avec sa permission desktop ; les préférences muettes et les actions de clic OS restent ouvertes.

**Travail restant :** service natif OS/Tauri, préférences muettes et notifications de demandes utilisateur. Pas de notification par token ou tick.

**Acceptation :** notification unique, clic ouvre la cible, cible supprimée, OS refuse et mode muet respecté.

## M4 — Études puis capacités étendues

Les études produisent un ADR avec API réellement disponible, prototype minimal, contraintes OS/permissions, coûts et critère go/no-go. Un no-go reste visible dans la roadmap, sans écran laissant croire à une disponibilité.

### M4-01 — Navigateur

**Code :** BrowserPanel et nouvelle surface native ; dépend M0-06/14. Comparer webview dédiée et moteur navigateur contrôlable, sessions/cookies, navigation, téléchargements et restrictions d'embed. **Acceptation :** vrais sites non iframe, erreurs réseau et isolation ; aucune URL dangereuse chargée via protocole non prévu.

### M4-02 — Annotation visuelle

**Code :** browserAnnotate.ts, capture et composer ; dépend M4-01/M1-08. Définir URL/frame/viewport/région/élément/version avec capture réelle ; conserver provenance et signaler contexte périmé. **Acceptation :** sélection scrollée, iframe, zoom et envoi de l'image/ancre correcte.

### M4-03 — Pilotage navigateur

**Code :** adaptateur outils navigateur ; dépend M4-01/M3-01 et moteur compatible. Exposer observe/click/type/navigation avec surface et session explicites, arrêt et erreurs ; traiter le texte de page comme données non fiables. **Acceptation :** workflow web complet, navigation inattendue et stop sans agir sur un autre onglet.

### M4-04 — Computer use

**Code :** service distinct par OS ; dépend M0-06 et faisabilité moteur. Autorisations OS, inventaire des apps, capture/action ciblées, interruptions et journal minimal. **Acceptation :** application de test, permission refusée, fenêtre disparue, utilisateur reprenant le contrôle ; pas d'action après stop.

### M4-05 — Artefacts riches

**Code :** artifacts.ts, previews et service fichiers ; dépend M1-07/08. Séparer génération image/document côté moteur, fichiers persistés et rendu sécurisé ; détecter formats supportés, version/source réelle et export. **Acceptation :** fichier ouvert hors app, preview défaillante avec fallback, version et provenance exactes ; ne pas assimiler bloc Markdown et fichier livré.

### M4-06 — Partage hébergé

**Code :** SharePanel/sharing.ts et nouveau service distant ; dépend décision d'hébergement/auth. Créer snapshot avec données explicitement incluses, permissions/token, durée et révocation ; secrets exclus. **Acceptation :** second client, lien révoqué, export incomplet et erreur de publication ; aucune URL annoncée avant création réelle.

### M4-07 — Remote/cloud

**Code :** abstraction HostConnection et service distant à concevoir ; dépend M0-01/02/06 et M2. Séparer exécution sur ordinateur distant connecté et environnement cloud provisionné. Auth, découverte, événements reconnectables, transfert d'artefacts et contrôle de versions. **Acceptation :** déconnexion/reprise sans doublons, host indisponible, commande ciblée et destruction explicite d'environnement.

### M4-08 — Voix

**Code :** module audio et intégration composer à créer. ADR transcription seule vs dialogue temps réel, fournisseurs et consentement micro. Gestion annulation, latence, erreurs et absence de conservation audio implicite. **Acceptation :** micro absent/refusé, interruption, transcription éditable avant envoi et destination inchangée.

### M4-09 — Distribution

**Code :** Tauri config, bridge, scripts build et CI. Dépend M0-10/14. Matrice OS/architecture, moteur supporté, provenance/checksum des binaires, signature selon canal, mises à jour signées et récupération. **Acceptation :** installer sur machine propre, mettre à jour depuis version précédente et désinstaller sans effacer les projets ; preuves propres à chaque plateforme.

## Format de passage de relais

À remplir dans chaque PR ou note de livraison :

```text
Roadmap ID / sous-ticket :
Base et commit livré :
Scénario utilisateur avant → après :
Design / UI / Fonction / Validation avant → après :
Contrats et migrations ajoutés :
Fichiers modifiés et rôle :
Tests : commande, plateforme, version moteur, résultat :
Preuve live vs fixture :
Limites restantes et dépendances :
Prochain sous-ticket concret :
```

Ne déclarer un parent terminé que lorsque tous ses critères d'acceptation sont couverts. Le premier prochain lot conseillé est **M0-03 (envoi sans perte)**, tout en gardant ouverts M0-01c/M0-02c pour la validation native et la réconciliation complète.
