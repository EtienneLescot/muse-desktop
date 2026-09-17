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
| M0-02 | Reprendre une conversation après fermeture ou panne du moteur | Adapté | Présente | Partielle | UI | Reconnexion explicite câblée via session/read + session/resume ; état de connexion par conversation (`disconnected / connecting / connected / error`) ; réhydratation des items pliés côté client par `itemId` avec conservation des notes locales ; liveness du host visible dans le stream avec attente d'action et état stale ; après une autorisation/réponse acceptée, un état transitoire `Muse is resuming` reste visible jusqu'au prochain événement du host ; un dépassement du buffer d'événements est maintenant signalé et déclenche une réconciliation bornée des demandes et de l'historique ; tests moteur sans tour et UI avec IPC simulé réussis. Reste : validation native des demandes en attente et reprise d'un tour |
| M0-03 | Ne perdre aucun texte lors d'un envoi rejeté | À définir | Présente | Câblée | Unitaire | Outbox durable par envoi (clientMessageId, sending/accepted/failed) : brouillon vidé seulement à l'acquittement, entrée réessayable après refus ou timeout ambigu, vérification serveur (`session/read`) avant toute retransmission. Reste : E2E natif (moteur coupé pendant l'envoi, fermeture/rechargement, double-clic, IME) |
| M0-04 | Arrêter et reprendre avec des états fiables | Adapté | Présente | Câblée | Unitaire | L'arrêt distingue désormais la demande acceptée (`Stopping Muse`) du statut terminal confirmé ; le transcript reste ouvert jusqu'à `stopped` et le double-clic est ignoré. Reste : qualification native avant premier token, pendant outil, après fin et avec réponse tardive |
| M0-05 | Répondre aux permissions/questions même après incident | Adapté | Présente | Câblée | Unitaire | `list_pending_requests` relit `approval/listPending` après reconnexion et reconstruit les cartes approval/input par session ; les événements de reprise restent dédupliqués par identifiant ; la décision acceptée expose explicitement l'attente de reprise du host et bascule en état stale avec actions si aucun événement n'arrive. Reste : validation native des courses stale et des demandes effectivement réémises |
| M0-06 | Afficher la politique de permissions réellement effective | Adapté | Présente | Câblée | Unitaire | Sélecteur global Ask / Approve on my behalf / YOLO, mapping vers l'enum MSP, persistance et changement en session via `session/setApprovalMode` ; distinguer posture locale et plafond du host ; le contrat réel est vérifié sur le binaire 1.3.0 |
| M0-07 | Protéger les diagnostics et éviter un crash sur Unicode | Adapté | Présente | Partielle | Unitaire | Aucun wire log brut par défaut ; stderr borné à 20 lignes/8 000 caractères, secrets évidents masqués, troncature UTF-8 sûre et collecte native de compteurs via `collect_diagnostics` ; export local de compteurs et d'erreur rédigée livré ; les échecs terminaux MSP sont maintenant conservés avec catégorie/message/retryable et affichés dans une disclosure ; qualification native des erreurs moteur détaillées reste à faire |
| M0-08 | Détecter une incompatibilité du moteur | Adapté | Présente | Câblée | Unitaire | Handshake validé sur `serverInfo`, version MSP majeure et fingerprint ; toutes les RPC émises sont listées dans `src/lib/msp.ts` ; erreur exploitable au démarrage, qualification des anciennes versions restant séparée |
| M0-09 | Conserver les données sans échec silencieux | Adapté | Présente | Locale | Unitaire | Façade défensive câblée sur tous les modules de persistance connus ; signalement corruption/indisponibilité/quota, export/import sélectif de récupération et migration explicite des alias historiques sans écrasement livrés ; formats externes et reprise après interruption restent à qualifier |
| M0-10 | Réussir le premier lancement Windows | Adapté | Présente | Partielle | Unitaire | Guidance contextuelle après échec (sidecar, WSL, Muse CLI, authentification, dossier) et sonde native bornée affichée dans l'écran de récupération ; détection sur machine propre et matrice WSL/auth restent à valider |
| M0-11 | Finir l'anglais et les détails de navigation | Adapté | Présente | Locale | UI | Libellés résiduels harmonisés sur accueil, conversation, projets, import et résumé ; recherche indépendante de la locale française ; infobulles Ctrl/Cmd adaptées à l’OS ; copie d'erreur centralisée sur les surfaces principales et secondaires, y compris scan skills, modèles, pièces jointes et contrôles fenêtre ; reste : checklist native finale des titres et erreurs spécifiques |
| M0-12 | Utiliser l'existant au clavier et au lecteur d'écran | Adapté | Présente | Locale | UI | Focus initial et restauration après dialogues, navigation clavier des approvals et des demandes d'entrée, boucle Tab locale et annonces de streaming en place ; validation assistive réelle, zoom 200 % et contraste restent à qualifier |
| M0-13 | Identifier clairement les capacités non connectées | Adapté | Présente | Locale | UI | Vocabulaire commun Available / Local / Manual / Not connected avec raison ; badges ajoutés aux connecteurs, channels, exports, worktrees, index local et import CLI/IDE ; reste : vérifier chaque action réelle |
| M0-14 | Disposer de contrôles reproductibles avant fusion | — | — | Partielle | Unitaire | CI build/Node/Rust et artefacts d'échec bornés ajoutés sans credentials ni binaire sidecar ; fixture MSP livrée ; la perte du ring d'événements est désormais détectable côté polling ; restent les scénarios natifs A/B et la panne d'envoi avec l'interface Tauri |

Preuves principales : [backend](../src-tauri/src/main.rs), [sessions](../src/hooks/useMuseSessions.ts), [Composer](../src/components/Composer.tsx), [paramètres](../src/components/SettingsPanel.tsx), [persistance défensive](../src/lib/storage.ts), [conformité MSP](../src/lib/msp.ts), [bridge Windows](../scripts/wsl-bridge/README.md).

### Livraison M0-01 — 15 septembre 2026

- **M0-01a — implémenté, tests unitaires passés** : registre de moteurs par chemin canonique, appartenance explicite des sessions, routage de toutes les commandes par session, isolation des approbations et des événements de terminaison, arrêt de tous les moteurs à la fermeture. Les contrôles de chemins du compositeur utilisent désormais le workspace de sa session.
- **M0-01b — smoke moteur passé** : Windows + bridge WSL, deux `muse serve` réels, initialize/initialized, session/start A/B, model/list sur chaque session puis sur A après fermeture de B. Aucun tour modèle envoyé. Ce test exerce les moteurs/bridge ; les tests Rust exercent le registre du superviseur.
- **M0-01c — à valider** : scénario complet via l'UI native, deux tours concurrents avec approbations et arrêt d'un moteur ; qualification macOS/Linux. Le parent M0-01 reste ouvert jusqu'à cette preuve.
- La reprise de sessions historiques après redémarrage reste M0-02 : une session sans moteur propriétaire connu échoue explicitement, sans être envoyée à un moteur arbitraire. La restauration live n'importe pas aveuglément des sessions appartenant à un autre host.

### Livraison M0-03 — 15 septembre 2026

- **Envoi sans perte — implémenté, tests unitaires passés** : chaque envoi logique porte un `clientMessageId` stable et un `commandId` UUIDv7 dérivé, persisté dans l'outbox par session (`muse-desktop.outbox.v1.*`, états sending/accepted/failed). Le brouillon du composer n'est vidé qu'à l'acquittement du superviseur ; un refus laisse le texte dans le champ, un échec crée une entrée réessayable (bannière Retry/Discard) routée par `sessionId`, jamais par la conversation affichée. Un timeout d'acquittement (15 s) ou un redémarrage en plein envoi marque l'entrée ambiguë : la reprise vérifie `commandId`/`turnId` dans la réponse structurée de `session/read` avant toute retransmission — un envoi logique ne peut pas devenir deux tours. Le retry réutilise l'expansion stockée (skill/fanout/projet) et l'entrée de log existante, sans jamais doubler le texte. Une requête Tauri encore pendante conserve aussi le verrou de session jusqu'à sa résolution.
- **Tests** : `npm test` (370 passés, dont outbox : machine à états, récupération au boot, identité serveur, persistance, clé conservée dans le log) ; `npm run build` ; `cargo test --bin muse-desktop` (40 passés, dont `input_reached`, les approbations composées, le mapping de posture et les diagnostics bornés). Aucun tour modèle.
- **À valider** : E2E natif — moteur coupé pendant l'envoi, refus serveur, double-clic, fermeture/rechargement, changement de conversation, échec du premier prompt, IME et saisie pendant l'attente. Le parent M0-03 reste ouvert jusqu'à cette preuve.

Validation de cette livraison : build frontend et 370 tests Node ; suite Rust (40 tests) incluant les scénarios de routage A/B, approbations composées, collision d'identité, session supprimée, fin d'un host, ancienne génération, diagnostics bornés et fermeture du superviseur.

**Sortie M0 :** scénario natif créer → envoyer → stream → approuver → répondre → interrompre → réessayer, puis redémarrage et deux projets simultanés. Aucun réglage ne prétend modifier une capacité qu'il ne contrôle pas. Validation Windows d'abord ; support macOS/Linux qualifié séparément.

### Livraison M0-07 — diagnostics sûrs

- **M0-07a — câblé** : la capture brute de frames n'est pas activée en usage normal. La queue stderr est limitée à 20 lignes, chaque ligne à 1 000 caractères et le message final à 8 000 caractères.
- **M0-07b — garde-fou** : les valeurs de formes `token=`, `password:`, `api_key=` et les bearer tokens sont remplacées avant affichage ; la troncature respecte les frontières UTF-8 et ne peut pas paniquer sur des erreurs Unicode.
- **M0-07c — export local livré** : Settings propose **Export diagnostics**. Le JSON reste borné aux compteurs de sessions/événements, états d'attente, backend et dernière erreur rédigée ; le workspace et le transcript ne sont jamais exportés.
- **M0-07d — compteurs natifs livrés** : le bridge expose `collect_diagnostics`, qui renvoie un snapshot `muse-desktop.native-diagnostics.v1` avec état de workspace, hosts, sessions, sessions en cours, approbations en attente et taille du buffer d'événements. L'export Settings l'intègre quand l'application tourne dans Tauri et retombe sur les compteurs renderer en web preview.
- **M0-07e — erreurs de tour structurées livrées** : `turn/completed` conserve l'enveloppe d'erreur MSP (`kind`, `message`, `retryable`, durée et raison) au lieu de la réduire à une chaîne. Le journal persiste ce détail et `StreamView` l'affiche dans une carte calme et repliable avec **Retry turn** lorsque le host juge l'envoi réessayable ; le bouton reprend le dernier prompt utilisateur avant l'échec. Les hôtes anciens retombent sur leur raison texte, avec masquage des secrets courants.
- **Validation** : suite Rust à 76 tests sur le backend, suite Node à 497 tests avec secrets synthétiques, compteurs invalides, résumé multi-worktree, erreurs de fin de run et copie d'erreurs ; TypeScript/Vite verts.

### Livraison M0-09 — persistance récupérable

- **M0-09a — façade câblée** : les lectures/écritures de `persist.ts` et de tous les modules de persistance connus passent par une façade commune qui ne jette jamais une valeur précédente sur erreur et conserve un diagnostic borné pour stockage indisponible, JSON corrompu ou quota saturé. Les valeurs scalaires (thème et drapeaux d'index) disposent du même chemin défensif.
- **M0-09b — récupération explicite** : les réglages proposent un export local des clés `muse-desktop.*`, avec les entrées JSON valides et les valeurs endommagées conservées comme texte brut pour support. Aucun appel réseau ou moteur n'est déclenché.
- **M0-09c — couverture** : les modules historiques recensés ne lisent ou n'écrivent plus directement `localStorage`; les clés et formats `v1` restent inchangés pour permettre une reprise sans migration destructive.
- **M0-09d — restauration livrée** : Settings permet d'importer un export JSON local. Les clés hors namespace et les formats inconnus sont refusés ; un aperçu liste chaque clé, indique si elle existe déjà et sélectionne par défaut uniquement les nouvelles entrées. La restauration remplace une clé existante seulement si elle est cochée explicitement. Le rechargement réhydrate les sessions via le chemin de boot normal.
- **M0-09e — migration livrée** : Settings propose **Migrate legacy data**. Les alias historiques `muse.*` et les préfixes de logs connus sont validés comme JSON, copiés uniquement vers une clé `muse-desktop.*` absente et gardés en source pour rollback ; les valeurs corrompues restent signalées.
- **M0-09f — restauration sélective livrée** : `inspectStorageSnapshot` expose uniquement les métadonnées nécessaires à l'aperçu et `importStorageSnapshot` accepte une liste de clés confirmées, sans écraser les autres entrées. Les valeurs endommagées restent restaurables comme texte brut borné à 120 000 caractères par clé, avec un marqueur `truncated` explicite.
- **M0-09g — limite restante** : la qualification des formats externes et la reprise après interruption restent à éprouver avant de changer le format des clés.
- **Validation** : tests Node couvrent corruption, stockage absent, quota, suppression sûre, export d'une entrée endommagée, aperçu des clés existantes et restauration explicitement sélectionnée.

### Livraison M0-10 — premier lancement Windows (guidance)

- **M0-10a — interface câblée partiellement** : le panneau d'échec du sidecar transforme les indices déjà remontés par le bridge en étapes concrètes : binaire correspondant au target triple, disponibilité WSL, présence de `~/.local/bin/muse`, authentification et accessibilité du dossier. Il conserve les chemins sondés et propose toujours Réessayer / Choisir un dossier.
- **M0-10b — limite restante** : la guidance ne lance aucune installation et ne déclare pas une dépendance saine sans preuve. La détection native sur machine propre, les distributions WSL non par défaut et le parcours d'authentification réel restent à valider.
- **M0-10c — sonde native livrée** : `probe_startup` vérifie sans lancer de serveur la présence du sidecar, l'état de WSL, l'existence exécutable de `~/.local/bin/muse` dans la distribution par défaut et l'accessibilité du workspace. Chaque commande est bornée à deux secondes, les détails sont réduits à une ligne et aucun credential n'est lu. Le panneau de récupération affiche ces checks avec des états `ready`, `missing`, `blocked` ou `unknown`, et le probe est relancé après changement de dossier ou **Try again**.
- **Validation** : tests Node de classification/guidance pour binaire absent, WSL/Muse manquants, auth et message inconnu ; build frontend vert.

### Livraison M0-11 — finition anglais/navigation (première passe)

- **M0-11a — harmonisé** : les derniers libellés français résiduels ont été remplacés dans le résumé de conversation, l'import de configuration, les projets et les actions de sidebar. La ponctuation des libellés visibles suit l'anglais (`Context:`, `Actions for…`).
- **M0-11b — recherche stable** : le filtrage de conversations n'impose plus la locale française ; la casse suit la locale de l'environnement sans modifier les titres saisis par l'utilisateur.
- **M0-11c — raccourcis cohérents** : les infobulles des actions globales, de la sidebar et des réponses aux demandes utilisent `Cmd` sur les plateformes Apple et `Ctrl` ailleurs via `primaryModifier()`, sans changer les raccourcis effectivement écoutés.
- **M0-11d — copie d'erreur livrée** : les surfaces globales, fichiers, projets, paramètres, demandes d'entrée, sélecteurs de dossier, composer, revue Git, automations et orchestration transforment les préfixes protocole en messages anglais calmes, bornés et masqués (`userFacingError`). Le détail technique reste disponible après un tiret pour faciliter le support ; les messages utilisateur et moteur ne sont pas traduits.
- **M0-11e — panneaux secondaires couverts** : les erreurs de scan skills, catalogue de modèles, pièces jointes et contrôles fenêtre passent par `userFacingError`, avec gestion explicite d’un échec de scan asynchrone et sans préfixe protocole exposé.
- **M0-11f — limite restante** : la checklist native des titres et erreurs spécifiques doit encore être rejouée dans la webview empaquetée.
- **Validation** : tests de non-régression du copy audit (`test/ui-copy.test.ts`, `test/errorCopy.test.ts`) et build frontend vert.

### Livraison M0-02/M0-05 — reprise visible après décision

- **Pont d'état** : le hook de sessions conserve un marqueur éphémère par conversation lorsqu'une autorisation ou une réponse de demande d'entrée a été acceptée. Ce marqueur ne persiste pas et ne devient pas une seconde source de vérité du host.
- **UX** : le fil affiche **Muse is resuming** avec une explication calme pendant l'intervalle entre l'accusé de réception et le prochain événement MSP. Un événement `output`, `thinking`, `item_started`, `item_done`, `turn/started` ou terminal efface ce marqueur ; une nouvelle demande d'autorisation ou d'entrée reprend naturellement la priorité.
- **Détection d'attente** : après le même délai de liveness que les autres tours, l'état bascule vers **No recent host update** et conserve les actions **Reconnect** / **Stop**. L'interface ne laisse donc plus un simple `thinking…` sans contexte après un clic.
- **Perte de buffer** : le polling natif renvoie `truncated` et le plus ancien numéro disponible quand le ring de 2 000 événements a dépassé le curseur renderer. Muse relit alors les demandes en attente et l'historique plié des conversations actives avant d'appliquer la queue restante.
- **Validation** : `streamHealth` couvre la reprise courte et le passage à l'état stale ; la suite frontend et le build restent les vérifications locales. La validation native du moteur après `approval/decide` et `userInput/answer` reste à exécuter.

### Livraison M0-12 — accessibilité de navigation (première passe)

- **M0-12a — focus** : le composer de première conversation reçoit le focus initial ; les dialogues de recherche, réglages et actions d'une conversation rendent le focus à leur déclencheur à la fermeture. Le formulaire de renommage et l'annulation de suppression ont un focus initial explicite.
- **M0-12b — streaming** : les annonces restent limitées aux transitions d'état et aux demandes d'action ; les tokens du flux ne sont pas annoncés individuellement (`role=log` en `aria-live=off`).
- **M0-12c — contraste forcé** : les contrôles conservent un contour de focus `Highlight`, des bordures `ButtonText` et des liens `LinkText` lorsque Windows active `forced-colors`, sans modifier la palette normale de Muse.
- **M0-12d — limite restante** : lecteur d'écran réel, zoom 200 %, contraste et parcours complet sans souris doivent encore être vérifiés sur Windows WebView2 et les autres plateformes annoncées.
- **Validation** : suite Node et build frontend verts ; preuve assistive native encore à produire.

### Livraison M0-13 — états de capacité honnêtes (première passe)

- **M0-13a — vocabulaire commun** : `CapabilityBadge` et `capability.ts` distinguent `Available`, `Local`, `Manual` et `Not connected`, avec une raison consultable au survol. Les états restent informatifs et n'ajoutent pas de fausse confirmation.
- **M0-13b — surfaces couvertes** : connecteurs (catalogue local), channels (transport absent), exports (local uniquement), worktrees (préparation manuelle), index workspace (local) et import CLI/IDE (manuel) affichent leur niveau réel.
- **M0-13c — limite restante** : l'audit clic → effet réel des panneaux secondaires et du backend absent reste à exécuter ; aucune action d'installation ou de connexion n'est ajoutée par ce lot.
- **Validation** : tests unitaires du vocabulaire et build frontend verts.

### Livraison M0-14 — contrôles reproductibles (première passe)

- **M0-14a — CI ajoutée** : `.github/workflows/ci.yml` exécute `npm ci`, `npm test`, `npm run build` et `cargo test --manifest-path src-tauri/Cargo.toml` sur chaque push et pull request. Les jobs sont séparés, bornés en durée et annulés lorsqu'un nouveau commit remplace le précédent.
- **M0-14b — périmètre sûr** : la CI n'utilise aucun credential, ne lance pas de tour modèle et ne dépend pas d'un binaire Muse/WSL ; les tests Rust exercent le superviseur et les tests Node les contrats purs.
- **M0-14c — fixture livrée** : `scripts/msp-fixture.mjs` fournit les scénarios `success`, `interleaved`, `reject`, `timeout` et `drop`. `test/msp-fixture.test.ts` lance un vrai processus enfant, vérifie le framing `Content-Length`, les notifications `tools/list_changed`, les erreurs JSON-RPC, l'absence de réponse bornée et la fermeture stdout sans toucher à un workspace.
- **M0-14d — rapports d'échec livrés** : les jobs frontend et Rust conservent, uniquement en cas d'échec, les 250/300 dernières lignes de leurs commandes dans un artefact GitHub à rétention de 7 jours. Les chemins de runner et les formes de secrets courantes sont masqués ; aucun workspace, credential ou transcript utilisateur n'est ajouté.
- **M0-14e — limite restante** : le scénario natif A/B et la panne d'envoi avec l'interface Tauri restent à ajouter avant de déclarer M0-14 complet.
- **Validation** : `npm test` (497 tests Node, dont cinq tests fixture), build frontend et 76 tests Rust verts. La fixture s'exécute aussi dans le job Node de la CI depuis un clone propre.

### Livraison M0-06 — posture d'autorisation globale

- **M0-06a — câblé, local** : les réglages proposent trois postures persistées par Muse : **Ask for approval** (question à chaque action), **Approve on my behalf** (actions locales du workspace approuvées automatiquement, réseau et privilèges élevés conservant une question) et **YOLO** (choix non refusés approuvés automatiquement dans un workspace de confiance).
- **M0-06b — intégré** : l'approbation apparaît dans le flux de conversation sous forme de carte neutre et compacte. La commande est repliable, la portée et la règle effective restent visibles, et les règles enregistrées sont regroupées dans un panneau secondaire. Le rouge est réservé à un refus effectif.
- **M0-06c — câblé au host** : le binaire 1.3.0 accepte `allowAll`, `promptUnmatched` et `onRequest` sur `session/start`, ainsi que `session/setApprovalMode` pour les actions suivantes. Muse mappe ses trois libellés vers ces valeurs, tout en conservant l'allowlist et le garde-fou local pour les scopes réseau/élevés.
- **M0-06d — qualification restante** : valider sur une installation propre les comportements réseau/élévation et la réponse lorsque le host ne sert pas une posture demandée ; l'erreur doit rester visible sans bloquer l'historique local.

### Livraison M0-08 — compatibilité du moteur

- **M0-08a — câblé** : le handshake exige `serverInfo.name=muse`, une version serveur, `schema.version=1` et un fingerprint `sha256:*` avant d'envoyer `initialized`. Le registre compile-time recense aussi les RPC modèles, compaction, reprise et contrôles subagent réellement émises. Les champs inconnus restent acceptés pour préserver les extensions additives du protocole.
- **M0-08b — erreur exploitable** : une réponse absente ou incompatible ferme le sidecar immédiatement et remonte une phrase actionnable au bandeau d'erreur, au lieu de laisser les conversations tourner dans un état indéterminé.
- **M0-08c — preuve locale** : le binaire Windows/WSL Muse 1.3.0 a répondu avec le contrat attendu et les quatre postures d'approbation supportées ; la matrice d'anciennes versions reste à qualifier séparément.
- **Critères de sortie** : changement de posture sans redémarrage, conservation après relance, mode intermédiaire qui laisse une demande externe visible, YOLO qui suit le chemin d'approbation existant, et test natif de la décision refusée/stale.

### Livraison M0-02 — reconnexion explicite

- **M0-02a — câblé** : action Reconnect pour une conversation non rattachée ; validation de son identité, de son historique durable et de son dossier avant session/resume. Pas de création silencieuse d'une nouvelle session. Envoi indisponible tant que la reconnexion n'est pas confirmée.
- **M0-02b — validé partiellement** : un moteur réel crée la session, se ferme, puis un nouveau moteur relit/reprend le même identifiant et répond au catalogue. Aucun tour modèle envoyé. Test React/Chromium avec IPC simulé : échec visible, messages conservés, nouvel essai avec le bon dossier, action retirée après succès.
- **M0-02c — réhydratation livrée** : `read_session_history` demande `session/read` avec `excludeItems:false` après une reconnexion réussie. `history.ts` convertit les items pliés (message utilisateur, réponse, raisonnement, outil, sous-agent) dans les lanes existantes et fusionne par `itemId` en conservant les notes locales ; un host plus ancien sans historique inline laisse le transcript local intact. Reste à valider les demandes en attente réellement réémises et poursuivre un tour de bout en bout dans la webview native.
- **M0-02d — corrigé côté client** : après une décision d'autorisation, la chaîne de polling est relancée immédiatement et les nouveaux items ne restent plus bloqués sur l'indicateur réflexif. Les approbations composées conservent la carte quand le host renvoie `terminal:false`, appliquent le nouveau `currentRequirementId` et remplacent les choix sur `approval/updated`. Les items de raisonnement sont séparés du texte de réponse et peuvent être dépliés ; il reste à valider ce flux avec un moteur live qui émet un item `reasoning`.
- **M0-02e — liveness visible** : le hook conserve le dernier événement du host par session (état live, jamais persisté). Le stream distingue `Muse is working`, l'attente d'une autorisation ou d'une réponse, l'attente du host après reconnexion et l'absence d'événement depuis 15 secondes. Dans les deux derniers cas, `Reconnect` et `Stop` restent disponibles ; ce signal n'altère jamais la session et ne conclut pas artificiellement le tour. Tests purs ajoutés dans `test/streamHealth.test.ts`.
- **M0-02f — connexion explicite** : chaque conversation expose désormais son cycle `disconnected / connecting / connected / error`, séparé de `running`. Les événements du host confirment la connexion, `host_exited` la repasse à `disconnected`, et un échec de reconnexion devient `error` sans effacer le transcript. Le statut est visible dans les métadonnées de la conversation et reste borné à l'identité de session.
- Limite Windows : conversion des chemins du bridge pour les montages WSL standards `/mnt/<lecteur>/`. Un montage personnalisé non résolvable échoue explicitement ; les chemins ne sont pas devinés.

Preuves : [validation de reprise](../src-tauri/src/resume.rs), `read_session_history` dans le backend, [normalisation d'historique](../src/lib/history.ts) et `reconnectSession` dans le hook. Les tests de fusion couvrent les doublons d'items et la conservation des notes locales ; la validation native d'un tour reste à produire.

## M1 — Terminer le workflow quotidien de développement

La maquette `design/prototype` ne constitue pas une implémentation native. Les contrats d'erreur et les opérations destructives restent à concevoir même lorsqu'un écran existe.

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M1-01 | Voir les fichiers réellement modifiés | Adapté | Présente | Câblée | Unitaire | Socle livré en lecture seule ; restent les scénarios E2E webview/live, le snapshot « dernier tour » et la vérification runtime des cas hors Git/modifications externes |
| M1-02 | Commenter une ligne de diff et demander sa correction | Adapté | Présente | Câblée | Unitaire | Socle livré ; restent la qualification native avec un moteur live et la persistance/triage multi-commentaires |
| M1-03 | Indexer ou annuler une modification | Adapté | Présente | Câblée | Intégration | Stage, unstage et discard fichier/hunk, plus sélection multiple de fichiers, livrés avec garde HEAD/statut/diff ; qualification native reste à faire |
| M1-04 | Commit, push et création de PR depuis l'app | Adapté | Présente | Câblée | Intégration | Commit, push et PR GitHub CLI livrés avec destinations explicites ; restent qualification hooks/auth live, PR existante/rejet distant et revue native |
| M1-05 | Ouvrir et utiliser un terminal du projet | Adapté | Présente | Câblée | Unitaire | Socle PTY persistant livré : shell lié au cwd de la conversation, entrée/sortie bornées, resize, fermeture contrôlée, rendu ANSI courant/avancé et raccourcis Ctrl+C/Ctrl+D/Ctrl+L/Tab/Échap. Reste : validation native Windows/macOS/Linux |
| M1-06 | Faire lire au moteur la sortie du terminal | Adapté | Présente | Locale | Unitaire | Handoff explicite **Add output to prompt** livré : sortie bornée, attribuée au terminal/cwd et insérée dans le prochain message. Reste : outil/contexte moteur natif après vérification de capacité MSP |
| M1-07 | Consulter les vrais fichiers du projet | Adapté | Présente | Câblée | Intégration | Listing paresseux, lecture bornée, rafraîchissement périodique, watcher natif et handoff explicite du fichier texte vers le prompt livrés ; restent qualification E2E sur gros dépôts et formats riches |
| M1-08 | Ajouter fichiers et images à une demande | Adapté | Présente | Câblée | Intégration | Texte borné et images base64 sont envoyés comme parts MSP réelles ; dimensions détectées et aperçu miniature livrés ; brouillons restaurés en session avec re-sélection guidée si le payload est trop volumineux ; reste la validation live sur les modèles image |
| M1-09 | Créer une branche de conversation fidèle | Adapté | Présente | Câblée | Intégration | Fork serveur depuis le dernier tour terminé livré ; **Fork from here** transmet maintenant une ancre MSP `lastTurnId` précise ; restent qualification du point invalide et reprise live |
| M1-10 | Réorienter une exécution ou mettre un message en attente | Adapté | Présente | Câblée | Unitaire | Queue MSP par défaut et disposition `queued`/`steered` visibles ; les tours admis en queue restent listés, leur ordre est persisté et peut être retiré avant lancement via `turn/unqueue`. Après relance, un `history.snapshot.queuedTurns` réellement servi par le host réconcilie la file ; sans snapshot, les rappels restent marqués à vérifier et ne sont jamais rejoués automatiquement ; qualification live restante |
| M1-11 | Choisir un modèle disponible et suivre le contexte | Adapté | Présente | Câblée | Unitaire | Catalogue live, changement `session/setModel`, compaction et occupation sont câblés ; les compteurs `session/tokenUsage` sont maintenant affichés quand fournis par le host ; fallback explicitement non live ; qualification E2E du modèle effectif reste à faire |
| M1-12 | Retrouver et organiser les conversations | Adapté | Présente | Câblée | Unitaire | Recherche, épinglage, ordre manuel et indicateurs non lus persistants livrés ; la virtualisation des listes reste conditionnée aux mesures de performance |
| M1-13 | Lire une longue conversation confortablement | Adapté | Présente | Partielle | UI | Fenêtre DOM bornée au-delà de 600 entrées (160 visibles, chargement de 120 anciens), scroll compensé, restauration de position et recherche complète avec saut vers un résultat hors fenêtre livrés ; restent mesure native à 2 000 entrées et qualification assistive |

Preuves : [maquette](../design/prototype/), [contenus actuels](../src/components/ArtifactsPane.tsx), [messages](../src/components/MessageContent.tsx), [mentions](../src/lib/mentions.ts), [shell applicatif](../src/App.tsx).

### Livraison M1-01 — revue Git en lecture seule

- **Contrat backend :** `git_status(sessionId)` et `git_diff(sessionId, scope, baseRef?)` résolvent le workspace de la conversation, exécutent Git hors thread UI et renvoient une erreur explicite pour un dossier hors dépôt. Les sorties de statut utilisent les séparateurs NUL afin de préserver espaces, Unicode et paires de renommage.
- **État exposé :** branche, HEAD observé, upstream, avance/retard et liste des fichiers avec états index/worktree, conflits, non suivis et renommages. Les diffs sont disponibles pour `unstaged`, `staged` et `branch` avec base explicite ; les hunks, compteurs, marqueurs binaires et patch borné sont conservés.
- **UI :** l’onglet **Review** est accessible depuis la barre de travail de chaque conversation. Il recharge le dépôt, sélectionne un scope, accepte une base de branche et affiche la liste des fichiers puis le patch réel, sans déduire les changements du texte de Muse.
- **Validation :** suite Node 381 tests, suite Rust 44 tests, build frontend réussi. Les tests Rust couvrent notamment Unicode, chemins avec espaces, renommage, avance/retard, hunks, binaire, base absente et garde contre une référence de branche interprétée comme option.
- **Limites assumées :** cette tranche ne modifie pas le dépôt. Le stage/revert (M1-03), commit/push/PR (M1-04), ainsi que la qualification native avec un vrai workspace, restent les étapes suivantes.

### Livraison M1-02 — commentaires ancrés sur un diff

- **Ancre :** chaque ligne sélectionnable conserve le dépôt, la révision HEAD observée, le scope et la base, le chemin (et l’ancien chemin en cas de renommage), le côté old/new, le numéro de ligne et l’en-tête du hunk.
- **UX :** l’utilisateur sélectionne une ligne dans le diff, rédige un commentaire puis l’envoie dans la conversation. Le texte transmis contient un bloc de contexte explicite afin que Muse puisse corriger la bonne ligne sans dépendre d’un copier-coller implicite.
- **Garde de fraîcheur :** avant l’envoi, Muse relit le statut puis le diff exacts. Si HEAD, le fichier, le hunk, le côté ou la ligne ont bougé, le commentaire est refusé avec une invitation à resélectionner ; aucune ancre n’est déplacée silencieusement.
- **Validation :** suite Node 384 tests, dont les coordonnées old/new, le format de contexte et le rejet d’une ancre périmée ; build TypeScript/Vite réussi.
- **Limites assumées :** les commentaires sont envoyés comme contexte d’un tour et ne forment pas encore une boîte de triage persistante. La qualification native avec un vrai moteur et les actions de modification du dépôt restent M1-03/M1-04.

### Livraison M1-03 — stage, unstage et discard protégés

- **Contrat backend :** `git_stage(sessionId, paths, expectedHead, expectedStatus, expectedPatch)` et `git_restore(sessionId, paths, scope, ...)` résolvent le workspace sessionné, valident les chemins relatifs et exécutent Git hors thread UI.
- **Actions hunk :** `git_apply_hunk` extrait le hunk demandé depuis le diff observé et applique Stage, Unstage ou Discard partiel selon le scope ; les fichiers binaires, non suivis et les patches tronqués restent exclus.
- **Sélection multiple :** les fichiers cochés peuvent être traités en une seule action Stage, Unstage ou Discard ; les non suivis restent visibles mais ne sont jamais supprimés.
- **Garde de concurrence :** l’empreinte du statut inclut les sorties staged/unstaged et le patch présenté. HEAD, statut ou patch divergents refusent l’action avant toute écriture ; l’état courant est renvoyé après succès.
- **UX :** la sélection d’un fichier expose Stage file, Unstage file et Discard changes avec confirmation dédiée. Le discard ne supprime jamais un fichier non suivi ; celui-ci est signalé comme nécessitant une suppression explicite dans le projet.
- **Validation :** tests Rust d’intégration sur un dépôt temporaire pour stage → unstage → discard fichier/hunk, rejet d’une observation périmée et validation des chemins ; suite complète 72 tests Rust, 447 tests Node, TypeScript/Vite build réussi.
- **Limites assumées :** la qualification native avec un vrai workspace reste à faire ; commit/push/PR sont couverts par M1-04.

### Livraison M1-04 — commit, push et pull request explicites

- **Commit :** `git_commit` travaille sur l’index réel, exige un message et l’observation HEAD/statut/diff, renvoie le hash, la branche et le sujet. Les index vides et les hooks échoués remontent leur erreur Git.
- **Push :** `git_push` exige un remote et une branche saisis par l’utilisateur, vérifie HEAD puis pousse `HEAD:refs/heads/<branch>`. Aucun upstream implicite ni redirection vers la branche courante n’est utilisé.
- **Pull request :** `git_create_pr` utilise le `gh` déjà authentifié sur la machine, sans stocker de credential dans le webview. Base, head, titre et description sont explicites ; l’URL retournée est vérifiée et aucun merge automatique n’est déclenché. Décision détaillée dans [ADR 0001](adr/0001-github-cli-for-pull-requests.md).
- **UX :** la section **Ship changes** du panneau Review regroupe commit, remote/branche de push et création de PR. Les résultats affichent le hash, la destination et le lien de PR ; les erreurs restent dans le même contexte de revue.
- **Validation :** tests Rust sur dépôt temporaire pour commit, garde d’empreinte et remote absent ; tests de sécurité sur refs ; suite 51 Rust, 384 Node, TypeScript/Vite build réussi.
- **Limites assumées :** la qualification avec hooks/auth/rejet réseau, la détection d’une PR existante et les scénarios live GitHub restent à exécuter avec un compte de test ; aucun credential n’est requis pour la CI.

### Livraison M1-05 — terminal PTY persistant

- **Contrat backend :** `terminal_open(sessionId, cols?, rows?)`, `terminal_write(terminalId, input)`, `terminal_resize(terminalId, cols, rows)`, `terminal_read(terminalId)` et `terminal_close(terminalId)` sont exposés par un registre Rust sessionné. Le shell est lancé dans le workspace propre à la conversation, avec un `terminalId` et une génération explicites.
- **Durabilité de vue :** le processus PTY est détenu par le superviseur, pas par le composant React. Changer d’onglet ou fermer le panneau ne tue donc pas un serveur long ; seul Close termine explicitement le child process. La fermeture de l’application vide le registre et tue tous les shells.
- **Sortie bornée :** le lecteur conserve au plus 200 000 caractères et `terminal_read` draine uniquement les nouveaux octets. Une sortie terminée est signalée par `done`, sans faire grossir l’état ou le localStorage de l’app.
- **UX :** l’onglet **Terminal** apparaît dans la barre de travail. Il présente le cwd/shell, une sortie monospace, une commande à envoyer, l’état de fin et un contrôle de largeur ; le panneau reprend automatiquement le terminal de la conversation à sa réouverture. Les contrôles Ctrl+C (interrompre), Ctrl+D (EOF), Ctrl+L (effacer), Tab (compléter) et Échap sont transmis au PTY avec une aide accessible dans le champ de commande.
- **Rendu :** les séquences ANSI SGR usuelles et avancées (couleurs 16/256/24 bits, gras, atténué, italique, souligné, barré, inversion) sont converties en spans stylés sûrs ; les séquences de curseur/titre inconnues sont retirées de la vue sans être interprétées comme HTML.
- **Validation :** `cargo test --bin muse-desktop` (53 tests, dont bornage de taille et de sortie), `npm test`, `npx tsc --noEmit` et build Vite. La validation native interactive et le rendu clipboard restent des critères séparés.
- **Limites assumées :** cette tranche ne transmet pas encore la sortie au moteur comme contexte (M1-06), ne remplace pas encore le rendu brut par xterm, et ne prétend pas couvrir les shells non présents sur la machine.

### Livraison M1-06 — sortie terminal vers le prompt

- **Handoff explicite :** le bouton **Add output to prompt** ajoute au brouillon un bloc `<terminal-output>` borné à 12 000 caractères, précédé du shell, cwd et `terminalId`. La sortie est traitée comme donnée de terminal identifiable ; aucune exécution ou envoi implicite n’est déclenché.
- **SSOT :** le hook de sessions reste la source de vérité du terminal et du brouillon. Le panneau ne copie pas directement le DOM et ne peut pas insérer la sortie d’une autre conversation.
- **Validation :** deux tests Node couvrent l’attribution, l’échappement des métadonnées et le bornage ; suite complète et build restent verts.
- **Limite assumée :** Muse ne sert pas encore de capability d'outil terminal/context snapshot vérifiée. L’adaptateur MSP automatique reste bloqué jusqu’à la preuve de ce contrat ; l’insertion explicite fournit un parcours honnête entre-temps.

### Livraison M1-07 — fichiers réels du workspace

- **Contrat backend :** `files_list(sessionId, relativePath?, limit?)`, `file_read(sessionId, path, maxChars?)` et `file_open(sessionId, path)` résolvent le workspace de la conversation, refusent les chemins absolus/traversal et les symlinks qui sortent de la racine, puis exécutent les opérations hors thread UI.
- **Bornage et fraîcheur :** le listing est limité à 500 entrées (200 par défaut) et la lecture à 512 Ko/120 000 caractères. Les fichiers binaires sont identifiés sans décodage forcé ; les images et PDF reconnus sous 5 MiB reçoivent un payload base64 borné ; chaque réponse porte `observedAt`, et un rafraîchissement explicite remplace le snapshot précédent.
- **UX :** l’onglet **Files** affiche le chemin courant, remonte d’un niveau, recharge le dossier et ouvre les répertoires à la demande. Un fichier texte, une image ou un PDF est prévisualisé depuis le disque et propose **Open in app** pour le handler système par défaut ; les fichiers binaires, symlinks inaccessibles et résultats tronqués sont signalés dans le panneau.
- **SSOT :** l’état `filesBySession` appartient au hook de sessions ; les réponses asynchrones obsolètes sont ignorées par séquence de requête, afin qu’un changement d’onglet ou de conversation ne remplace pas un aperçu plus récent.
- **Fraîcheur de vue :** tant que l'onglet Files reste ouvert, un watcher natif par workspace signale les chemins modifiés via le buffer d'événements borné. La vue affiche un état obsolète et les trois premiers chemins touchés ; **Refresh** recharge explicitement le snapshot, tandis que le timer reste un filet de sécurité.
- **Contexte explicite :** l'aperçu texte expose **Add to prompt**. Le hook de sessions ajoute un bloc borné avec chemin, taille et horodatage d'observation au pré-remplissage existant ; les images, PDF et binaires ne sont jamais convertis en faux texte.
- **Limites assumées :** l’ouverture est un geste explicite vers le handler système par défaut ; Muse ne lance aucune commande avec le contenu du fichier et le watcher ne lit aucun contenu. Les événements sont indicatifs jusqu'au Refresh et la qualification native Windows/macOS/Linux, les renommages, les racines supprimées et les formats riches restent ouverts. Les pièces jointes restent M1-08.
- **Validation :** tests Rust du service sur un workspace temporaire (listing borné, texte, binaire, traversée, chemins absolus et résolution d’ouverture), tests Node de handoff borné, puis suite TypeScript/Vite. La qualification native Windows/macOS/Linux et le scénario E2E avec fichiers renommés/disparus restent à exécuter.

### Livraison M1-08 — pièces jointes structurées

- **Contrat moteur vérifié :** le binaire Muse embarqué a été interrogé avec `muse schema generate-ts --out …`. `turn/start.input` accepte les parts `text`, `image` (`mediaType`, `base64Data`, dimensions optionnelles) et `skill`; il n’existe pas de part fichier arbitraire.
- **UX :** le composeur accepte plusieurs images ou fichiers texte par sélecteur, glisser-déposer et collage d’image. Les pièces jointes apparaissent en chips supprimables avant envoi, avec limites et erreurs dans le contexte du champ ; les images affichent une miniature et leurs dimensions détectées quand le navigateur les expose.
- **Payload :** les textes sont transmis comme parts `text` explicitement balisées avec leur nom/MIME ; les images gardent leur MIME, leur payload base64 et leurs dimensions optionnelles. Les chemins locaux ne sont jamais envoyés comme faux fichiers.
- **Fiabilité :** `turn/start` valide côté Rust le type, le MIME, le base64, les dimensions et les bornes (8 parts, texte 120 000 caractères, image 5 Mo). L’outbox persiste les parts exactes afin qu’un retry ambigu ne perde ni image ni fichier. Le composeur conserve aussi un brouillon d’attachements borné en `sessionStorage` ; les petites pièces sont réutilisables après rechargement, les payloads trop grands gardent leurs métadonnées et exigent **Reselect** avant l’envoi.
- **Validation :** tests Rust (dont validation des parts), 505 tests Node (détection/assemblage et outbox), TypeScript et build Vite. La réception avec chaque modèle image et la qualification native restent à exécuter.
- **Limites assumées :** les formats non textuels autres que les images sont refusés explicitement ; les pièces jointes restent limitées à la session de la webview et les gros payloads doivent être re-sélectionnés après rechargement ; aucun upload externe n’est introduit.

### Livraison M1-09 — branche de conversation serveur

- **Contrat moteur :** `session/fork` a été vérifié dans le schéma stable du binaire Windows. Le fork prend la session source et, par défaut, copie tous les tours terminés ; `excludeItems: true` évite de transférer un historique volumineux dans la réponse de commande.
- **Backend :** `fork_session` conserve le workspace et le client MSP de la source, vérifie que le serveur renvoie un nouvel identifiant, puis enregistre ce `sessionId` dans le routage et les métadonnées Rust.
- **UX :** une action **Fork conversation** est disponible dans l’en-tête de la conversation. Elle crée une conversation nommée `Branch of …`, sélectionne immédiatement la branche et recopie uniquement les entrées locales terminées ; les brouillons et items ouverts ne sont pas partagés.
- **SSOT :** l’identité et la provenance durables restent celles du serveur ; le journal local sert uniquement à rendre la continuité visible avant le prochain événement MSP.
- **Validation :** le contrat est câblé et compilé avec les suites Rust/Node/TypeScript/Vite de la branche. Restent un essai live avec une session active, les erreurs `forkBoundaryInvalid` et le choix d’une ancre `lastTurnId` précise.
- **Ancre précise :** les items issus de `session/read` et les items live conservent leur `turnId`. Chaque message utilisateur ou assistant terminé expose discrètement **Fork from here** ; l’action appelle le même fork sessionné avec `cutPoint.lastTurnId`, tandis que le bouton d’en-tête conserve le raccourci « dernier tour terminé ». Un identifiant vide est omis afin de préserver le comportement par défaut du serveur.
- **Validation complémentaire :** les paramètres MSP sont testés pour une ancre non vide et pour l’omission d’une ancre vide. La qualification native d’un point inconnu, d’un tour en cours et d’une reprise après rechargement reste ouverte.

### Livraison M1-10 — admission queue rendue visible

- **Contrat moteur :** le schéma stable définit `turn/start.ifBusy` avec `queue` comme comportement par défaut et renvoie une disposition d’admission `started`, `queued` ou `steered`.
- **UX :** après l’accusé de réception, Muse ajoute une information discrète dans la conversation lorsque la demande est mise en file ou absorbée par le tour courant ; l’utilisateur ne voit plus un simple état `Thinking` sans explication.
- **Transport :** les notifications `turn/started` conservent maintenant `turnId` et `commandId` dans leur payload relayé, afin que le futur pilotage puisse cibler le bon tour sans course.
- **M1-10a — livré** : l'accusé `queued` conserve `turnId`, le fil affiche les messages en attente dans l'ordre et l'action **Remove from queue** appelle `turn/unqueue`. L'événement `turn/started` ou `turn/unqueued` retire la carte ; un échec d'admission laisse la file visible. La queue reste en mémoire de session et n'est pas rejouée après relance tant que le host ne fournit pas de snapshot de queue.
- **M1-10b — ordre durable livré** : les admissions `queued` sont écrites sous `muse-desktop.queued-turns.v1`. Au redémarrage, elles réapparaissent comme rappels locaux **Saved before restart — verify the host queue** ; l'utilisateur peut les écarter localement, et aucun tour n'est renvoyé au host sans confirmation de son snapshot.
- **Reste :** snapshot de queue MSP et qualification live du reclaim après course lancement/retrait.
- **Snapshot host :** lorsque `session/read` sert un `history.snapshot`, le backend expose ses `queuedTurns` et le hook remplace la file locale par cette observation. Les textes connus restent ceux du journal local ; un tour nouveau est affiché avec son identifiant et une demande de vérification, sans inventer ni rejouer son prompt. Une réponse inline, `null` ou une erreur conserve les rappels locaux.
- **Validation complémentaire :** le parseur de réconciliation déduplique les identifiants, retire les tours absents d’un snapshot vide et couvre le cas où aucun snapshot n’est servi.

### Livraison M1-11 — catalogue, modèle et compteurs d'usage

- **Catalogue effectif :** `model/list` reste la source de vérité du sélecteur, et `session/setModel` est appliqué à la session ciblée ; l’absence de host conserve un fallback explicitement marqué comme non live.
- **Compaction :** `session/compact` reste un geste utilisateur séparé du résumé local. Les réponses `accepted` et `noop` sont distinguées, tandis que les erreurs `missing_run` et `run_active` restent explicables.
- **Usage host :** `session/contextUsage` et `session/tokenUsage` sont relayés par le superviseur. La barre affiche l’occupation et, lorsque fourni, le compteur de tokens du tour ; les totaux sont ceux du host et ne sont jamais recalculés par Muse.
- **Validation :** le parseur de compteurs couvre les formes cumulées et par tour, les valeurs invalides et les identifiants de tour ; TypeScript, Vite et Cargo restent verts. La confirmation native du modèle effectif après changement reste ouverte.

### Livraison M1-12 — recherche et épinglage des conversations

- **Recherche :** la boîte `Search conversations` parcourt désormais titre, dossier et texte des journaux locaux, avec un extrait de la première correspondance et la navigation clavier conservée.
- **Organisation :** une conversation peut être épinglée depuis son menu. Le drapeau est validé, persisté dans `muse-desktop.sessions.v1` et remonte avant les conversations en cours puis les plus récentes.
- **Limites :** les conversations courtes restent entièrement rendues ; les très longues listes utilisent la fenêtre bornée décrite dans M1-13.

### Livraison M1-12 — ordre et lecture non lus

- **Ordre :** les actions **Move up** et **Move down** de la conversation réordonnent uniquement le même niveau épinglé/en cours, puis attribuent des rangs persistants. Les conversations en cours et épinglées gardent leur priorité produit.
- **Lecture :** une sortie reçue dans une autre conversation marque celle-ci **new** ; l’ouverture de la conversation efface l’indicateur via `setActive`, sans toucher aux messages ni aux compteurs d’autorisation.
- **SSOT :** `StoredSession` porte `unread` et `sortOrder`, le hook persiste les changements et la sidebar ne conserve aucun ordre local.
- **Validation :** tri par rang, déplacement, marqueur non lu et restauration sont couverts par les tests Node ; TypeScript et build Vite restent verts.
- **Limites :** la virtualisation de la sidebar reste conditionnée à une mesure réelle de mémoire et de temps de rendu ; le transcript dispose déjà d’une fenêtre bornée.

### Livraison M1-13 — rendu de longues conversations

- **Rendu :** jusqu’à 600 entrées, chaque message conserve son nœud et ses attributs d’accessibilité ; au-delà, le DOM affiche une fenêtre de 160 messages avec 120 messages chargés à la demande. `content-visibility: auto` et `contain-intrinsic-size` réduisent encore le coût des lignes présentes. Cette optimisation fonctionne aussi pour les blocs Thinking repliables, les outils et les sous-agents.
- **Scroll :** les mises à jour de streaming utilisent un alignement instantané au dernier message ; les animations de scroll ne s'empilent plus à chaque delta et le bouton **Latest messages** reste explicite lorsque l’utilisateur lit plus haut.
- **Fenêtre :** **Load older messages** et le scroll en haut préchargent une page tout en compensant la hauteur précédente pour éviter un saut. Le retour au bas recale la fenêtre sur les messages récents ; la position et l’index de fenêtre restent séparés par conversation pendant la session.
- **Position de lecture :** chaque conversation conserve le dernier `scrollTop` observé en mémoire de vue et le restaure au retour dans le fil ; un nouveau fil reste positionné sur ses derniers messages.
- **Observabilité :** le journal porte `data-entry-count` afin de mesurer en UI native la taille complète de session, et `aria-label="Conversation messages"` garde une cible stable pour les essais assistifs. Les helpers de fenêtre sont purs et couverts par tests.
- **Recherche complète :** **Find in conversation** (bouton ou `Ctrl/Cmd+F`) parcourt le journal durable complet, affiche des extraits bornés et replace la fenêtre sur le résultat choisi, y compris lorsqu'il était hors DOM. Le saut signale brièvement le message ciblé sans modifier la position conservée du fil après navigation. Les flèches changent la sélection, Entrée ouvre le résultat et l'état actif est annoncé par `listbox/option`.
- **Limites :** la recherche native du navigateur et la sélection multi-page ne portent que sur la fenêtre DOM chargée. Le finder Muse reste local et textuel ; une virtualisation à hauteur mesurée pourra remplacer cette pagination si les mesures natives l'exigent.
- **Validation :** le cycle clavier du finder est couvert par un helper pur ; TypeScript, build Vite et suite Node complets restent verts. La mesure native et la qualification lecteur d’écran sont encore à produire.

### Livraison M2-01 — racines de projet

- **Modèle :** un projet peut maintenant conserver une racine de travail optionnelle. Les valeurs sont nettoyées à l’écriture, validées à la restauration et restent compatibles avec les groupes créés avant cette évolution.
- **UX :** le panneau **Projects** permet de choisir, remplacer ou retirer un dossier. Chaque projet expose **New conversation here** quand une racine est définie ; l’action démarre réellement la session dans ce dossier puis rattache la conversation au projet.
- **SSOT :** le hook de sessions reste l’unique point de création des sessions. Le chemin choisi est passé au même contrat `start_session` que le workspace global ; il n’existe pas de second état local pour la conversation.
- **Validation :** tests de création, mise à jour, suppression et persistance d’une racine ; TypeScript, build Vite et 57 tests Rust sont verts.
- **Limites :** les anciens projets restent sans racine tant que l’utilisateur ne la choisit pas, et la migration automatique de groupes ambigus est volontairement exclue. La sélection d’environnement/worktree et les règles héritées du moteur restent M2-02/M2-03.

### Livraison M2-02 — paramètres projet effectifs

- **Héritage :** la valeur globale sert de défaut et les overrides du projet restent calculés par `settingsFor`, avec la source visible dans le diff (`g:`) et le contexte de la conversation.
- **Modèle :** lors de la création d’une session, Muse transmet le modèle global ou projet effectif via `session/setModel` après l’admission `session/start`. La valeur `default` laisse le choix natif du moteur intact.
- **Limites explicites :** le contrat MSP vérifié n’expose pas encore de mutation sessionnelle pour sandbox, réseau ou auto-compact. L’UI les affiche comme préférences effectives sans prétendre les appliquer au moteur ; leur branchement attend une capacité prouvée et testée.
- **Validation :** les tests de résolution/diff/persistance des overrides, TypeScript, build Vite et 57 tests Rust restent verts.

### Livraison M2-03 — création de worktrees Git

- **Contrat backend :** `git_worktree_create(sessionId, branch, relativePath, baseRef)` résout le dépôt de la conversation, exige une branche et une base explicites, et n’accepte qu’un chemin relatif sous `.muse/worktrees/`.
- **Git réel :** la création utilise `git worktree add -b … … …` hors thread UI. Les chemins existants, références de type option, traversées et échecs Git sont refusés avant toute promesse ; le résultat renvoie dépôt, chemin canonique, branche, base et horodatage.
- **UX :** le panneau d'orchestration conserve le plan manuel et propose **Create & open** par agent. Cette action crée le worktree et ouvre la conversation dans la même opération gardée ; en cas d'échec d'admission, le backend tente de retirer le checkout et n'affiche pas de lane partielle. **Create worktree** et **Open conversation** restent disponibles séparément pour les parcours avancés. Une suppression exige une confirmation explicite, tandis que le snippet reste disponible pour les environnements sans backend.
- **Sécurité :** les identifiants d’agents sont transformés en segments de chemin sûrs et dédoublonnés avant affichage ou appel natif.
- **Limites :** le rollback est borné à la création du checkout et à l'admission de la nouvelle session ; une panne après admission et les erreurs Git externes restent à qualifier sur chaque plateforme. Le host MSP mono-workspace empêche toujours de basculer automatiquement une conversation existante sans contrat supplémentaire.
- **Validation :** 73 tests Rust couvrent checkout réel, refs, chemins et l'admission atomique du parcours ; la persistance locale est couverte par le test de bornage des records, et les 450 tests Node, TypeScript et Vite restent verts.

### Livraison M2-04 — préparation explicite de l'environnement

- **Profils :** un profil nommé peut enregistrer la commande dans `muse-desktop.worktree-setup-profiles.v1`, isolé par workspace. Le sélecteur ne fait que recopier la commande ; l'exécution reste une action explicite dans le worktree choisi.

- **Commande utilisateur :** le panneau d'orchestration accepte une commande de setup saisie par l'utilisateur, puis l'exécute uniquement après clic sur **Run setup** dans le worktree Git déjà créé. Aucun script importé ou profil de projet n'est lancé automatiquement.
- **États :** chaque exécution renvoie `ready`, `failed`, `timedOut` ou `cancelled`, avec code de sortie, durée et sortie bornée affichable derrière une disclosure. Une relance est possible après un échec, timeout ou annulation.
- **Annulation :** chaque setup possède un identifiant d'opération côté superviseur ; **Cancel setup** demande l'arrêt ciblé du processus et le résultat revient `cancelled` après terminaison du worker.
- **Garde-fous :** la commande est limitée à 2 000 caractères ; le runner Rust refuse les dossiers inexistants ou hors de `.muse/worktrees`, neutralise stdin et tue les processus dépassant dix minutes ; la sortie est bornée à 200 000 caractères.
- **Readiness :** **Check readiness** inspecte le worktree sans exécuter de code, détecte les manifests `package.json`, `Cargo.toml`, `pyproject.toml` et `go.mod`, puis vérifie les exécutables requis sur `PATH`. L'état est `ready`, `missing tool` ou `needs setup` et reste associé à chaque branche.
- **Environnement :** le runner efface l'environnement hérité et conserve uniquement les variables de plateforme nécessaires (`PATH`, `PATHEXT`, `SystemRoot`, `ComSpec`, dossiers temporaires, domicile, locale/terminal) plus les noms explicitement ajoutés dans le profil. Les valeurs ne sont jamais saisies ni persistées par Muse.
- **Limites :** la qualification native de la création atomique et le setup restent à éprouver sur chaque plateforme. Le setup reste une action explicite et locale.
- **Validation :** tests Rust des chemins, commandes réussies/échouées et bornes ; tests Node de validation de commande ; TypeScript, Vite et Cargo doivent rester verts avant livraison.

### Livraison M2-05 — plan de handoff Local ↔ Worktree

- **Préconditions :** **Prepare handoff** produit un plan local en lecture seule à partir du statut Git observé. Il expose le workspace source, le worktree cible, les conflits, les changements non commités, l’état de la cible et la disponibilité de la branche.
- **UX :** les contrôles sont intégrés à chaque worktree créé. Les checks sont signalés `pass`, `warn` ou `blocked`, puis les étapes proposées restent visibles dans une disclosure ; aucune bascule ne se déclenche implicitement.
- **Sécurité :** une cible absente, sale ou déjà utilisée et tout conflit source bloquent le plan. Un statut non rafraîchi ou des changements source deviennent des avertissements explicites demandant une nouvelle observation ou un snapshot.
- **Limites :** le transfert effectif (arrêt/reprise atomique du host, déplacement du contexte et rollback sur conflit) reste bloqué par l’absence de contrat MSP multi-workspace ; ce lot livre le plan et les préconditions pour éviter les changements silencieux.
- **Validation :** tests purs des scénarios propre, sale, conflit, cible absente et branche utilisée ; TypeScript et Vite restent verts.

### Livraison M2-06 — inspection et nettoyage sûr des worktrees

- **Inspection :** **Inspect** lit le statut Git réel du worktree géré et affiche branche, nombre de fichiers modifiés, conflits et date d'observation dans l'orchestration.
- **Nettoyage :** la suppression passe par le même confinement `.muse/worktrees/`, refuse désormais tout checkout avec changements non commités et ne supprime que les worktrees propres après confirmation explicite.
- **Rétention :** archiver une conversation reste indépendant de la suppression du checkout ; un record persistant peut rester visible pour inspection tant que le chemin existe. L'état Git est toujours relu avant une action destructive.
- **Rétention :** une politique durable par dépôt permet de conserver indéfiniment un checkout ou de le marquer éligible après 7, 14, 30 ou 90 jours. L'éligibilité est calculée uniquement après une inspection Git propre ; aucune suppression implicite n'est déclenchée.
- **Aperçu multi-cibles :** **Inspect all** relit en parallèle tous les worktrees créés et affiche un compte-rendu borné (inspectés, propres, avec changements, en conflit). Les résultats individuels restent dépliables pour conserver le détail par branche.
- **Limites :** l'inspection détecte les marqueurs Git d'opération et les branches référencées par un autre checkout, mais ne peut pas connaître tous les processus externes. Une intention de nettoyage persistante permet maintenant une nouvelle tentative explicite après interruption ou redémarrage ; Git garde la décision finale si un checkout est verrouillé.
- **Validation :** 73 tests Rust couvrent l'inspection d'un worktree sale, les marqueurs d'activité et le refus de suppression, avec nettoyage possible après retour à un état propre ; 456 tests Node couvrent le résumé multi-cibles et la reprise des intentions, puis TypeScript et Vite restent verts.

**Dépendances :** M1-01 → M1-02/03/04 ; M0-01 → M1-05/06/09/10 ; capacités moteur à vérifier avant M1-08/09/10. **Sortie M1 :** réaliser, inspecter, corriger, tester et livrer une modification de dépôt depuis Muse, avec un chemin de récupération en cas d'erreur.

## M2 — Projets et travail parallèle isolé

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M2-01 | Un projet représente des dossiers persistants | Adapté | Présente | Câblée | Intégration | Racine persistante, sélection de dossier et création de conversation dans cette racine livrées ; restent migration explicite des anciens groupes et environnement/worktree |
| M2-02 | Les paramètres projet s'appliquent réellement | Adapté | Présente | Partielle | Intégration | Héritage global/projet visible et modèle effectif appliqué à la création d'une session ; sandbox/réseau/auto-compact restent en attente d'un contrat moteur vérifié |
| M2-03 | Créer automatiquement un worktree pour une conversation | Adapté | Présente | Câblée | Intégration | Création Git, persistance, suppression confirmée, ouverture explicite et action atomique **Create & open** avec rollback d'admission livrées ; restent qualification native et pannes après admission |
| M2-04 | Préparer l'environnement du worktree | Adapté | Présente | Partielle | Intégration | Commande explicite, profils persistants par workspace, annulation native ciblée, états et sortie bornée livrés ; readiness locale et allowlist d'environnement livrées ; reste la qualification native |
| M2-05 | Passer de Local à Worktree et inversement | Adapté | Présente | Partielle | Intégration | Plan de handoff et préconditions livrés ; restent transfert atomique du host, déplacement de contexte, conflits fichiers ignorés et rollback |
| M2-06 | Nettoyer les worktrees sans supprimer du travail | Adapté | Présente | Partielle | Intégration | Inspection Git, garde contre les marqueurs d'activité et branches référencées, refus des worktrees sales, aperçu multi-cibles, politique de rétention guidée et reprise persistante après interruption livrés ; reste la qualification des processus externes |
| M2-07 | Piloter les sous-agents réels | Adapté | Présente | Câblée | Unitaire | Vérifier followup/stop/resume/result/drilldown sur agents vivants ; identité et états corrects jusqu'à terminaison |
| M2-08 | Exécuter plusieurs writers sans collision | Adapté | Présente | Partielle | Unitaire | Pré-vol des fichiers cibles, détection des recouvrements, lanes bornées et file FIFO livrés ; reste le dispatch writer natif, l'annulation et la collecte de résultats |

Preuves : [projets](../src/lib/projects.ts), [plan worktree manuel](../src/lib/worktrees.ts), [orchestration](../src/components/OrchestrationPanel.tsx), [fan-out](../src/lib/fanout.ts).

**Dépendances :** M0-01/02 et M1-01 avant M2-03 ; M2-03 avant M2-04/05/06/08. **Sortie M2 :** deux conversations modifient/testent des espaces indépendants ; redémarrage, transfert et nettoyage préservent les changements.

### Livraison M2-08 — coordination des writers

- **Pré-vol :** le panneau d'orchestration permet de déclarer les fichiers relatifs qu'un writer peut modifier. Les chemins sont normalisés, bornés et les traversées ou chemins absolus sont ignorés avec un signal lisible.
- **Collision :** deux writers qui ciblent le même fichier ou un sous-dossier commun sont bloqués ensemble avant exécution. Un writer sans worktree ou sans liste de cibles reste respectivement bloqué ou en attente de précision ; aucun overwrite implicite n'est autorisé.
- **File :** les writers prêts reçoivent une lane déterministe dans la limite `cores - 2` bornée à 4–8 ; les suivants apparaissent en file FIFO. Le calcul est pur dans `src/lib/writerQueue.ts` et conserve le même ordre que le fan-out.
- **Limites :** le protocole MSP actuel ne fournit pas de commande de lancement, d'annulation ou de verrou de fichiers pour des writers réels. Cette tranche livre le garde-fou et l'UX de préparation ; elle ne simule pas une exécution ni une fusion de changements.
- **Validation :** 454 tests Node couvrent normalisation, bornage, collisions, worktree manquant et file FIFO ; TypeScript et Vite restent verts.

### Livraison M3-01 — transport MCP local explicite

- **Transport réel :** `mcp_local_probe` démarre la commande locale choisie par l'utilisateur, effectue `initialize` puis `notifications/initialized` et appelle `tools/list` sur stdio MCP avec support des frames `Content-Length` et JSON par ligne.
- **Appel réel :** `mcp_local_call` refait le handshake, appelle `tools/call` avec des arguments JSON et renvoie le résultat/isError. Le panneau propose aussi un processus persistant explicite : **Start server**/premier **Refresh tools** garde le serveur vivant, les appels enregistrés réutilisent le même stdio et **Stop server** le termine ; aucun serveur n'est lancé au démarrage.
- **UX :** Extensions contient un panneau **Local MCP server** avec commande, workspace effectif, liste des outils découverts, arguments JSON et résultat repliable. Les erreurs de démarrage, handshake, JSON ou timeout restent visibles via le store d'erreur.
- **Garde-fous :** commande ≤2 000 caractères, nom d'outil ≤200 caractères, sortie ≤200 000 caractères et maximum 500 outils ; stdin et stderr du serveur ne sont pas exposés à la conversation.
- **Rafraîchissement explicite et réactif :** chaque connecteur MCP local enregistré avec une commande expose **Refresh tools**. Le probe refait `tools/list` sur le processus persistant (ou le démarre après une relance), remplace la liste persistée si elle est valide et conserve l'ancienne liste en cas d'échec ou de réponse vide ; le statut désactivé reste inchangé. Un polling natif léger observe les notifications `tools/list_changed` et relance automatiquement ce même chemin SSOT.
- **Autorisation :** les appels déclenchés depuis Extensions suivent désormais la posture globale : Ask for approval demande une confirmation ponctuelle, Workspace autorise le local mais garde le distant derrière une confirmation réseau, et YOLO permet l'appel direct. Cette garde UI reste distincte de l'autorité MSP.
- **Limites :** les outils découverts ne sont pas encore injectés dans le catalogue MSP de Muse. Cette tranche prouve le transport local, l'appel contrôlé, la durée de vie explicite, la récupération manuelle et le hot-reload borné, pas la parité MCP complète.
- **Validation :** tests Rust de framing, corrélation des réponses persistantes et parsing des outils, tests Node existants, TypeScript, Vite et Cargo verts.

### Livraison M3-03 — cycle de vie d'un connecteur MCP local

- **Enregistrement vérifié :** après un probe `tools/list` réussi, l'utilisateur peut enregistrer le nom, la commande et les outils réellement découverts dans le registre local persistant.
- **Rafraîchissement manuel et hot-reload :** les entrées locales issues d'une commande affichent **Start server**, **Stop server** et **Refresh tools**. Une réussite met à jour les outils et `lastProbeAt` via le même chemin SSOT ; une erreur ou une liste vide laisse la dernière version utilisable et explique l'échec dans la ligne du connecteur. Une notification `tools/list_changed` déclenche automatiquement cette mise à jour quand le serveur est démarré.
- **Révision et rollback :** une mise à jour de catalogue conserve la version serveur et une seule copie du catalogue précédent. **Roll back** restaure explicitement cette copie sans réactiver un connecteur désactivé ; une seconde mise à jour remplace la copie précédente par la nouvelle révision.
- **Cohérence :** une mise à jour remplace les outils et la commande du même identifiant sans réactiver silencieusement un connecteur désactivé ; la liste hot-reloadée respecte toujours le statut `installed/disabled`.
- **Limites :** le serveur n'est lancé qu'après une action explicite et s'arrête à la fermeture de l'app ou via **Stop server** ; les outils restent un catalogue local tant que le host Muse ne fournit pas de bridge MCP. Mise à jour de package/source, injection moteur et autorité de permission côté host restent à traiter.
- **Validation :** tests Node d'enregistrement, rafraîchissement SSOT et conservation du statut désactivé ; TypeScript et Vite verts.

### Livraison M3-04 — découverte locale des skills

- **Scanner borné :** `skills_scan` lit uniquement `SKILL.md` dans les racines conventionnelles `.agents/skills`, `.muse/skills`, `.claude/skills` et `skills` du workspace sélectionné. La lecture est limitée à 100 documents et 20 000 caractères par fichier ; les liens symboliques sortants, fichiers non UTF-8 et entrées hors racine sont ignorés ou signalés.
- **Contrat de document :** le parseur frontmatter exige `name` et `description`, conserve le corps comme instructions et accepte une liste bornée de ressources relatives. Les ressources absolues ou traversant le dossier de la skill sont refusées avant invocation.
- **Précédence et fraîcheur :** les doublons sont résolus projet > repo > équipe > builtin. Un scan reconstruit le registre depuis les overrides persistés et les fichiers présents ; une skill supprimée du disque ne reste donc pas dans l'état courant. Les découvertes portent leur chemin et ne sont pas persistées comme overrides.
- **UX :** Extensions affiche **Scan workspace**, le nombre de skills découvertes, leur portée et leur chemin d'origine, avec les erreurs de parsing lisibles dans le panneau. Aucun scan automatique ni exécution implicite n'est déclenché.
- **Limites :** les ressources sont validées comme références relatives mais ne sont pas encore lues/transmises au moteur pendant l'invocation ; le runtime de skill et son rechargement par notification restent M3-05.
- **Validation :** 4 tests Node couvrent frontmatter, limites, erreurs visibles et précédence ; 2 tests Rust couvrent les racines connues et le bornage de lecture ; TypeScript, Vite et Cargo verts.

### Livraison M3-05 — invocation skill avec ressources fraîches

- **Chargement au dernier moment :** `skills_read_resources` relit les ressources déclarées juste avant l'envoi d'une skill découverte. Le chemin du `SKILL.md`, le workspace et le dossier de la skill sont vérifiés côté Rust ; les ressources supprimées, binaires ou hors dossier refusent l'envoi.
- **Contexte explicite :** les ressources UTF-8 bornées sont ajoutées au prompt sous des balises `<skill-resource>` avec leur chemin et l'indication de troncature. Un retry réutilise l'expansion persistée et ne recharge ni ne duplique le contexte.
- **UX/fiabilité :** une erreur de ressource crée une entrée système attribuée à la skill et laisse l'envoi en échec explicite ; aucune skill partiellement chargée n'est envoyée silencieusement.
- **Limites :** le moteur reçoit encore un contexte texte enrichi, pas une part `skill` native avec ressources ; l'invocation par ressource et le rendu de progression restent à qualifier avec le host MSP.
- **Validation :** tests Node sur le contexte attribué et tests Rust sur la confinement des ressources ; TypeScript et Cargo verts.

## M3 — Extensions et automatisations opérationnelles

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M3-01 | Connecter un serveur MCP local | Adapté | Présente | Partielle | Intégration | Transport stdio, handshake et tools/list/call explicites livrés ; processus persistant par connecteur, Start/Stop, rafraîchissement manuel et hot-reload `list_changed` livrés ; reste l'injection dans le host Muse |
| M3-02 | Connecter un serveur MCP distant | Adapté | Présente | Partielle | Unitaire | Transport streamable HTTP/SSE, bearer token en mémoire, session, reconnexion explicite et renouvellement automatique d'une session expirée livrés ; restent OAuth/secret-store natif et qualification réseau multiplateforme |
| M3-03 | Installer/désactiver une extension réellement utilisable | Adapté | Présente | Partielle | Intégration | Enregistrement post-probe, runtime persistant explicite, hot-list, hot-reload et rollback d'une révision du registre livrés ; restent package/update/source et injection dans le moteur |
| M3-04 | Découvrir les skills du disque et du projet | Adapté | Présente | Partielle | Intégration | Scanner borné `SKILL.md`, ressources relatives, priorité projet/repo/équipe et rechargement explicite livrés ; bridge natif et notifications restent ouverts |
| M3-05 | Invoquer une skill avec son vrai contexte | Adapté | Présente | Partielle | Intégration | Lecture fraîche des ressources relatives, provenance balisée, refus explicite si ressource disparue et retry sans double insertion livrés ; part `skill` native et progression restent à qualifier |
| M3-06 | Exécuter un travail planifié sans clic préalable | Adapté | Présente | Partielle | Intégration | Chaque schedule/review capture workspace, projet, modèle et politique ; ask reste en revue, workspace/YOLO dispatchent automatiquement ; journal local borné des runs visible ; une fin de tour structurée marque maintenant le run completed/failed et applique le retry borné si le host le permet. Reste le scheduler natif hors cycle UI et la sortie métier complète |
| M3-07 | Gérer sommeil, reprise, doublons et échecs de planning | Adapté | Présente | Partielle | Intégration | Politique skip/latest, curseur d'occurrence stable, bail inter-fenêtres, claim anti-doublon, retries bornés avec backoff/annulation, réveil immédiat au retour de fenêtre et fuseau IANA capturé avec résolution DST livrés côté client ; scheduler natif multi-instance et reprise après crash restent ouverts |
| M3-08 | Examiner les résultats des runs | Adapté | Présente | Partielle | Intégration | Historique borné, aperçu, statut, non-lu, lien vers la conversation, archivage, filtres, retry manuel et inspecteur de contexte livrés ; résumé métier riche et fin de run native restent ouverts |
| M3-09 | Recevoir une notification utile | Adapté | Présente | Partielle | Intégration | Inbox locale dédupliquée pour fins/échecs, non-lus, ouverture de conversation, silence persistant et retour au premier plan au clic livrés ; plugin OS/Tauri utilisé dans l'app native, restent le service persistant application fermée et le routage direct de l'action |

Preuves : [connecteurs](../src/lib/connectors.ts), [skills](../src/lib/skills.ts), [planning](../src/lib/schedules.ts), [journal des runs](../src/lib/scheduleRuns.ts), [file actuelle](../src/components/ReviewQueuePanel.tsx).

**Dépendances :** M0-06/08 avant MCP ; M2-01 et M0-02/09 avant M3-06 ; M2-03 si run isolé ; M3-06/07 avant inbox. **Sortie M3 :** un run programmé utilise un vrai outil/skill, s'exécute selon la politique et produit un résultat consultable. Pour les runs locaux, app et ordinateur allumés restent une contrainte explicitée.

### Livraison M3-02 — MCP distant (première passe)

- **Transport réel** : `src/lib/remoteMcp.ts` effectue `initialize`, `notifications/initialized`, `tools/list` et `tools/call` sur un endpoint public HTTPS. Les réponses JSON et SSE sont corrélées par identifiant JSON-RPC ; les réponses HTTP 202/204 des notifications sont acceptées.
- **Session et secrets** : `Mcp-Session-Id` est repris sur les requêtes suivantes. Le bearer token et l'identifiant de session vivent uniquement dans une référence mémoire du hook ; le registre persiste l'URL, la version et le catalogue vérifié, jamais le secret.
- **UX** : Extensions propose **Connect and list tools**, un champ de token masqué, un appel de test et **Reconnect** après une perte de session. Le catalogue ne passe à `installed` qu'après l'échange réel ; les erreurs réseau/auth restent visibles et une connexion perdue devient **Disconnected**.
- **Garde-fous** : l'endpoint doit être public et HTTPS, le plan conserve une seule entrée distante et les descriptions/outils sont bornés. Une reconnexion après relance exige une nouvelle saisie du token.
- **Reconnexion automatique bornée** : une réponse 401/403 relance une seule fois `initialize` + `tools/list` avec le bearer conservé en mémoire, puis rejoue l'appel seulement après un nouveau handshake. Les timeouts, erreurs réseau et réponses ambiguës ne sont jamais rejoués automatiquement.
- **Limites** : OAuth, stockage sécurisé natif et test réseau macOS/Linux restent à concevoir ; le host Muse ne reçoit pas encore ces outils comme capacités natives.
- **Validation** : quatre tests Node couvrent la continuité de session, bearer token, SSE, refus privé/HTTP et réponse mal corrélée ; TypeScript et build Vite restent verts.

### Livraison M3-07 — fuseau explicite et DST

- **Capture SSOT :** chaque automatisation mémorise le fuseau IANA détecté au moment de sa création. Le fuseau est propagé dans la review, le run et l'inspecteur ; les anciennes lignes sans fuseau restent compatibles.
- **Calcul déterministe :** les cron récurrents sont évalués en heure murale dans le fuseau capturé. Les minutes inexistantes lors d'un passage à l'heure d'été sont ignorées ; lors d'un retour à l'heure d'hiver, la seconde occurrence est conservée si elle est encore strictement après le curseur.
- **UX :** le formulaire affiche le fuseau capturé et chaque run l'expose dans Inspect run, afin de rendre le prochain déclenchement explicable.
- **Limites :** la résolution reste côté client et ne remplace pas un scheduler natif quand l'application est fermée ; les règles métier de rattrapage après crash restent à qualifier.
- **Validation :** tests Node couvrent fuseau valide/invalide, conversion quotidienne, trou DST et doublon DST ; TypeScript et build Vite restent requis.

### Livraison M3-08 — inspecteur de runs

- **Contexte conservé** : chaque ligne de l'inbox peut maintenant être dépliée pour retrouver la conversation cible, le mode d'autorisation capturé, le modèle, le workspace/projet, l'occurrence planifiée, la tentative courante et les horodatages de début/fin.
- **Résultat lisible** : la durée est calculée à partir des timestamps observés ; l'aperçu de résultat et l'erreur restent séparés et affichés dans des blocs multilignes, sans transformer un run encore en cours en succès.
- **UX** : l'inspecteur utilise le contrôle natif `details/summary`, reste navigable au clavier et conserve les actions d'ouverture, retry, lecture et archivage dans le même contexte.
- **Limite** : le résumé reste borné au dernier aperçu assistant enregistré localement. Un résultat métier structuré et un signal de fin de run natif restent à qualifier avec le host.
- **Validation** : TypeScript, build Vite et suite Node restent requis ; la preuve native de fin de run est distincte de cet inspecteur local.

### Livraison M3-09 — notifications de runs

- **Inbox persistante :** les runs `completed` et `failed`, ainsi que les demandes `approval` et `input`, créent une notification locale bornée, avec titre, aperçu/erreur, horodatage, cible de conversation et clé d'idempotence. Une même occurrence ou demande ne peut pas être ajoutée deux fois.
- **UX :** Automations expose les six dernières notifications, un badge non-lu, **Open conversation** et **Mark read**. La permission desktop est activable à la demande ; si l'OS refuse ou ne fournit pas l'API, l'inbox reste la surface de secours.
- **Silence au démarrage :** les notifications déjà présentes sont hydratées comme historique et ne déclenchent pas un toast à chaque relance. Les nouvelles notifications non lues passent par `tauri-plugin-notification` dans l'app native et retombent sur l'API `Notification` du webview en preview.
- **Préférence de silence :** Automations permet de couper ou réactiver les toasts desktop sans masquer l'inbox ; le choix est conservé sous `muse-desktop.notifications.preferences.v1`. Un clic sur un toast tente de restaurer la fenêtre Muse (`unminimize` + `setFocus`) puis l'inbox fournit l'ouverture de la conversation ciblée.
- **Bridge desktop :** `tauri-plugin-notification` est enregistré avec la permission `notification:default`; la demande de permission et l'envoi passent par son API dans un build Tauri, avec fallback web preview.
- **Limites :** l'application doit rester ouverte pour recevoir les événements du host ; la persistance d'un scheduler/notification quand l'application est fermée, le routage OS direct et la qualification native du permission prompt restent à exécuter sur Windows/macOS/Linux.
- **Validation :** suite Node, TypeScript et build Vite verts ; la qualification native du permission prompt reste à exécuter sur Windows/macOS/Linux.

## M4 — Parité étendue

Ces écarts restent visibles pour une ambition de parité complète. Leur faisabilité doit être vérifiée avec le moteur Muse avant engagement d'implémentation.

| ID | Résultat attendu | Design | UI | Fonction | Validation | Reste à faire et critère de sortie |
|---|---|---|---|---|---|---|
| M4-01 | Naviguer dans un vrai navigateur intégré | Adapté | Présente | Partielle | Unitaire | Navigation URL normalisée, historique précédent/suivant, rechargement et erreurs d'iframe livrés ; action **Open native** ouvre une webview Tauri dédiée avec validation http(s) et réutilisation de fenêtre ; cookies, téléchargements et sessions maîtrisées restent à qualifier |
| M4-02 | Annoter visuellement une page et transmettre le contexte | À définir | Partielle | Locale | Unitaire | Ancre URL normalisée, sélection/commentaire et insertion explicite dans le prompt livrés ; capture réelle, région/iframe/zoom et contexte visuel restent à concevoir |
| M4-03 | Faire piloter le navigateur par Muse | À définir | Absente | Absente | À faire | Observation/actions et permissions ; scénario web complet reproductible |
| M4-04 | Faire piloter une application desktop | À définir | Absente | Absente | À faire | Runtime par OS et consentement effectif ; exécution interrompable et attribution claire des actions |
| M4-05 | Produire/consulter des images et documents riches | À définir | Partielle | Partielle | À faire | Artefacts Markdown versionnés, réutilisation et export texte local livrés ; capacités moteur image/document, fichiers réellement générés, previews riches et qualification native restent à faire |
| M4-06 | Partager par URL et révoquer l'accès | À définir | Partielle | Locale | Unitaire | Hébergement, identité, permissions et révocation réelle ; second client lit puis perd l'accès |
| M4-07 | Contrôler une exécution sur un autre host ou dans le cloud | À définir | Absente | Absente | À faire | Auth, routage, stockage et reprise distante ; statut exact après déconnexion |
| M4-08 | Interagir par la voix | À définir | Absente | Absente | À faire | Choisir capture/transcription ou conversation temps réel ; définir permissions et preuve de bout en bout |
| M4-09 | Installer et mettre à jour sur les plateformes annoncées | Adapté | Partielle | Partielle | Intégration | Bundle Windows x64 NSIS reproductible livré avec sidecar et icônes ; restent signature/distribution, updates/rollback et qualification macOS/Linux |

Preuves : [browser actuel](../src/components/BrowserPanel.tsx), [exports locaux](../src/lib/sharing.ts), [artefacts](../src/lib/artifacts.ts).

### Livraison M4-01/M4-02 — navigation intégrée bornée

- **Navigation :** BrowserPanel normalise l'adresse, conserve un historique local précédent/suivant, expose Reload et affiche l'URL réellement chargée. Les erreurs de protocole et de chargement restent dans la surface du navigateur. **Open native** ouvre désormais une webview Tauri dédiée (`muse-browser`) dans le build desktop ; la commande native revalide le schéma, l'hôte, l'absence de credentials et la taille de l'URL, puis réutilise la fenêtre existante.
- **Annotations :** les commentaires sont ancrés à l'URL normalisée courante ; changer de page ne mélange plus les notes des autres pages.
- **Contexte vers la conversation :** les actions **Add page context** et **Add to prompt** transmettent au composer actif un bloc borné et explicitement étiqueté avec l'URL normalisée, la sélection et le commentaire. Le hook de sessions reste la SSOT et ajoute ce bloc au pré-remplissage existant ; une session absente ou un contexte vide est refusé avec une erreur visible.
- **Limites :** l'iframe sandboxée reste le repli du web preview et ne fournit ni cookies/onglets d'un navigateur complet ni capture visuelle. Les sessions/cookies, téléchargements, capture viewport/région, iframe/zoom et qualification WebView2 restent à qualifier. Décision : `docs/plans/2026-09-17-native-browser-surface.md`.

### Livraison M4-05 — export texte des artefacts (première passe)

- **Résultat :** chaque version d'un artefact du panneau **Content** expose **Export**. En desktop, le sélecteur de sauvegarde natif propose un nom et une extension dérivés du type/langage ; le bridge écrit ensuite le contenu UTF-8 exact de la version choisie. En preview web, le téléchargement navigateur reste disponible. Files affiche aussi un aperçu borné des images et PDF reconnus dans le workspace, avec un repli d'ouverture système.
- **Garde-fous :** la destination doit être un chemin absolu sélectionné explicitement, le dossier parent doit exister et le contenu est limité à 2 MiB. Aucun dossier n'est créé et le fichier exporté n'est jamais exécuté par Muse.
- **Provenance :** l'export porte la version sélectionnée (`vN`) et le message de succès reste dans le panneau ; la restauration **Reuse** conserve son chemin de pré-remplissage séparé.
- **Limites :** les blocs Markdown ne deviennent pas automatiquement des fichiers générés par le moteur ; documents bureautiques, dimensions riches et qualification native de l'ouverture/écrasement restent les prochaines sous-tâches M4-05.
- **Validation :** tests Rust d'écriture UTF-8 et de bornes, suite Node, TypeScript et build Vite verts.

### Livraison M4-09 — bundle Windows x64 (première passe)

- **Build reproductible :** la cohérence Tauri/npm des plugins est vérifiée avant compilation ; `scripts/build-windows.ps1` vérifie le sidecar puis lance `npm run tauri -- build --bundles nsis`, qui génère un installateur NSIS x64 avec le frontend Vite, le sidecar `muse-x86_64-pc-windows-msvc.exe` et les icônes Muse déclarées dans `tauri.conf.json`.
- **Artefact local :** `src-tauri/target/release/bundle/nsis/Muse-Desktop_0.1.0_x64-setup.exe` (généré le 16 septembre 2026). Le dossier `target/` reste un artefact de build et n'est pas versionné.
- **Limites :** le sidecar est fourni par l'environnement de build et n'est pas publié dans le dépôt ; signature, publication, mise à jour différentielle, rollback et matrice macOS/Linux restent à qualifier avant une release publique.
- **Validation :** build NSIS local terminé avec succès après alignement `@tauri-apps/plugin-notification`/`tauri-plugin-notification` en 2.4.x ; la signature et l'installation sur machine propre restent des preuves séparées.

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

Validation du socle audité : build frontend, 381 tests Node, 40 tests Rust verts. Les preuves UI de la passe précédente sont détaillées dans [la passe conversations](plans/2026-09-14-conversation-polish.md). Elles ne couvrent pas l'ensemble des critères futurs ci-dessus.
