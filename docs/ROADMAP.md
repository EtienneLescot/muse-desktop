# Roadmap opérationnelle — Muse-Desktop

État de référence : **15 septembre 2026, main `589022e`**, après fusion de la PR #12. Ordre M0 → M4 validé par Étienne. Objectif : finir les parcours existants, puis atteindre la parité des workflows desktop de Codex en conservant le branding Muse.

Ce document est la source de vérité de l'avancement produit. La [SPEC](SPEC.md) conserve les intentions initiales ; le [bilan du 13 septembre](plans/2026-09-13-roadmap-progress.md) est historique. L'[audit de parité](plans/2026-09-15-codex-parity-audit.md) contient les constats techniques et références officielles. Les chiffres de stories fusionnées ne sont pas un taux de parité.

**Pour les agents de codage :** le [plan d'implémentation détaillé](plans/2026-09-15-agent-implementation-plan.md) couvre les 53 IDs ci-dessous : code à lire, contrats proposés, étapes, dépendances, tests d'acceptation et format de livraison. Ce plan complète les statuts ; il ne constitue pas une preuve d'implémentation.

## Lire les statuts

Chaque ligne décrit un résultat utilisateur assez petit pour être livré et vérifié séparément.

| Axe | Valeurs | Signification |
|---|---|---|
| Design | À définir / Maquette / Adapté / — | À définir : parcours détaillé manquant ; Maquette : prototype interactif seulement ; Adapté : interface réelle conçue pour le périmètre indiqué ; — : travail sans écran |
| UI | Absente / Partielle / Présente / — | État de l'interface dans `src/`, indépendamment de son fonctionnement |
| Fonction | Absente / Locale / Manuelle / Partielle / Câblée / — | Locale : données ou logique dans l'app ; Manuelle : l'utilisateur exécute hors app ; Partielle : une partie seulement atteint le système ; Câblée : chemin réel vers moteur/OS/service |
| Validation | À faire / Unitaire / UI / E2E | Unitaire : fonctions/protocole ; UI : navigateur avec données synthétiques ; E2E : scénario complet sur runtime réel, avec plateforme et preuve |

**Câblée ne signifie pas terminée.** La validation indiquée est le niveau de preuve disponible, pas un certificat pour tous les cas. « À faire » signifie absence de preuve pour le résultat précis. Aucun élément ci-dessous n'est déclaré terminé au sens de la parité multiplateforme.

L'exécution des futurs tickets est **à planifier** : « interface présente » ou « partielle » décrit le code existant, pas un chantier actuellement en cours. Une dépendance non levée interdit de déclarer son résultat livré.

Exemples : revue Git = **maquettée, implémentation absente** ; connecteurs MCP = **UI présente, exécution non câblée** ; worktrees = **helper commencé, exécution manuelle** ; modèles = **câblés, validation E2E à consolider**.

## M0 — Fiabiliser et finir l'existant

Priorité immédiate. Ne pas ajouter de nouvelles surfaces avant de sécuriser ces parcours.

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M0-01 | A continue à travailler quand on ouvre le projet B | — | Présente | Câblée | Unitaire | Routage isolé implémenté sur la branche fix/workspace-host-isolation ; coexistence de deux moteurs réels vérifiée sans tour modèle. Reste : E2E natif A/B avec flux et approbations simultanés ; voir sous-tickets ci-dessous |
| M0-02 | Reprendre une conversation après fermeture ou panne du moteur | Adapté | Présente | Partielle | UI | Reconnexion explicite câblée via session/read + session/resume ; tests moteur sans tour et UI avec IPC simulé réussis. Reste : historique manquant côté client, demandes en attente et reprise d'un tour via UI native |
| M0-03 | Ne perdre aucun texte lors d'un envoi rejeté | À définir | Présente | Câblée | Unitaire | Outbox durable par envoi (clientMessageId, sending/accepted/failed) : brouillon vidé seulement à l'acquittement, entrée réessayable après refus ou timeout ambigu, vérification serveur (`session/read`) avant toute retransmission. Reste : E2E natif (moteur coupé pendant l'envoi, fermeture/rechargement, double-clic, IME) |
| M0-04 | Arrêter et reprendre avec des états fiables | Adapté | Présente | Câblée | Unitaire | Tester arrêt avant premier token, pendant outil et après fin ; distinguer demande d'arrêt et arrêt confirmé |
| M0-05 | Répondre aux permissions/questions même après incident | Adapté | Présente | Câblée | Unitaire | Recharger les demandes en attente si le protocole le permet ; invalider les demandes périmées ; vérifier rejet, correction et absence de replay |
| M0-06 | Afficher la politique de permissions réellement effective | À définir | Partielle | Partielle | Unitaire | Relier ou désactiver les préférences non appliquées ; distinguer préférence et posture du host ; un test réel confirme refus/autorisation |
| M0-07 | Protéger les diagnostics et éviter un crash sur Unicode | — | — | Partielle | À faire | Retirer le wire log brut par défaut ; si diagnostic activé, rédaction/rotation et troncature UTF-8 sûre ; aucune frame brute en usage normal |
| M0-08 | Détecter une incompatibilité du moteur | À définir | Partielle | Partielle | Unitaire | Inventorier toutes les RPC utilisées, pas seulement les huit du registre actuel ; vérifier capacités/fingerprint ; erreur exploitable au démarrage |
| M0-09 | Conserver les données sans échec silencieux | À définir | Partielle | Locale | Unitaire | Versionner/migrer le stockage, gérer quota et données corrompues, offrir récupération/export ; éprouver migration et saturation |
| M0-10 | Réussir le premier lancement Windows | À définir | Partielle | Partielle | À faire | Détecter WSL, Muse et authentification ; guider vers la correction ; valider installation sur machine propre, sans configuration développeur |
| M0-11 | Finir l'anglais et les détails de navigation | Adapté | Présente | Locale | UI | Corriger textes résiduels, erreurs, titres générés et raccourcis propres aux OS ; passer la même checklist sur accueil, conversation et vues secondaires |
| M0-12 | Utiliser l'existant au clavier et au lecteur d'écran | Adapté | Partielle | Locale | UI | Auditer tabulations, focus/restauration, dialogues, annonces de streaming, contrastes et réduction de mouvement ; validation assistive réelle |
| M0-13 | Identifier clairement les capacités non connectées | À définir | Partielle | Locale | UI | Uniformiser « local », « manuel », « non connecté » ; retirer les actions trompeuses ; aucune action ne promet un effet serveur absent |
| M0-14 | Disposer de contrôles reproductibles avant fusion | — | — | Absente | À faire | Ajouter CI build/Node/Rust et scénarios natifs ; conserver fixtures sans secrets et preuves par plateforme ; CI verte sur chaque PR |

Preuves principales : [backend](../src-tauri/src/main.rs), [sessions](../src/hooks/useMuseSessions.ts), [Composer](../src/components/Composer.tsx), [paramètres](../src/components/SettingsPanel.tsx), [conformité MSP](../src/lib/msp.ts), [bridge Windows](../scripts/wsl-bridge/README.md).

### Livraison M0-01 — 15 septembre 2026

- **M0-01a — implémenté, tests unitaires passés** : registre de moteurs par chemin canonique, appartenance explicite des sessions, routage de toutes les commandes par session, isolation des approbations et des événements de terminaison, arrêt de tous les moteurs à la fermeture. Les contrôles de chemins du compositeur utilisent désormais le workspace de sa session.
- **M0-01b — smoke moteur passé** : Windows + bridge WSL, deux `muse serve` réels, initialize/initialized, session/start A/B, model/list sur chaque session puis sur A après fermeture de B. Aucun tour modèle envoyé. Ce test exerce les moteurs/bridge ; les tests Rust exercent le registre du superviseur.
- **M0-01c — à valider** : scénario complet via l'UI native, deux tours concurrents avec approbations et arrêt d'un moteur ; qualification macOS/Linux. Le parent M0-01 reste ouvert jusqu'à cette preuve.
- La reprise de sessions historiques après redémarrage reste M0-02 : une session sans moteur propriétaire connu échoue explicitement, sans être envoyée à un moteur arbitraire. La restauration live n'importe pas aveuglément des sessions appartenant à un autre host.

### Livraison M0-03 — 15 septembre 2026

- **Envoi sans perte — implémenté, tests unitaires passés** : chaque envoi logique porte un `clientMessageId` stable (entrée d'outbox durable par session dans `muse-desktop.outbox.v1.*`, états sending/accepted/failed). Le brouillon du composer n'est vidé qu'à l'acquittement du superviseur ; un refus laisse le texte dans le champ, un échec crée une entrée réessayable (bannière Retry/Discard) routée par `sessionId`, jamais par la conversation affichée. Un timeout d'acquittement (15 s) ou un redémarrage en plein envoi marque l'entrée ambiguë : la reprise vérifie la conversation serveur via `session/read` (`check_input_reached`, scan exact) avant toute retransmission — un envoi logique ne peut pas devenir deux tours. Le retry réutilise l'expansion stockée (skill/fanout/projet) et l'entrée de log existante, sans jamais doubler le texte.
- **Tests** : `npm test` (360 passés, dont outbox : machine à états, récupération au boot, persistance, clé conservée dans le log) ; `npm run build` ; `cargo test --bin muse-desktop` (32 passés, dont le scan exact `input_reached`). Aucun tour modèle.
- **À valider** : E2E natif — moteur coupé pendant l'envoi, refus serveur, double-clic, fermeture/rechargement, changement de conversation, échec du premier prompt, IME et saisie pendant l'attente. Le parent M0-03 reste ouvert jusqu'à cette preuve.

Validation de cette livraison : build frontend et 346 tests Node ; suite Rust incluant les scénarios de routage A/B, collision d'identité, session supprimée, fin d'un host, ancienne génération et fermeture du superviseur.

**Sortie M0 :** scénario natif créer → envoyer → stream → approuver → répondre → interrompre → réessayer, puis redémarrage et deux projets simultanés. Aucun réglage ne prétend modifier une capacité qu'il ne contrôle pas. Validation Windows d'abord ; support macOS/Linux qualifié séparément.

### Livraison M0-02 — reconnexion explicite

- **M0-02a — câblé** : action Reconnect pour une conversation non rattachée ; validation de son identité, de son historique durable et de son dossier avant session/resume. Pas de création silencieuse d'une nouvelle session. Envoi indisponible tant que la reconnexion n'est pas confirmée.
- **M0-02b — validé partiellement** : un moteur réel crée la session, se ferme, puis un nouveau moteur relit/reprend le même identifiant et répond au catalogue. Aucun tour modèle envoyé. Test React/Chromium avec IPC simulé : échec visible, messages conservés, nouvel essai avec le bon dossier, action retirée après succès.
- **M0-02c — reste à faire** : importer le suffixe d'historique manquant, valider les demandes en attente réellement réémises et poursuivre un tour de bout en bout dans la webview native. La reprise demande uniquement les métadonnées (`excludeItems`) et conserve l'historique local actuel ; elle ne prétend pas le resynchroniser complètement.
- Limite Windows : conversion des chemins du bridge pour les montages WSL standards `/mnt/<lecteur>/`. Un montage personnalisé non résolvable échoue explicitement ; les chemins ne sont pas devinés.

Preuves : [validation de reprise](../src-tauri/src/resume.rs), commande `resume_session` dans le backend et `reconnectSession` dans le hook. Suite Rust : 31 tests ; suite Node : 346 tests ; build frontend réussi.

## M1 — Terminer le workflow quotidien de développement

La maquette `design/prototype` ne constitue pas une implémentation native. Les contrats d'erreur et les opérations destructives restent à concevoir même lorsqu'un écran existe.

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M1-01 | Voir les fichiers réellement modifiés | Maquette | Absente | Absente | À faire | Backend Git status/diff ; scopes non indexé/indexé/branche/dernier tour ; correspondance exacte avec Git, y compris renommages et fichiers binaires |
| M1-02 | Commenter une ligne de diff et demander sa correction | À définir | Absente | Absente | À faire | Ancrer fichier, révision, côté et ligne ; transmettre au bon contexte ; gérer commentaire devenu obsolète |
| M1-03 | Indexer ou annuler une modification | À définir | Absente | Absente | À faire | Actions fichier puis hunk ; protections contre changement concurrent ; annulation explicite et aucune perte silencieuse |
| M1-04 | Commit, push et création de PR depuis l'app | Maquette | Absente | Absente | À faire | Relier identité/remote/branche ; gérer auth, hooks, rejet et conflits ; vérifier le commit et la PR réellement créés |
| M1-05 | Ouvrir et utiliser un terminal du projet | Maquette | Absente | Absente | À faire | PTY natif, entrée/sortie, resize et fermeture ; cwd lié à la conversation ; processus long conservé lors des changements de vue |
| M1-06 | Faire lire au moteur la sortie du terminal | À définir | Absente | Absente | À faire | Exposer un contexte borné et attribué au bon terminal ; le moteur peut diagnostiquer un build échoué sans copier-coller |
| M1-07 | Consulter les vrais fichiers du projet | Maquette | Partielle | Locale | Unitaire | Remplacer la seule liste de fichiers cités par accès disque contrôlé et ouverture pertinente ; contenu actuel, pas extrait de réponse |
| M1-08 | Ajouter fichiers et images à une demande | À définir | Partielle | Partielle | Unitaire | Les mentions actuelles enrichissent du texte ; concevoir pièces jointes, drag/drop et limites ; preuve que le moteur reçoit le contenu/type attendu |
| M1-09 | Créer une branche de conversation fidèle | Maquette | Partielle | Locale | Unitaire | Utiliser session/fork si disponible ; choisir le point source ; conserver contexte et dossier ; ne pas confondre avec « nouvelle depuis résumé » |
| M1-10 | Réorienter une exécution ou mettre un message en attente | À définir | Absente | Absente | À faire | Exploiter steer/queue selon capacités servies ; états visibles, annulation, ordre et absence de double envoi |
| M1-11 | Choisir un modèle disponible et suivre le contexte | Adapté | Présente | Câblée | Unitaire | Consolider tests live list/setModel/compact, erreurs et persistance ; fallback explicitement non live ; état confirmé par le moteur |
| M1-12 | Retrouver et organiser les conversations | Adapté | Partielle | Locale | UI | Étendre recherche à l'historique, épinglage/ordre et états non lus ; préserver les résultats au redémarrage sans déplacer le focus |
| M1-13 | Lire une longue conversation confortablement | Adapté | Présente | Partielle | UI | Vérifier rendu Markdown/code/liens et outils ; mesurer longue session, mémoire et scroll ; virtualiser si les mesures l'exigent |

Preuves : [maquette](../design/prototype/), [contenus actuels](../src/components/ArtifactsPane.tsx), [messages](../src/components/MessageContent.tsx), [mentions](../src/lib/mentions.ts), [shell applicatif](../src/App.tsx).

**Dépendances :** M1-01 → M1-02/03/04 ; M0-01 → M1-05/06/09/10 ; capacités moteur à vérifier avant M1-08/09/10. **Sortie M1 :** réaliser, inspecter, corriger, tester et livrer une modification de dépôt depuis Muse, avec un chemin de récupération en cas d'erreur.

## M2 — Projets et travail parallèle isolé

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M2-01 | Un projet représente des dossiers persistants | À définir | Partielle | Locale | Unitaire | Ajouter racines et environnement au projet ; migration des groupes existants ; création de conversation dans la bonne racine |
| M2-02 | Les paramètres projet s'appliquent réellement | Adapté | Présente | Partielle | Unitaire | Résoudre héritage global/projet/session vers le moteur ; afficher origine et valeur effective ; prouver deux configurations isolées |
| M2-03 | Créer automatiquement un worktree pour une conversation | Maquette | Partielle | Manuelle | Unitaire | Remplacer snippet par backend ; branche de départ, chemin unique, rollback d'échec ; checkout initial inchangé |
| M2-04 | Préparer l'environnement du worktree | À définir | Absente | Absente | À faire | Scripts/actions de setup avec progression et erreurs ; dépendances nécessaires disponibles avant le premier tour |
| M2-05 | Passer de Local à Worktree et inversement | À définir | Absente | Absente | À faire | Transférer contexte et changements ; traiter conflits, fichiers ignorés et branche déjà utilisée ; aucune perte de travail |
| M2-06 | Nettoyer les worktrees sans supprimer du travail | À définir | Absente | Absente | À faire | Lier archive et rétention, détecter dirty/running ; nettoyage uniquement sûr, confirmation explicite si nécessaire |
| M2-07 | Piloter les sous-agents réels | Adapté | Présente | Câblée | Unitaire | Vérifier followup/stop/resume/result/drilldown sur agents vivants ; identité et états corrects jusqu'à terminaison |
| M2-08 | Exécuter plusieurs writers sans collision | À définir | Partielle | Partielle | Unitaire | Associer writers aux espaces isolés, file réelle et limites explicites ; tests de modifications concurrentes et résultats séparés |

Preuves : [projets](../src/lib/projects.ts), [plan worktree manuel](../src/lib/worktrees.ts), [orchestration](../src/components/OrchestrationPanel.tsx), [fan-out](../src/lib/fanout.ts).

**Dépendances :** M0-01/02 et M1-01 avant M2-03 ; M2-03 avant M2-04/05/06/08. **Sortie M2 :** deux conversations modifient/testent des espaces indépendants ; redémarrage, transfert et nettoyage préservent les changements.

## M3 — Extensions et automatisations opérationnelles

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M3-01 | Connecter un serveur MCP local | Adapté | Présente | Locale | Unitaire | Transport, processus, handshake et vrais tools/list/call ; appel observé par le moteur, erreurs et arrêt propres |
| M3-02 | Connecter un serveur MCP distant | À définir | Partielle | Locale | Unitaire | Transport/auth/secrets, restrictions et reconnexion ; aucun statut « connecté » sans échange réel |
| M3-03 | Installer/désactiver une extension réellement utilisable | Adapté | Présente | Locale | Unitaire | Relier registre et runtime, actualiser outils, désinstallation et permissions ; effet observable sur les outils du moteur |
| M3-04 | Découvrir les skills du disque et du projet | À définir | Partielle | Locale | Unitaire | SKILL.md, ressources relatives, priorité de scopes et rechargement ; une skill installée est utilisable sans recopie manuelle |
| M3-05 | Invoquer une skill avec son vrai contexte | Adapté | Présente | Partielle | Unitaire | Charger instructions/ressources au bon moment, afficher provenance ; résultat live reproductible et erreurs explicites |
| M3-06 | Exécuter un travail planifié sans clic préalable | Adapté | Présente | Partielle | Unitaire | Remplacer file d'approbation avant exécution par scheduler réel ; cible fixe, politique effective et création de run durable |
| M3-07 | Gérer sommeil, reprise, doublons et échecs de planning | À définir | Absente | Absente | À faire | Politique de rattrapage, fuseau/DST, idempotence et retries ; une occurrence ne produit pas deux runs |
| M3-08 | Examiner les résultats des runs | À définir | Partielle | Locale | Unitaire | Inbox de résultats, états/horaires/historique/lien conversation ; distinguer résultat et instruction en attente |
| M3-09 | Recevoir une notification utile | À définir | Absente | Absente | À faire | Notifications OS, préférences, non-lus et ouverture de la bonne conversation ; pas de répétition d'une notification déjà traitée |

Preuves : [connecteurs](../src/lib/connectors.ts), [skills](../src/lib/skills.ts), [planning](../src/lib/schedules.ts), [file actuelle](../src/components/ReviewQueuePanel.tsx).

**Dépendances :** M0-06/08 avant MCP ; M2-01 et M0-02/09 avant M3-06 ; M2-03 si run isolé ; M3-06/07 avant inbox. **Sortie M3 :** un run programmé utilise un vrai outil/skill, s'exécute selon la politique et produit un résultat consultable. Pour les runs locaux, app et ordinateur allumés restent une contrainte explicitée.

## M4 — Parité étendue

Ces écarts restent visibles pour une ambition de parité complète. Leur faisabilité doit être vérifiée avec le moteur Muse avant engagement d'implémentation.

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M4-01 | Naviguer dans un vrai navigateur intégré | À définir | Partielle | Locale | Unitaire | Remplacer l'iframe limitée par une surface adaptée ; navigation, sessions et erreurs maîtrisées |
| M4-02 | Annoter visuellement une page et transmettre le contexte | À définir | Partielle | Locale | Unitaire | Sélection réelle, capture, URL et ancre ; demande reçue avec la bonne région, sans saisie manuelle du contexte |
| M4-03 | Faire piloter le navigateur par Muse | À définir | Absente | Absente | À faire | Observation/actions et permissions ; scénario web complet reproductible |
| M4-04 | Faire piloter une application desktop | À définir | Absente | Absente | À faire | Runtime par OS et consentement effectif ; exécution interrompable et attribution claire des actions |
| M4-05 | Produire/consulter des images et documents riches | À définir | Partielle | Partielle | À faire | Capacités moteur, fichiers réels et previews ; génération/export avec résultat utilisable |
| M4-06 | Partager par URL et révoquer l'accès | À définir | Partielle | Locale | Unitaire | Hébergement, identité, permissions et révocation réelle ; second client lit puis perd l'accès |
| M4-07 | Contrôler une exécution sur un autre host ou dans le cloud | À définir | Absente | Absente | À faire | Auth, routage, stockage et reprise distante ; statut exact après déconnexion |
| M4-08 | Interagir par la voix | À définir | Absente | Absente | À faire | Choisir capture/transcription ou conversation temps réel ; définir permissions et preuve de bout en bout |
| M4-09 | Installer et mettre à jour sur les plateformes annoncées | À définir | Partielle | Partielle | À faire | Packaging reproductible, signature selon distribution, updates et rollback ; qualification séparée Windows/macOS/Linux |

Preuves : [browser actuel](../src/components/BrowserPanel.tsx), [exports locaux](../src/lib/sharing.ts), [artefacts](../src/lib/artifacts.ts).

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

1. Chaque PR cite les IDs concernés et met à jour uniquement les axes réellement modifiés. Exemple : ajouter un formulaire ne fait pas passer Fonction de Locale à Câblée.
2. La preuve doit préciser commit, commande/scénario, plateforme et résultat. Ne pas appliquer une preuve UI synthétique au moteur natif.
3. Une livraison partielle crée des sous-tickets `M0-01a`, `M0-01b` avec critères séparés ; elle ne clôt pas le parent.
4. Pour déclarer un ticket terminé : effet réel, erreurs/reprise traitées, permissions effectives, validation native du scénario et documentation des limites.
5. Les décisions de faisabilité/produit sont consignées avant de transformer une hypothèse en engagement. Aucun pourcentage global tant que le périmètre et sa pondération ne sont pas fixés.

Validation du socle audité : build frontend, 346 tests Node, 25 tests Rust verts. Les preuves UI de la passe précédente sont détaillées dans [la passe conversations](plans/2026-09-14-conversation-polish.md). Elles ne couvrent pas l'ensemble des critères futurs ci-dessus.
