# Plan d'implémentation pour les agents de codage

Référence : [roadmap opérationnelle](../ROADMAP.md). Ce plan précise **comment réaliser le reste**, sans modifier les statuts de livraison. Base observée : `main` après PR #98 ; reprise explicite, MCPB, secret-store, file de commentaires de revue, résumés extractifs de runs et progression d'invocation des skills sont déjà fusionnés. Avant toute intervention, vérifier quelles PR sont fusionnées et lire leur code actuel. Ne pas réimplémenter `hosts.rs`, `resume.rs` ou Reconnect si déjà présents.

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

**Travail :** ajouter un scénario Tauri avec deux dossiers temporaires, deux sessions et flux entrelacés. Interrompre/faire mourir B pendant que A travaille ; vérifier routes send/model/approval/input/subagent, sessions supprimées et événements tardifs d'une ancienne génération. Traiter aussi fermeture du canal stdout sans événement Terminated et échec pendant initialize. Le contrôle opt-in `npm run smoke:native` couvre désormais le pré-vol réel Windows (deux `muse serve`, handshake, sessions et `model/list`) avec nettoyage et sortie JSON bornée ; `--exercise-isolation` tue B et vérifie qu'une requête read-only sur A reste servie, tandis que `--exercise-cut-during-turn` ferme B après admission d'un tour et vérifie la survie de A. Le run complet du 18/09/2026 a confirmé deux workspaces/hosts distincts, deux interruptions, quatre erreurs structurées, les approbations plafonnées, le shell utilisateur, la queue/reprise, la compaction bornée et la survie de A après la panne de B. Ces contrôles restent un pré-vol transport/isolation et ne remplacent pas le scénario Tauri complet.

**Acceptation :** A conserve son identité, ses requêtes et son flux ; B seul devient déconnecté ; aucun processus/consommateur ne reste après fermeture. Dépendance : harnais M0-14. Ne pas clore avec le seul smoke « deux model/list ».

### M0-02 — Reprise complète et réconciliation

**Code :** `resume.rs`, `resume_session`, `reconnectSession`, `persist.ts`, `poll.ts`. Conserver la validation identité/dossier/durabilité de PR #14.

**Travail :** définir `ConnectionState = disconnected | connecting | connected | error` par session et génération. Persister le dernier curseur serveur observé quand le protocole le garantit ; utiliser resume/history/view-page pour récupérer le suffixe manquant. Dédupliquer par identité serveur des items, pas par leur texte. Réconcilier demandes d'approbation et questions réémises ; conserver les brouillons. Ne pas réattacher un profil éphémère non récupérable. Adapter explicitement les chemins Windows/WSL sans supposer tous les montages identiques.

**Tranche livrée :** `read_session_history` appelle `session/read` avec `excludeItems:false` après `session/resume`. `src/lib/history.ts` normalise les items inline ou snapshot dans les lanes du fil, remplace les blocs partiels par leur version durable via `itemId`, et garde les notes locales et les anciens échos utilisateur. Si `session/read` est absent, `readHistoryEntries` bascule sur `page_session_history`/`view/page`, parcourt au plus huit pages de 500 événements et replie les lifecycle items sur leur plus haute révision avant la même fusion. Les réponses sans historique inline restent compatibles : la reconnexion réussit et le transcript local est conservé. `restore_sessions` parcourt désormais aussi les pages `session/list`, rattache les lignes à l'instance hôte qui les a servies et crée les métadonnées renderer pour les sessions durables inconnues après un redémarrage, sans reprendre une identité déjà détenue par un autre host. Le hook expose aussi une activité live par session ; `StreamView` rend un état de santé discret, un compteur depuis le dernier événement et des actions de reconnexion/arrêt quand le host devient silencieux. Cette indication reste consultative : elle ne remplace pas `running` et ne ferme aucun tour. La réponse `initialize.sessionDurability` est maintenant propagée par workspace et persistée dans les métadonnées ; un host explicitement `ephemeral` affiche le transcript local mais retire l'action de reconnexion après redémarrage, tandis qu'une valeur absente conserve le chemin de compatibilité. La reprise durable vérifie maintenant d'abord `session/read` (`excludeItems:true`), valide l'identité, le chemin et le workspace, puis envoie `session/resume` avec un `commandId` neuf sans rejouer le transcript local ; un test Rust vérifie la séquence, la projection de statut/posture/durabilité et le nettoyage de route sur erreur.

**Échec de reprise sans conversation fantôme :** une réponse `session/resume` invalide ou rejetée retire maintenant à la fois la route host et la métadonnée `SessionMeta` provisoire ; la configuration MCP est validée avant toute insertion d'état. Un test Tauri vérifie qu'une enveloppe sans conversation ne laisse aucun rattachement résiduel.

**Pré-vol natif au 18/09/2026 :** `node scripts/native-smoke.mjs --exercise-reconnect` tente les deux lectures de réconciliation (`session/read` et `approval/listPending`) sur chaque sidecar Windows. Muse Code 1.3.0 répond `methodNotFound` pour ces deux méthodes ; le smoke l'enregistre comme `unsupported` et continue afin de distinguer une absence de contrat d'un échec de transport. Le même run complet confirme aussi `session/list` disponible mais `view/page` absent, et ne reçoit aucune projection d'historique ou d'item shell sur ce sidecar. La reprise live reste donc câblée côté renderer mais non démontrée par ce binaire ; aucun statut durable ne doit être affiché sans host qui expose ces méthodes.

**Acceptation :** fermer après un message, rouvrir et envoyer dans la même session ; reprise après panne avec suffixe sans doublon sur un host durable ; demande en attente visible une fois ; refus de lease/dossier incorrect préserve les messages ; host `ephemeral` signalé sans action de reconnexion trompeuse. Dépend de M0-01/08/09. La reconnexion de métadonnées seule et la reprise sur le sidecar 1.3.0 restent partielles.

**Sous-ticket liveness/connexion (livré) :** définir un pur `classifyStreamHealth` avec seuil borné (15 s), priorité aux demandes d'action et états `waiting-host`/`stalled`. Toucher l'activité sur chaque événement et sur les actions qui relancent le tour (`send`, approbation, question, guidance). Afficher le signal inline dans `StreamView`, conserver les détails de réflexion repliables et vérifier la frontière du seuil, les états explicites et le rendu sans backend. Le hook expose en parallèle un `SessionConnectionState` par identité ; `host_exited`, reconnexion et échec de reprise mettent à jour ce cycle sans toucher à l'historique. Le fil affiche également la durée de la phase de réflexion et un libellé allowlisté du dernier événement observé ; aucun payload ou nom de transport arbitraire n'est injecté dans le texte utilisateur. **Sync now** relit de façon idempotente l'historique et les demandes en attente sans remplacer le host, et ne rétablit la liveness que lorsqu'un item durable prouve une progression. Après le même seuil de silence, le hook lance une seule réconciliation automatique silencieuse pour les décisions acceptées ; elle ne supprime jamais le pont `resuming` sans preuve durable. Une résolution d'autorisation observée après reconnexion recrée le placeholder et le pont de reprise uniquement pour une décision explicitement acceptée. Les décisions cliquées sont résolues depuis le snapshot courant borné à la session, afin qu'un refus connu ne soit jamais traité comme une reprise. Quand un host émet `turn/retryScheduled`, le même état live affiche le compte à rebours, la tentative et la raison, corrèle les événements porteurs d'un `turnId` au tour courant et ignore les notifications retardées d'un tour terminé, puis expose **Stop retry** pendant le backoff et rend les actions de récupération si aucune reprise n'arrive après le délai. La qualification d'un vrai host qui reste silencieux doit rester une preuve native séparée.

### M0-03 — Envoi sans perte et retry

**Code :** `Composer.tsx`, hook `sendInput`, `persist.ts`, `EmptySessionScreen.tsx`.

**Travail :** faire retourner un résultat explicite à l'action d'envoi. Ajouter un message sortant avec `clientMessageId`, texte original, cible, état `sending/accepted/failed`, erreur et clé d'idempotence. Ne vider le brouillon qu'à acquittement, ou conserver un message réessayable durable. Après timeout ambigu, vérifier l'état serveur avant retransmission ; réutiliser la même clé pour le même envoi logique. Les expansions skill/projet doivent rester reproductibles sans doubler le texte.

**État au 18/09/2026 :** l'outbox renderer conserve déjà l'expansion exacte, le `commandId` stable, les échecs ambigus et le retry vérifié. En build Tauri, elle est maintenant miroirée atomiquement sous `app_data/outbox/outbox.json` (enveloppe `muse-desktop.native-outbox.v1`, 4 MiB) puis fusionnée par `clientMessageId` et `updatedAt` au démarrage ; une copie native restée `sending` est récupérée comme ambiguë, tandis qu'un état `accepted` plus récent supprime un ancien retry. Les écritures miroir sont sérialisées et coalescées afin d'éviter qu'un `invoke` lent ne réinstalle un état périmé ; la sidebar expose aussi le nombre d'envois conservés sur toutes les conversations et ouvre la conversation cible pour les traiter. La preuve E2E avec un moteur réel coupé pendant l'envoi reste ouverte.

**Acceptation :** réseau/host coupé, refus serveur, double-clic, fermeture/rechargement, changement de conversation et échec du premier prompt : texte récupérable et un seul tour accepté. Dépend de M0-02/09 ; tester aussi IME et saisie pendant l'attente.

### M0-04 — Arrêt fiable

**Code :** `cancel_session`, `interrupt_session`, `phase.ts`, `StreamView.tsx`.

**Travail :** séparer `interruptRequested` de l'état terminal confirmé. Ne pas annoncer arrêté parce qu'un appel a été tenté. Mapper erreur « déjà terminé » sans fausse panne ; conserver le flux jusqu'au terminal ou à la déconnexion identifiée.

**Acceptation :** arrêt avant premier token, pendant outil, après fin, réponse tardive et double-clic. L'arrêt de A n'affecte pas B ; l'état final correspond au moteur. Dépend M0-01/03.

**État au 18/09/2026 :** demande de cancellation conservée dans un état renderer-only jusqu'à réception d'un terminal `turn/completed`, `turn/retracted` ou `turn/stopped` (ou déconnexion), avec badge `Stopping Muse`, bouton désactivé contre le double-clic et transcript non fermé prématurément. Si l'accusé reste sans événement pendant la fenêtre de liveness, le fil affiche un état de récupération et une fermeture explicite au lieu de mouliner indéfiniment. La qualification native des courses et réponses tardives reste à produire.
**Pré-vol natif au 17/09/2026 :** `node scripts/native-smoke.mjs --exercise-control --exercise-errors --exercise-approval --exercise-isolation` admet en parallèle puis interrompt immédiatement un tour synthétique sur deux sidecars Windows distincts, vérifie l'accusé `accepted`, la conservation des `turnId`, les catégories d'erreur, le plafond d'autorisation et la survie de A après l'arrêt de B. `--exercise-cut-during-turn` ajoute la panne B après admission d'un tour et vérifie que A répond encore, sans présenter une notification terminale absente comme un succès. Le rapport distingue l'accusé d'interruption d'une notification terminale réellement reçue ; le sidecar Muse Code 1.3.0 testé ne publie aucune des formes `turn/completed`, `turn/retracted` ou `turn/stopped`, donc le contrôle reste explicitement `terminalNotification: unsupported`. `--exercise-terminal` force cette exigence pour qualifier un host ultérieur. La fermeture termine aussi l'arbre Windows avec un repli borné afin de libérer les workspaces temporaires. `--report <fichier>` permet de conserver exactement le JSON borné produit par le smoke pour l'attacher à une validation, sans chemin de workspace ni transcript. Le rapport de base expose `initialize.sessionDurability` pour éviter de présenter une reconnexion comme disponible sur un host éphémère. Cette preuve couvre le contrat de commande et l'isolation transport, pas la course UI entre un premier token, un outil, un terminal confirmé et une réponse tardive.

### M0-05 — Demandes en attente

**Code :** `ApprovalPanel.tsx`, `InputPanel.tsx`, routage MSP, tables d'approbations.

**Travail :** indexer par session + identifiant + génération, conserver le token opaque du serveur, retirer seulement sur règlement confirmé. Réconcilier snapshot et notifications de reprise ; les anciennes décisions ne doivent pas agir sur une nouvelle demande. Garder la réponse éditée si refus de validation.

**Tranche livrée :** après `session/resume`, le hook appelle `list_pending_requests` (`approval/listPending`) et remplace uniquement les cartes de la session concernée. Les payloads approval et user input sont repassés par les parseurs existants ; les tokens opaques restent dans le registre Rust et les événements réémis par le host restent idempotents côté UI. Le bridge de résolution relaye aussi un `turnId` borné, y compris dans les variantes snake_case et imbriquées, afin que le renderer rattache la reprise au tour qui attendait l'autorisation.

**Limite native observée :** le sidecar Windows 1.3.0 utilisé par le smoke ne sert pas `approval/listPending` (`methodNotFound`). Le panneau conserve les événements reçus et montre l'erreur bornée lors d'une synchronisation explicite ; la réémission réelle d'une demande après incident nécessite une version de host qualifiée ou un contrat de compatibilité documenté.

**Acceptation :** même ID dans deux sessions, demande réémise, token périmé, erreur après clic, redémarrage et double réponse. Un choix n'est envoyé qu'à sa cible. Dépend M0-02/04/08.

### M0-06 — Permissions effectives

**Code :** `SettingsPanel.tsx`, `settings.ts`, `allowlist.ts`, `scope.ts`, spawn du host.

**Travail :** établir une matrice capacités/préférences/posture appliquée depuis le vrai moteur. Définir comment un changement affecte les hosts existants : appliqué, prochain démarrage ou non supporté. Ne pas convertir une préférence locale en autorisation moteur implicite. Afficher origine et portée ; désactiver les options sans contrat vérifié.

**Acceptation :** lecture/écriture hors racine, symlink, réseau et commande refusée ; verdict moteur conforme au texte UI. Dépend M0-01/08 ; profils testés sans élargir les permissions réelles de l'utilisateur.

**Pré-vol natif au 17/09/2026 :** `--exercise-approval` crée une session sans préférence imposée, relève la projection `approvalMode` du host puis tente `onRequest`, `promptUnmatched` et `allowAll`. Le sidecar 1.3.0 observé accepte la posture courante `promptUnmatched` et refuse les deux autres avec `commandRejected/approval_mode_ceiling`. Cette limite est désormais explicite dans le rapport ; l'UI ne doit pas convertir une préférence locale refusée en permission effective.

**Continuité sous plafond :** si une préférence locale persistée est refusée à `session/start` pour `approval_mode_ceiling`, le bridge retire uniquement ce champ et retente avec la posture par défaut du host. La réponse expose `approval_mode` lorsque disponible. `reconnectSession` garde ensuite l'historique et le compositeur utilisables si `session/setApprovalMode` est refusé, en conservant la projection observée et en suspendant l'auto-approbation jusqu'à confirmation.

**Pump stdout :** `pump_stdout` délègue à `ingest_stdout_chunk`, frontière asynchrone testée avec un child injecté et avec un vrai processus enfant système. Le test de bout en bout couvre une requête écrite par le `ChildTransport` de production, une réponse et une notification découpées en vrais `CommandEvent::Stdout`, la corrélation par identifiant et la terminaison contrôlée du pump. Il reste à brancher une webview empaquetée et le scénario natif A/B complet dans le contrôle M0-14g.

Le contrat de démarrage est également couvert sans webview : une erreur `approval_mode_ceiling` sur la première `session/start` provoque un second appel sans `approvalMode`, tandis qu'une erreur différente reste bloquante. La session reçoit ensuite la projection effective du host (`approval_mode`) pour que la SSOT renderer ne confonde pas préférence locale et permission appliquée.

### M0-07 — Diagnostics

**Code :** `wire_log`, `push_stderr`, `msp.rs`, erreurs affichées.

**Travail :** supprimer la capture brute en usage normal. Si diagnostic activé : événements structurés, métadonnées minimales, masquage, rotation et rétention bornées ; export explicite avec aperçu. Utiliser une troncature respectant les frontières UTF-8.

**État au 17/09/2026 :** Settings propose un export JSON local borné (`muse-desktop.diagnostics.v1`) contenant plateforme, backend, compteurs de sessions/événements et dernière erreur rédigée. Le bridge Tauri expose aussi `collect_diagnostics` (`muse-desktop.native-diagnostics.v1`) pour ajouter les compteurs natifs de workspace, hosts, sessions, approbations et buffer d'événements ; le web preview conserve un fallback renderer. Les événements `turn/completed` conservent désormais l'erreur terminale MSP structurée (`kind`, `message`, `retryable`, durée/raison), persistée dans le journal et rendue dans une disclosure lisible ; une erreur réessayable propose **Retry turn** à partir du dernier prompt utilisateur précédent. Les hôtes sans enveloppe retombent sur une raison bornée et rédigée. Aucun chemin de workspace ni contenu de conversation n'est exporté ; les secrets courants sont masqués. Le pré-vol natif `--exercise-errors` confirme maintenant que les catégories `methodNotFound` et `invalidParams` traversent le transport sur deux hôtes isolés ; la qualification des erreurs détaillées d'un tour réel reste ouverte.

**Acceptation :** Unicode multioctet à la limite, erreur longue, secret synthétique, volume élevé. Aucun prompt ou secret brut écrit par défaut ; pas de panic. Livrable autonome, sans attendre les autres lots.

### M0-08 — Contrat du moteur

**Code :** `lib/msp.ts`, `msp-conformance.test.ts`, `main.rs`, SDK épinglé.

**Travail :** recenser les RPC réellement envoyées, y compris modèles/compaction/subagents/reprise. Contrôler le registre contre l'implémentation plutôt qu'un nombre constant. Stocker les capacités et version de handshake ; définir incompatible vs ajout compatible. Centraliser les codes d'erreur utiles et masquer les actions non supportées.

**Acceptation :** RPC manquante du registre fait échouer le contrôle ; schéma incompatible produit une erreur exploitable ; notification additive inconnue n'arrête pas le flux. Livrer fixtures anonymisées de versions connues.

**Pré-vol natif au 17/09/2026 :** le binaire Muse 1.3.0 répond au handshake attendu et renvoie des erreurs JSON-RPC structurées pour une méthode inconnue et une interruption sans paramètres sur chacun des deux hosts du smoke. Le contrôle combiné ajoute deux interruptions corrélées, six tentatives de posture avec le plafond `approval_mode_ceiling` observé et l'arrêt isolé de B pendant qu'A continue de répondre. Cette preuve ne couvre pas encore la matrice de versions ni les erreurs produites pendant un tour modèle.

### M0-09 — Persistance

**Code :** `persist.ts` et tous les modules utilisant localStorage/sessionStorage.

**Travail :** inventaire des clés et politiques de conservation. La façade versionnée `lib/storage.ts` est maintenant le point d'entrée de tous les lecteurs/écrivains `localStorage` connus, y compris les valeurs scalaires. Elle valide les lectures JSON, conserve les anciennes valeurs en cas d'échec d'écriture, borne les diagnostics et exporte un snapshot de récupération. Les formats `v1` restent inchangés ; **Migrate legacy data** copie désormais les alias `muse.*` et logs historiques lisibles vers les clés actuelles absentes, en gardant les sources et les erreurs visibles. Les exports portent aussi une classification `durable`/`ui` additive : les nouveaux imports sélectionnent les données durables, tandis que les pointeurs, brouillons et baux d'interface restent explicitement opt-in. Le checksum déterministe de l'export est vérifié avant aperçu et restauration ; les anciens snapshots sans checksum restent compatibles. Reste à qualifier les formats externes, les tombstones et les quotas sans résurrection.

**Tranche livrée :** le snapshot exporté peut être réimporté depuis Settings. L'import vérifie le format/version et limite les clés au namespace `muse-desktop.*`. Un aperçu liste les clés récupérables, leur présence actuelle et les valeurs brutes endommagées ; seules les nouvelles entrées sont cochées par défaut. La confirmation restaure ensuite la liste de clés choisie, y compris le remplacement explicite d'une clé existante, puis le rechargement suit le boot normal pour éviter un état React partiellement restauré.

**Acceptation :** schéma ancien, alias de logs, JSON corrompu, checksum modifié, stockage indisponible/saturé, migration interrompue et réouverture. Aucun effacement silencieux ; export de secours accessible. Les migrations précèdent la modification de format M0-02/03 et M2.

### M0-10 — Premier lancement Windows

**Code :** bridge WSL, `SidecarErrorPanel.tsx`, résolution du sidecar, README.

**Travail :** diagnostic sans secrets de WSL/distribution, binaire, version, dossier accessible et authentification. Afficher étapes de correction et bouton Réessayer. Distinguer UI Windows native et moteur WSL ; pas d'installation implicite non maîtrisée.

**État au 18/09/2026 :** `probe_startup` exécute une sonde native read-only et bornée (sidecar, WSL, `~/.local/bin/muse`, workspace), disponible explicitement dans Settings et réutilisée par le panneau de récupération après un échec ou un retry. Elle ne s'exécute plus automatiquement à chaque changement de dossier et n'encombre donc pas l'accueil. Le résultat reste structuré par check et ne lit aucune credential ; la guidance existante conserve la correction manuelle. Le panneau de récupération et Settings affichent désormais un libellé textuel pour chaque état afin que la compréhension ne dépende pas de la couleur (`Ready`, `Needs attention`, `Blocked`, `Not verified`) ; l’écran d’accueil normal ne montre pas ces diagnostics. Les sorties console UTF-16 de Windows sont décodées et les caractères de contrôle/remplacement sont nettoyés avant affichage, avec une seconde passe côté renderer pour les sidecars anciens et le mode preview, y compris les chaînes UTF-16 résiduelles avec NULs intercalés.

**Complément livré :** sur Windows, `npm run dev:clean:windows` appelle `scripts/dev-clean.ps1`. Il ne termine que les arbres dont l'exécutable ou la ligne de commande appartient à ce checkout, purge le cache Vite local et exécute `tauri dev` avec le renderer attaché. Cela rend le chemin de relance reproductible sans transformer le binaire packagé en serveur de développement.

**Acceptation :** machine propre, Muse absent, auth absente, chemin avec espaces/Unicode, bridge incompatible. Le premier tour est atteignable avec instructions exactes. Dépend M0-08.

### M0-11 — Finition anglais/navigation

**Code :** composants, `App.tsx`, messages produits par le hook, `WindowControls`.

**Travail :** inventaire des libellés et erreurs générées par l'app, cohérence conversation/projet/run, raccourcis Ctrl/Cmd et états focus. `primaryModifier()` fournit maintenant le libellé OS des infobulles globales, sidebar et input. Centraliser les textes réutilisés si utile ; ne pas traduire les contenus utilisateur ou moteur.

**État au 17/09/2026 :** `userFacingError` centralise la copie anglaise calme des erreurs techniques sur le bandeau global, les fichiers, les projets, les paramètres, les demandes d'entrée, les sélecteurs de dossier, le composer, la revue Git, le scan skills, le catalogue de modèles et les contrôles de fenêtre. Le scan skills gère maintenant aussi un rejet asynchrone ; les erreurs de pièces jointes restent nommées mais utilisent la même copie bornée. Les détails restent bornés et masqués, tandis que les textes utilisateur et moteur sont conservés tels quels. La checklist native finale des titres et erreurs doit encore être rejouée dans la webview empaquetée.

**Acceptation :** checklist accueil/conversation/archives/paramètres/extensions et erreurs ; aucune régression du profil fixe, des thèmes ou de la zone de drag. Captures light/dark et tailles desktop cibles.

### M0-12 — Accessibilité

**Code :** `a11y.ts`, dialogues, panneaux de questions, sidebar, composer et stream.

**Travail :** focus initial/retour, navigation des groupes, fermeture Échap, intitulés et annonces live non répétitives. Vérifier contraste et zoom ; annoncer fin/besoin d'action plutôt que chaque token. Les contrôles ajoutent aussi un chemin de contraste forcé Windows (`Highlight`, `ButtonText`, `LinkText`) sans changer le rendu normal.

**État au 18/09/2026 :** les cartes d'approbation et de questions placent le focus à l'arrivée, proposent la navigation fléchée des choix, une boucle Tab confinée à la carte active, ainsi que Ctrl+Entrée pour répondre et Échap pour ignorer. Le transcript reçoit désormais le focus et expose Home/End/PageUp/PageDown avec des cibles bornées ; End réutilise le retour au dernier message et le chargement des pages anciennes reste déclenché par le scroll. Les tests purs de navigation et d'annonces restent verts ; la vérification avec lecteur d'écran réel, zoom 200 % et réduction des mouvements demeure à exécuter.

**Acceptation :** parcours complet sans souris, lecteur d'écran réel, zoom 200 %, réduction des mouvements. Les tests automatisés complètent mais ne remplacent pas cette vérification.

### M0-13 — États de capacité honnêtes

**Code :** panneaux Settings/Connector/Browser/Share/Orchestration, composants communs.

**Travail :** définir présentation commune `available/local/manual/unavailable` avec raison et action suivante. Le composant partagé est maintenant appliqué aux connecteurs, channels, exports, worktrees, index local et import CLI/IDE ; les badges restent limités aux surfaces dont la capacité peut être confondue avec une connexion réelle. Remplacer promesses « installé/connecté/restauré » lorsque seul un registre ou un préremplissage change. Ne pas ajouter un badge permanent à chaque élément fonctionnel.

**État au 18/09/2026 :** le badge partagé expose aussi un nom accessible complet (`état : raison`) afin que la portée d'une capacité ne dépende pas du survol ou de la couleur. Il est maintenant présent sur les surfaces Browser et Desktop control : l'aperçu embarqué est explicitement local, tandis que la fenêtre native, la capture et les actions du host restent conditionnées par le runtime, les annonces de capacité et le consentement. Le vocabulaire visuel et le libellé d'assistance restent issus du même helper pur.

**Acceptation :** audit clic → effet réel sur chaque action ; aucune confirmation fictive. Tester backend absent et capacités refusées. Dépend de l'inventaire M0-08.

### M0-14 — Harnais et CI

**Code :** nouveaux tests d'intégration, scripts et `.github/workflows/`.

**Travail :** serveur MSP fixture à scénarios contrôlés et transport injectable ; démarrer l'app isolée avec stockage/dossiers temporaires. Séparer unitaires, UI simulée, intégration superviseur et live optionnel. CI sans credentials : build, Node, Rust, scénarios fixtures. Publier rapports/captures en cas d'échec, sans données utilisateur.

**État au 16/09/2026 :** `scripts/msp-fixture.mjs` est un serveur JSON-RPC déterministe lancé comme processus enfant par `test/msp-fixture.test.ts`. Les scénarios couvrent l'initialisation/catalogue/appel réussi, une notification `notifications/tools/list_changed` entrelacée, un refus d'outil, une requête gardée ouverte pour simuler un timeout et la fermeture stdout simulant une panne. Le test vérifie les octets réellement échangés avec le framing `Content-Length` et ne lit aucun fichier utilisateur ; il est inclus dans `npm test` et donc dans le job CI Node.

**État au 17/09/2026 :** les jobs CI frontend et Rust conservent désormais, uniquement en cas d'échec, un rapport borné (250/300 dernières lignes), après masquage des chemins du runner et des formes de secrets courantes. Les artefacts sont rétentionnés sept jours et ne contiennent ni workspace utilisateur ni transcript.

**Fondation d'injection livrée :** le transport MSP dépend maintenant d'une interface enfant minimale, avec adaptateur `CommandChild` en production. Les tests Rust conduisent la corrélation de requêtes, l'isolation A/B, les lanes par session et le réveil des appels en attente avec un enfant déterministe sans démarrer de moteur modèle. Cette frontière prépare le pilote de fixture du superviseur ; elle ne constitue pas encore le scénario Tauri complet.

**Pilote superviseur livré au 17/09/2026 :** `send_input_for_state` est partagé par la commande Tauri et les tests. Deux clients injectés sur des workspaces distincts valident le payload `turn/start`, les réponses hors ordre et l'isolation de l'état `running`; une écriture enfant en erreur reste bornée et ne marque pas de tour comme démarré. Le pilote reste sans provider modèle.

**Reste :** l'injection couvre maintenant la boucle `CommandEvent` réelle, y compris les chunks stdout partiels, les fragments finaux sans saut de ligne, les erreurs du shell et la fermeture du receiver qui réveille le client. Les handlers Tauri `send_input`, `approve` et `answer_input` sont également exercés via l'invoke mocké avec un état de session réel, y compris deux sessions partageant un identifiant d'approbation. Il reste à qualifier l'appel depuis une webview empaquetée et le scénario A/B natif avec approbations. Ces tests restent séparés d'un tour modèle réel.
**Flux Tauri A/B intégré :** un test d’invoke mocké envoie deux tours sur des sessions distinctes, reçoit les acquittements hors séquence, présente une autorisation identique dans les deux sessions, puis décide uniquement celle de A. La demande B et les deux états `running` restent intacts. Cette preuve ferme la course IPC côté superviseur ; elle ne remplace pas encore une webview empaquetée ni un host réel avec approbation.

**Fixture Muse approbation/reprise livrée (18/09/2026) :** `scripts/muse-fixture.mjs` reproduit le framing newline JSON-RPC du sidecar Muse et conserve un magasin durable en mémoire. `test/muse-fixture.test.ts` lance un processus enfant réel, vérifie `initialize` avec `sessionDurability: durable`, crée une session, suspend `turn/start` sur `approval/requested`, décide avec le `currentRequirementId` exact, puis observe `approval/resolved`, les items et `turn/completed`. Un second scénario relit le transcript par `session/read`, vérifie l’absence de doublons, reprend par `session/resume` et réénumère la session. Cette couche ferme le contrat déterministe des M0-01c/M0-02c sans prétendre à une preuve UI native ; la qualification du sidecar réel reste séparée.

**Pré-vol natif :** le smoke Windows partage désormais cette commande avec `--exercise-control` pour vérifier le contrôle `turn/start` → `turn/interrupt` sur deux hosts réels. Son rapport sépare l'accusé d'interruption d'une notification terminale ; `--exercise-terminal` rend cette dernière obligatoire pour un host qui la supporte. Son option `--exercise-errors` vérifie aussi les catégories `methodNotFound` et `invalidParams` sur les deux transports, sans exposer les trames brutes ; il ne remplace pas l'injection de panne dans le superviseur Tauri.

**Acceptation :** depuis un clone propre, `npm test` lance les fixtures MCP et Muse sans dépendance externe ; détecter volontairement une mauvaise route A/B et un envoi perdu dès que le pilote Tauri isolé est ajouté. Choisir le pilote Tauri selon support réel des plateformes, consigner toute limite dans l’ADR. La fixture Muse n’est validée que pour le contrat protocolaire ; elle ne clôt pas l’E2E webview/sidecar.

## M1 — Développement quotidien

### M1-01 — Statut et diff Git

**Code :** nouveau service Rust Git, nouveau panneau Review ; réutiliser seulement le style de la maquette, pas ses données. Dépend M0-01/14.

**Travail :** commande proposée `git_status(sessionId)` et `git_diff(sessionId, scope, baseRef?)`. Résoudre dépôt via workspace propriétaire, parser sorties sûres avec séparateurs NUL, restituer fichiers/hunks et révision observée. Scopes staged/unstaged/branch ; « dernier tour » exige un snapshot explicite, pas une supposition.

**Acceptation :** repo propre/sale, rename/delete/untracked/binaire/Unicode, hors Git, branche absente et modifications externes ; résultats comparés à Git réel.

### M1-02 — Commentaires de revue

**Code :** panneau Review, composer, nouveau modèle `ReviewAnchor`. Dépend M1-01.

**Travail :** ancre contenant repo, révision/base, chemin, côté et ligne/hunk. Transformer le commentaire en contexte explicite pour la conversation ; signaler une ancre devenue obsolète plutôt que la déplacer silencieusement.

**Acceptation :** commentaire transmis sur bonne ligne/côté ; fichier renommé ou diff modifié entre sélection et envoi ; aucune confusion entre deux dépôts.

**État au 17/09/2026 :** socle livré puis complété par une file de commentaires bornée et persistée par conversation (`muse-desktop.review-comments.v1.<sessionId>`). Une ancre identique met à jour le brouillon au lieu de dupliquer ; le panneau permet de sélectionner une note, l’envoyer seule, envoyer les notes prêtes en séquence, retirer une note ou vider les notes déjà envoyées. Chaque envoi relit le statut et le diff ; les notes dont l’ancre n’est plus observable passent à `stale` et restent récupérables jusqu’à suppression explicite. La suite native avec un moteur live et l’envoi collaboratif d’une forge restent à qualifier.

### M1-03 — Stage et revert

**Code :** service Git et Review. Dépend M1-01.

**Travail :** actions fichier puis hunk, avec version attendue du diff. Refuser si état disque/index a changé ; confirmation proportionnée pour discard. Ne pas utiliser reset --hard comme raccourci.

**État au 16/09/2026 :** stage, unstage et discard fichier sont livrés dans le service Git sessionné. `git_apply_hunk` extrait un hunk du patch observé et applique Stage, Unstage ou Discard partiel avec la même garde HEAD/statut/diff ; les fichiers binaires, non suivis et les patches tronqués sont refusés. Le panneau accepte aussi la sélection multiple de fichiers et applique une mutation groupée avec ces mêmes attentes ; les actions exigent l’observation du panneau et renvoient l’état actualisé. La qualification native reste à compléter.

**Acceptation :** staging partiel, hunk périmé, fichier utilisateur modifié entre deux clics, binaire et échec Git. Les modifications non ciblées restent intactes.

### M1-04 — Commit, push, PR

**Code :** service Git + adaptateur forge à créer, dialogues UI. Dépend M1-03/06 et environnement authentifié.

**Travail :** commit sur index réel, résultat/hash ; push sur remote/branche explicites ; détecter auth/rejet/hooks. Choisir intégration GitHub CLI ou API via ADR, credentials hors stockage web. Création PR retourne URL vérifiée ; pas de merge automatique.

**Acceptation :** dépôt test, hook échoué, rien à commiter, branche sans upstream, push rejeté et PR existante. Aucun push vers une autre branche par défaut implicite.

**État au 16/09/2026 :** commit, push et création de PR GitHub sont câblés dans le service Git sessionné. Le commit est protégé par l'observation de l'index ; le push utilise un refspec explicite et `gh pr create` réutilise l'authentification locale sans credential web. Les hooks/auth live, rejets distants, PR existantes et qualification native restent à couvrir avec un dépôt de test contrôlé.

**Ajout au 17/09/2026 :** la synchronisation du dépôt est désormais disponible dans la même source de vérité Review. **Fetch** exécute un remote explicite sans pruning et remonte le statut actualisé. **Pull latest** exige un remote et une branche explicites, vérifie HEAD et l'empreinte complète du statut observé, refuse les worktrees sales et limite l'opération à `git pull --ff-only`; les divergences et conflits restent donc à résoudre explicitement. Les tests Rust couvrent remote absent, observation périmée, worktree sale et un fast-forward local réel.

**Ajout au 17/09/2026 — PR idempotente :** avant de créer une PR, le service consulte `gh pr list` avec le couple base/head et l'état `open`. Une URL existante est renvoyée avec `existing: true`, ce qui rend le bouton réentrant et évite les erreurs ou doublons lors d'un second clic. Le parseur refuse les réponses JSON invalides et les URL non HTTP(S) ; la forge reste l'autorité pour les cas d'authentification et de rejet.

### M1-05 — Terminal PTY

**Code :** nouveau service PTY Rust et panneau Terminal. Dépend M0-01/14.

**Travail :** contrats create/write/resize/close avec `terminalId`, session, cwd, shell et génération. Sortie bornée, fermeture contrôlée, processus indépendants de l'onglet. Choisir bibliothèque PTY compatible avec les OS annoncés ; ne pas confondre command runner et terminal interactif.

**Acceptation :** saisie interactive, ANSI, resize, serveur long, changement de vue, fermeture/restart et Unicode ; pas de processus orphelin.

**État au 16/09/2026 :** socle livré dans la PR M1-05. `portable-pty` fournit un shell natif Windows/Unix dans un registre Rust persistant ; le panneau Terminal ouvre/réutilise le terminal de la conversation, draine une sortie bornée, écrit l’entrée, redimensionne et ferme explicitement le processus. La vue traduit désormais les styles ANSI SGR usuels et avancés (16/256/24 bits, gras, atténué, italique, souligné, barré, inversion) sans interpréter le contenu comme HTML ; les raccourcis Ctrl+C/Ctrl+D/Ctrl+L/Tab/Échap sont transmis au PTY. La validation native interactive reste à exécuter séparément.

### M1-06 — Terminal comme contexte

**Code :** PTY, adaptateur outils/contexte. Dépend M1-05 et capacité moteur vérifiée.

**Travail :** lecture d'un snapshot borné avec identifiant, cwd et offset ; exposer au moteur via outil réel ou insertion explicitement étiquetée. Ne pas envoyer l'historique entier à chaque tour.

**Acceptation :** commande de build en échec, sortie disponible au bon agent ; terminal B inaccessible par confusion de cible ; capture non bloquante.

**État au 18/09/2026 :** **Add output to prompt** reste le fallback manuel borné et attribué. Le handshake demande maintenant explicitement la capability `userShell`; lorsqu'elle est accordée, **Run in Muse** envoie `session/userShell` avec un `commandId` UUIDv7 et le host est prêt à restituer la commande et sa sortie dans une entrée tool du transcript. Le bridge accepte aussi un `item/completed`/`item/updated` complet sans delta : il recrée la lane appropriée, injecte une seule fois `visibleOutput`/`summary`/`text`, puis ferme l'item par son identifiant. Les références `outputRef` des items sont maintenant conservées dans l'historique ; **Load full output** appelle `item/readOutput` par blocs de 64 KiB avec offset borné et permet de charger la suite sans persister le contenu dans le journal. La réconciliation d'historique conserve désormais `$ commande` avec la sortie pour les items `userShell`. Le smoke Windows `--exercise-user-shell` vérifie le grant et l'admission sur deux sessions, mais le sidecar 1.3.0 testé n'émet pas d'item transcript sur cette connexion minimale ; la restitution UI reste donc une preuve manquante. Un host sans grant garde l'action désactivée et l'insertion manuelle disponible. Reste la qualification native sur les trois OS, les sorties longues et l'interruption d'une commande.

### M1-07 — Fichiers réels

**Code :** nouveau service fichiers, panneau Files, `ArtifactsPane`, scope. Dépend M0-06.

**Travail :** listing paresseux, read borné, détection binaire, ouverture externe/preview et handoff explicite de l'aperçu texte vers le composer ; symlinks et racines autorisées. Distinguer fichier du disque et extrait de réponse. Watcher ou rafraîchissement explicite avec état obsolète.

**Acceptation :** gros dépôt, fichier disparu/renommé, hors scope et fichier volumineux ; afficher le contenu réellement sur disque sans bloquer l'UI.

**État au 17/09/2026 :** tranche locale livrée sur `feat/m1-real-files` : commandes sessionnées `files_list`/`file_read`, garde de racine et de symlink, bornage listing/lecture, détection binaire et aperçus image/PDF dans l’onglet **Files**. L'onglet relit périodiquement le dossier courant et affiche l'heure du snapshot. Le bouton **Open in app** appelle `file_open(sessionId, path)` ; Rust recanonicalise l'entrée et ne délègue au handler système par défaut qu'un fichier ou dossier prouvé dans le workspace. `workspace_watch` ajoute maintenant un watcher natif par session, limité aux chemins relatifs, qui marque la vue obsolète sans lire le contenu ni rafraîchir silencieusement le transcript ; l'utilisateur confirme le nouveau snapshot avec **Refresh**. **Add to prompt** réutilise ensuite l'aperçu texte borné avec son chemin, sa taille et son horodatage d'observation via la SSOT du hook. La qualification E2E multi-plateforme, les gros dépôts, renommages, racines supprimées et formats riches restent ouverts.

### M1-08 — Pièces jointes

**Code :** Composer, `mentions.ts`, service fichiers, adaptation TurnInputPart. Dépend M1-07 et de la vérification des capacités moteur M0-08.

**État au 17/09/2026 :** les images attachées détectent leurs dimensions via l'API `Image` quand elle est disponible, les affichent dans le chip du composer avec une miniature locale, puis les transmettent comme champs optionnels du part MSP. Le fallback sans DOM conserve le payload précédent. Les brouillons d'attachements sont restaurés dans la session de la webview : les payloads bornés restent réutilisables, tandis que les grosses pièces gardent leurs métadonnées et exposent **Reselect** avant l'envoi. La qualification live sur modèles image reste ouverte.

**Travail :** définir référence structurée type/MIME/taille/nom/source, drag/drop/coller image, suppression avant envoi, limites et erreurs. Employer le format accepté par Muse ; si non supporté, afficher l'indisponibilité, pas un faux nom de fichier dans le prompt.

**Acceptation :** image réellement reçue, fichier texte, limite dépassée, fichier supprimé, annulation et retry sans pièce jointe orpheline.

**État au 16/09/2026 :** contrat stable vérifié depuis le binaire embarqué (`TurnInputPart` = `text|image|skill`). Le composeur envoie les fichiers texte et images via des parts structurées, avec ingestion sélecteur/glisser-déposer/coller, bornes et suppression avant envoi ; l’outbox conserve le payload exact pour les retries. La persistance de session des brouillons est livrée avec une borne et une re-sélection explicite des gros payloads. Les essais live par modèle image et la qualification native restent ouvertes.

### M1-09 — Fork serveur

**Code :** sessions, actions conversation, MSP session/fork. Dépend M0-02/08.

**Travail :** choix du point de départ parmi les ancres supportées ; retourner le nouvel ID serveur, conserver provenance et workspace ; importer son historique sans partager les brouillons.

**Acceptation :** branche indépendante, source inchangée, point invalide, source active et échec ; ne jamais substituer un résumé au fork demandé.

**État au 18/09/2026 :** `session/fork` est câblé dans le superviseur et l’action d’en-tête crée une nouvelle conversation serveur dans le même workspace, avec continuité locale des entrées terminées. Les items conservent maintenant leur `turnId` et les messages terminés proposent **Fork from here**, transmis comme `cutPoint.lastTurnId`; le bouton d’en-tête reste le raccourci vers le dernier tour terminé. Une ancre devenue indisponible produit maintenant une guidance récupérable vers le fork du dernier tour, sans retry implicite sur un autre point. La qualification live et la reprise après rechargement restent ouvertes.

### M1-12 — Recherche et organisation

**État au 18/09/2026 :** la recherche parcourt les métadonnées et les journaux locaux avec extrait contextualisé ; les conversations peuvent être épinglées, réordonnées dans leur niveau et marquées non lues, avec conservation au redémarrage. Le renommage met à jour immédiatement la projection locale et tente `session/rename` côté host avec un nom borné à 120 caractères, sans bloquer un sidecar ancien qui ne connaît pas encore ce RPC. La virtualisation des très longues listes reste ouverte après mesure.

### M1-10 — Steering et file de messages

**Code :** Composer, `phase.ts`, sessions/MSP. Dépend M0-03/04/08.

**Travail :** mapper les possibilités réelles turn/steer, cancel et unqueue ; modèle de message en attente avec état/order/cible. Distinguer envoyer après le tour et guider le tour courant ; actions d'annulation stables.

**Acceptation :** deux messages en attente, suppression du second, fin simultanée du tour, refus serveur et reboot ; ordre vérifié dans le moteur.

**État au 18/09/2026 :** l'ordre des tours admis est persisté sous `muse-desktop.queued-turns.v1`. Une restauration les marque à vérifier et permet de retirer le rappel local sans les rejouer. Quand `session/read` sert réellement `history.snapshot.queuedTurns`, le hook réconcilie cette liste, conserve les textes locaux connus et signale les identifiants nouveaux à vérifier ; une réponse inline ou absente laisse la file locale intacte. Le smoke Windows `--exercise-queue` admet deux tours synthétiques sur chacune de deux sessions, observe `disposition: queued` sur le second et confirme `turn/unqueue` accepté ; cette preuve transport ne remplace pas encore la course UI, le redémarrage et le snapshot durable. L'admission host reste la seule source de vérité jusqu'à cette observation.

### M1-11 — Modèles et compaction

**Code :** SettingsPanel, CompactBar, RPC existantes. Dépend M0-08.

**Travail :** conserver catalogue live et fallback séparés ; confirmer le modèle effectif après changement ; persister le choix à la bonne portée. Compaction : afficher admission/progression/résultat et distinguer résumé local/contexte serveur.

**Acceptation :** modèle indisponible, changement entre sessions, compaction no-op/run-active/échec ; contexte et choix reflètent le serveur.

**État au 18/09/2026 :** `model/list`, `session/setModel`, `session/setReasoningEffort` et `session/compact` sont raccordés au host avec un fallback non live clairement séparé. Le réglage d'effort (`none` à `ultra`) est une propriété SSOT des réglages globaux/projet, visible dans la zone de saisie des nouvelles conversations et des conversations existantes. Le hook applique la valeur à la création d'une session normale ou worktree et lors d'un changement en cours de conversation ; les valeurs persistées anciennes sont normalisées vers `high`. La dernière demande de modèle est aussi conservée dans `StoredSession.model_id`, puis réutilisée par Settings/Composer si le host n'expose pas de ligne `isActive`, sans la présenter comme une confirmation native. Un fork réapplique maintenant ce modèle au nouveau host avant de rendre la branche active. La barre de contexte reçoit désormais aussi `session/tokenUsage` et affiche les compteurs par tour fournis par le moteur, sans les dériver. La barre de compaction expose aussi l'état SSOT renderer de la demande serveur (`pending`, `accepted`, `noop`, `error`) et bloque les doubles appels pendant l'admission. Le smoke Windows `--exercise-reasoning` applique `none`, `high` et `ultra` sur deux sessions éphémères et vérifie l'acceptation ; le sidecar testé ne renvoie pas de projection effective et le rapport le marque `not-reported`. `--exercise-model` envoie également `session/setModel` puis relit `model/list` : l'accusé est accepté, mais `isActive: false` sur le binaire testé, donc l'effectif reste non prouvé. `--exercise-compaction` appelle `session/compact` sur deux sessions vierges ; le sidecar répond `missing-run`, ce qui confirme le refus borné sans prétendre avoir compacté un historique. La confirmation native du modèle et de l'effort effectifs, les modèles indisponibles et la compaction live sur un thread avec historique restent à qualifier.

### M1-12 — Recherche et organisation

**Code :** sidebar, recherche App, `threads.ts`, stockage. Dépend M0-09/12.

**Travail :** index de recherche locale sur historique, pagination et extraits ; épinglage et ordre explicites ; non-lus distincts de running. Migration du tri existant sans perdre dates/titres. La restauration native parcourt aussi `session/list` par curseur opaque (200 éléments par page, 20 pages bornées) avant le filtrage d'appartenance. La première tranche fournit recherche, épinglage, ordre et non-lus ; la virtualisation concerne le transcript M1-13, tandis que la sidebar reste conditionnée à une mesure.

**Acceptation :** recherche accentuée/multilingue, archive, suppression, gros historique, clavier et restart ; aucune session supprimée réindexée.

### M1-13 — Lecture longue

**Code :** StreamView/MessageContent, blocs et CSS. Dépend M0-14.

**Travail :** mesurer temps de rendu/mémoire/scroll sur fixture longue. Le transcript applique `content-visibility: auto`, une taille intrinsèque de secours et un scroll instantané pendant le streaming ; au-delà de 600 entrées, une fenêtre de 160 messages charge les 120 précédents à la demande avec compensation de hauteur et espaces virtuels haut/bas qui représentent les entrées hors DOM dans la scrollbar. La position de lecture et l’index de fenêtre sont conservés par conversation afin qu'un changement de fil ne fasse pas perdre le contexte. Exposer un compteur d’entrées stable pour les mesures UI natives. Liens/code/outils accessibles, état « nouveaux messages » sans saut si l'utilisateur lit plus haut. **Find in conversation** fournit un finder local borné, accessible par bouton ou `Ctrl/Cmd+F`, recherche dans le journal complet et replace la fenêtre sur un résultat hors DOM. La recherche native du navigateur reste limitée à la fenêtre DOM chargée.

**État au 18/09/2026 :** le finder accepte maintenant les flèches haut/bas pour parcourir les résultats, Entrée pour ouvrir le résultat actif et expose la sélection via `listbox/option` et `aria-activedescendant`. La sélection reste bornée et cyclique, y compris quand la fenêtre DOM ne contient pas le message ciblé. La fenêtre expose aussi la position globale de chaque entrée (`article`, `aria-posinset`, `aria-setsize`), une annonce live de sa plage visible et une navigation clavier focalisable (`Home`, `End`, `PageUp`, `PageDown`) afin qu’un lecteur d’écran ou un utilisateur clavier ne pense pas que les 160 nœuds montés constituent tout l’historique. Des espaces virtuels calculés par `streamWindowPadding` maintiennent une hauteur de scroll proportionnelle sans ajouter de faux éléments à l’arbre d’accessibilité ; les blocs montés alimentent maintenant ces espaces par mesure `ResizeObserver`, avec compensation de l’ancre quand une hauteur se précise. Les cibles de scroll sont calculées par `src/lib/streamNavigation.ts` et couvertes par tests purs ; reste la mesure native sur 2 000 entrées et la qualification assistive en webview empaquetée.

**Acceptation :** streaming entrelacé, sélection/copie, blocs volumineux, retour bas de page et thème ; fixer les budgets mesurés dans la PR.

## M2 — Environnements isolés

### M2-01 — Racines de projet

**Code :** `projects.ts`, ProjectsPanel, persistance et backend workspace. Dépend M0-09.

**État :** Câblé côté modèle et UI locale. `Project.workspace` reste la racine primaire de compatibilité et `Project.workspaces` porte les racines supplémentaires ; les valeurs sont nettoyées et dédoublonnées avant persistance. Le panneau Projects fournit le sélecteur natif multi-dossiers, l’édition et la remise à zéro des racines. `New conversation here` réutilise le chemin `start_session` du hook et demande explicitement la racine de départ.

**Tranche ajoutée :** l’écran d’une nouvelle conversation projette chaque racine disponible dans un sélecteur d’environnement avec une valeur stable `projectId:rootIndex`. Le choix transmet exactement le workspace et les réglages du projet à `start_session`, puis rattache la session créée au projet dans la même transition. La projection `projectWorkspaceOptions` reste dans `projects.ts` afin d’éviter une seconde règle de filtrage côté UI ; les projets sans racine ne sont jamais proposés.

**Livré :** `projectsNeedingWorkspace` définit les anciens projets sans racine exploitable ni marqueur de choix. Les projets créés ou édités maintenant portent `workspaceReviewed`; Projects affiche une notice de migration bornée et ouvre le sélecteur natif. **Check folder** appelle `inspect_workspace_root`, une observation native non mutante qui distingue dossier disponible, chemin fichier et dossier manquant. `updateProject` conserve le champ primaire historique et écrit les racines supplémentaires sous `workspaces`, sans déduction depuis le nom ni modification des conversations existantes.

**Reste :** qualification multi-plateforme de la sonde et admission atomique d’un environnement/worktree géré. Ne jamais déduire un dossier depuis le nom du projet.

**Acceptation :** projet multi-dossiers, dossier déplacé, ancien groupe sans racine et nouvelle conversation dans le bon workspace.

### M2-02 — Configuration héritée

**Code :** projets/settings/skills/connectors, configuration host. Dépend M2-01/M0-06.

**État :** héritage global → projet visible via le helper SSOT `settingsForThread`, avec diff d’override et contexte de la conversation. Le modèle effectif est appliqué à la nouvelle session après `session/start` via `session/setModel`; la valeur `default` conserve le choix du moteur. Le compactage automatique local respecte maintenant la valeur `autoCompact` effective par conversation. La préférence d'isolation globale et les overrides projet `sandbox`/`networkDefault` sont maintenant projetés au lancement du host selon le contrat `muse serve --help` : réseau restreint ou activé, `--disable-sandbox` pour l'élévation autorisée, et `--disable-write`/`--disable-shell` en read-only. **Restart workspace host** remplace explicitement le processus avec la posture sélectionnée, détache les conversations et efface les autorisations volatiles ; les transcripts renderer restent disponibles et une reconnexion durable reste explicite. Un host déjà vivant conserve donc sa posture tant que l’utilisateur n’a pas demandé ce redémarrage ; depuis le 18/09, le bridge refuse explicitement une nouvelle posture divergente avec une indication de redémarrage, afin qu'aucun projet ne croie qu'une restriction a été ignorée silencieusement ; l'en-tête et Settings rendent cette limite explicite.

**Reste :** qualifier nativement deux projets utilisant des hosts distincts et vérifier la reconnexion durable après un redémarrage ; aucun host ne permet encore de muter cette posture pendant sa durée de vie, donc le bouton de Settings assume explicitement le remplacement du processus.

**Acceptation :** deux projets aux réglages différents, suppression override, redémarrage et host déjà actif ; afficher ce qui est effectivement appliqué.

### M2-03 — Worktree géré

**Code :** remplacer helper `worktrees.ts` par service Rust Git ; nouvelles actions de création. Dépend M2-01/M1-01/M0-01.

**État :** le service Rust `git_worktree_create` crée un checkout réel sous `.muse/worktrees/` depuis une base et une branche explicites. Le panneau d’orchestration garde le plan manuel, ajoute une action par agent et reçoit le chemin canonique retourné ; les segments issus des identités sont nettoyés et dédoublonnés. Les records sont persistés sous `muse-desktop.worktrees.v1` et peuvent être supprimés après confirmation via `git_worktree_remove` avec garde de confinement. L'action **Create & open** appelle maintenant une commande native unique qui crée le checkout puis démarre la conversation enracinée dedans ; si l'admission échoue, le backend tente le rollback du checkout avant de rendre l'erreur.

**Reste :** qualifier sur chaque plateforme les pannes après admission et les erreurs Git externes. Le host MSP actuel étant lié à un workspace à la fois, ne pas basculer automatiquement une conversation existante tant que ce cycle n’est pas conçu.

**Acceptation :** deux créations simultanées, branche absente, espace disque, échec partiel ; checkout de départ inchangé.

### M2-04 — Setup d'environnement

**Code :** nouveau modèle LocalEnvironment, PTY/runner et worktrees. Dépend M2-03/M1-05.

**État :** une commande saisie par l'utilisateur peut être lancée explicitement dans un worktree géré déjà créé. Le runner Rust valide le confinement, borne la commande et la sortie, neutralise stdin, expose les états `ready/failed/timedOut/cancelled`, conserve la durée, le code de sortie et les clés d'environnement retenues, puis permet une relance ou une annulation ciblée depuis le panneau d'orchestration. Les profils nommés sont persistés par workspace avec des noms d'environnement supplémentaires ; aucun setup importé n'est exécuté au démarrage. **Check readiness** ajoute une pré-vérification en lecture seule des manifests et des exécutables requis (`ready`, `blocked`, `needsSetup`) sans lancer de code projet.

**État au 18/09/2026 :** le bouton **Setup & open** compose maintenant les opérations existantes dans un parcours explicite : création du checkout, exécution bornée de la commande avec l'allowlist d'environnement, puis admission de la conversation dans le chemin normal `start_session`. Après la création, **Cancel setup & open** réutilise l'identifiant d'opération natif pour interrompre le setup ; le checkout nouvellement créé est ensuite supprimé comme pour un échec. Si le setup échoue ou si l'admission est refusée, le checkout nouvellement créé est supprimé avant de rendre la main ; une intention de nettoyage reste visible si Git refuse la suppression. Le bouton séparé **Create & open** reste disponible quand aucun setup n'est demandé. L'allowlist ne persiste jamais de valeurs et conserve la commande explicite et la SSOT du hook de sessions.

**Reste :** qualification native des pannes et annulation pendant ce parcours composite ; les effets internes d'une commande de setup ne peuvent pas être annulés, seul le checkout est retiré après échec.

**Acceptation :** dépendances installées dans le bon worktree, setup échoué/cancelled et retry ; aucun premier tour annoncé prêt prématurément.

### M2-05 — Handoff

**Code :** services Git/hosts/projets, dialogue dédié. Dépend M2-03/04 et M1-03.

**État :** le panneau d’orchestration propose un plan de handoff local et en lecture seule pour chaque worktree créé, avec un sélecteur explicite **Local → Worktree** ou **Worktree → Local**. Les préconditions source/cible sont évaluées avec les statuts `pass/warn/blocked` : workspace et cible, conflits, changements non commités, état Git cible observé et branche déjà utilisée. L’inspection alimente maintenant directement la propreté et le verrou de branche du plan ; un snapshot SSOT compare les entrées capturées à l’état courant et affiche **refresh required** dès qu’une inspection ou un changement Git le rend obsolète. Un plan frais et sans blocage propose **Open with handoff context** : une nouvelle conversation est ouverte dans le worktree choisi et reçoit une note bornée dans le composer, sans prétendre avoir déplacé la session MSP. Le plan propose ensuite les étapes d’observation, snapshot et transfert sans déclencher de bascule automatique.

**Reste :** transfert atomique du host MSP, déplacement du contexte, verrou de processus et rollback explicite. Les fichiers ignorés sont maintenant comptés par l'inspection du worktree et maintenus comme avertissement dans le plan ; leurs chemins et contenus ne sont pas transférés. Tant que le host reste mono-workspace, aucun bouton ne doit présenter une conversation comme transférée avant confirmation native.

**Acceptation :** aller/retour Local ↔ Worktree avec fichiers suivis/non suivis ; conflit volontaire et échec intermédiaire sans perte.

### M2-06 — Rétention et nettoyage

**Code :** worktree store, archive, service Git. Dépend M2-03/05.

**État :** le panneau expose **Inspect** pour relire le statut Git d'un checkout géré (branche, changements, conflits, fichiers ignorés et horodatage). **Inspect all** relit en parallèle les worktrees créés et affiche un résumé borné des cibles inspectées, propres, modifiées ou en conflit, tout en conservant le détail par branche. Le service Rust compte les fichiers ignorés sans transmettre leurs chemins au renderer, afin qu'un artefact de setup masqué reste visible comme signal de revue. Une politique durable par dépôt propose de conserver indéfiniment le checkout ou de le marquer éligible après 7, 14, 30 ou 90 jours ; seuls les worktrees inspectés et propres deviennent éligibles. La suppression reste distincte de l'archivage d'une conversation, exige une confirmation et le service Rust refuse tout worktree sale avant `git worktree remove`. Chaque tentative est conservée dans `muse-desktop.worktree-cleanup.v1` ; après échec ou fermeture, le record reste visible avec le nombre d'essais, l'erreur bornée et une action **Retry cleanup** explicite.

**Reste :** qualification des processus externes non représentés par les marqueurs Git. Ne jamais transformer un record archivé en suppression implicite ni relancer automatiquement une intention persistée.

**Acceptation :** worktree propre nettoyé, sale conservé, cible hors racine refusée, interruption du nettoyage récupérable.

### M2-07 — Sous-agents live

**Code :** subagent.ts, panels, RPC existantes. Dépend M0-01/05/08.

**Travail :** vérifier la table d'identités parent/agent/enfant ; état demandé vs confirmé ; contrôle followup/stop/resume et drilldown avec pagination disponible. Conserver résultat d'un enfant terminé.

**État au 18/09/2026 :** les événements `subagent_event` normalisent les alias de cycle de vie fournis par le host (`queued`, `running`, `completed`, `interrupted`, `stopped`, `paused`, `failed`, état inconnu) et les stockent dans le transcript. Les notifications `item/started`, `item/delta`, `item/updated` et `item/completed` d'un sous-agent sont conservées dans cette lane avec leur `itemId`; un snapshot complet remplace le texte précédent selon sa révision au lieu de concaténer des doublons. Le bloc affiche un badge d'état, se ferme sur une terminaison confirmée, désactive interrupt/stop pour un agent terminé et ne rend resume disponible que pour un agent interrompu, arrêté ou en pause. Un événement d'état sans texte reste lisible sans exposer le JSON brut. La qualification native de deux agents entrelacés et la preuve de reprise après perte du host restent à faire.

**Acceptation :** deux enfants entrelacés, action sur terminé, host perdu, résultat volumineux ; commande sur A ne touche jamais B.

### M2-08 — Writers concurrents

**Code :** fanout.ts, orchestration, worktrees. Dépend M2-03/07.

**État :** le panneau d’orchestration expose un pré-vol par writer : chemins relatifs déclarés, normalisation bornée, refus des traversées et détection des recouvrements (fichier ou sous-dossier). Les déclarations sont persistées par workspace dans `muse-desktop.writer-targets.v1`, avec bornage des workspaces, agents et texte, puis restaurées au changement de dépôt sans fuite entre racines. Un writer sans worktree ou sans cible ne peut pas être marqué prêt. Les writers sans collision reçoivent des lanes déterministes (`cores - 2`, borné 4–8) et les suivants sont représentés en file FIFO dans `src/lib/writerQueue.ts` ; le calcul reste pur et partage l’ordre du fan-out. Une ligne admise peut maintenant construire un prompt borné dans `src/lib/writerDispatch.ts`, ouvrir/réutiliser la conversation du worktree, envoyer via `sendInput`, revenir à la conversation parente et exposer l’état du writer avec arrêt et ouverture du transcript.
**Reste :** le protocole MSP ne fournit pas encore de verrouillage de fichiers, de résultat writer structuré ni d’annulation atomique confirmée. Le panneau calcule désormais, à la fin d'une session inactive, un résumé extractif local du journal (compteurs, dernière sortie assistant et erreurs structurées) ; il est étiqueté comme observation et ne remplace pas la collecte native. Garder le dispatch sur le chemin normal start/send tant que le contrat natif n’est pas vérifié ; ajouter ensuite les locks host, l'annulation atomique et la collecte de résultat native avec une intégration séparée des changements.

**Acceptation :** deux writers modifient le même nom de fichier dans deux checkouts ; aucun overwrite ; limites et annulation correspondent aux états réels.

## M3 — Outils et exécution planifiée

### M3-01 — MCP local

**Code :** ConnectorPanel/connectors.ts, nouvel adaptateur runtime. Dépend M0-06/08/14.

**État :** `mcp_local_probe` et `mcp_local_call` lancent une commande locale uniquement sur geste utilisateur, parlent le framing MCP stdio (`Content-Length` ou ligne JSON), exécutent `initialize` + `notifications/initialized`, puis `tools/list` ou `tools/call`. La réponse est bornée et l'UI expose les outils/arguments/résultat. Le runtime propose désormais `mcp_local_start`, `mcp_local_refresh`, `mcp_local_poll`, `mcp_local_call_persistent` et `mcp_local_stop` : un processus reste vivant par connecteur jusqu'à Stop ou fermeture de l'app, les réponses sont corrélées par id, et un `notifications/tools/list_changed` déclenche un `tools/list` automatique via le polling léger du hook. Extensions expose aussi **Reconnect with current connectors** pour réappliquer explicitement la configuration MCP à la conversation active via `session/resume`, avec la même SSOT que les nouveaux démarrages ; le bouton est masqué pour le preview web et les sessions éphémères.

**Reste :** brancher les tools découverts au catalogue observé par Muse et faire confirmer cette garde par la politique d'autorisation du host à chaque appel. La reconfiguration explicite est livrée, mais elle dépend encore d'un host durable qui accepte la configuration lors de `session/resume`. La UI applique la posture globale localement : Ask demande une approbation ponctuelle, Workspace garde les appels distants derrière une confirmation, et YOLO permet l'appel direct.

**Acceptation :** serveur fixture expose puis exécute un outil, redémarre, change sa liste et échoue ; appel observé dans une session Muse.

### M3-02 — MCP distant

**Code :** transport/auth dédiés et stockage sécurisé. Dépend M3-01.

**Travail :** ADR transports supportés, OAuth/tokens et règles réseau. Connexion/refresh/révocation, expiration, reconnexion et isolation des comptes ; ne pas conserver secrets dans le registre frontend.

**État au 17/09/2026 :** `src/lib/remoteMcp.ts` implémente le transport streamable HTTP/SSE avec `initialize`, `notifications/initialized`, `tools/list` et `tools/call`, corrélation JSON-RPC, `Mcp-Session-Id`, timeout borné et messages d'erreur pour les réponses 401/403, HTTP et JSON invalides. `ConnectorPanel` exige une action **Connect and list tools**, affiche le catalogue réellement reçu, propose **Reconnect** après une perte de session et garde le bearer token dans une référence mémoire du hook ; `connectors.ts` ne persiste que l'URL et la dernière révision vérifiée. Le bridge Tauri expose maintenant `secure_store_set/get/remove` sur le gestionnaire de credentials natif ; les reconnexions explicites peuvent relire le token sans l'ajouter au stockage web et la suppression du connecteur supprime sa copie native. Depuis la passe M3-02, une entrée distante connectée expose aussi **Use in Muse** : `hostMcp.ts` injecte alors une configuration `streamableHttp` optionnelle dans les nouveaux démarrages, reprises à froid et worktrees, avec le bearer transmis uniquement depuis la session mémoire. Six tests dédiés couvrent JSON, SSE, session, refus réseau/auth, id incohérent, exclusion d'un distant sans session et clés de credentials stables.

**Reste :** OAuth/refresh fournisseur, test réseau sur chaque OS et catalogue d'outils distant côté host Muse. La configuration d'une session active est maintenant réappliquée uniquement après l'action explicite **Reconnect with current connectors** ; un host qui refuse la configuration au resume conserve son état précédent et remonte l'erreur de reconnexion. La reconnexion automatique est limitée aux 401/403 : elle refait un handshake avec le bearer conservé en mémoire et rejoue un seul appel ; une relance de l'application exige toujours une reconnexion explicite, qui peut relire le bearer du secret-store natif.

**Acceptation :** serveur réel de test, token expiré, refus réseau et déconnexion ; statut UI confirmé par échange effectif.

### M3-03 — Cycle de vie extension

**Code :** ConnectorPanel/registry/runtime. Dépend M3-01/02.

**État :** un probe local réussi peut enregistrer la commande, la version serveur et les outils découverts dans le registre persistant. Une nouvelle liste remplace l'entrée existante sans réactiver une extension désactivée ; `listConnectorTools` retire immédiatement ses outils lorsque le statut passe à `disabled`. Les connecteurs locaux enregistrés peuvent être démarrés, arrêtés et rafraîchis explicitement depuis le panneau ; un échec ou une liste vide ne remplace pas la dernière version utilisable, et `tools/list_changed` déclenche le même rafraîchissement via le chemin SSOT. Une copie de la précédente révision est conservée pour un rollback explicite, une seule étape. Les connecteurs vérifiés locaux ou distants conservent maintenant un opt-in **Use in Muse**, réutilisé par les rafraîchissements de catalogue avant injection au démarrage d'une conversation.

**Livré le 17/09/2026 :** un fichier `.mcpb` est parsé et borné côté renderer (manifest, semver, runtime Node/Python, entry point, arguments et chemins), puis transmis comme liste de fichiers base64 au bridge Tauri. Le bridge installe chaque révision sous `app_data/mcp-packages/<id>/<version>` avec écriture par staging et commit atomique ; aucune version existante n'est écrasée. Le serveur est sondé par le vrai handshake MCP avant l'enregistrement. Le registre conserve source, nom de fichier, version, runtime et chemin d'installation ; une mise à jour arrête explicitement l'ancien runtime, remplace la commande et conserve sa révision précédente pour **Roll back**. Un échec de validation/probe nettoie la révision nouvelle et laisse l'ancienne entrée intacte. La suppression retire aussi la révision active quand le runtime natif est disponible.

**Reste :** arrêt pendant appel et catalogue des outils réellement visibles par le moteur Muse ; l'autorité de permission par appel reste à confirmer côté host, la garde UI étant maintenant explicite. Les bundles sont installés localement depuis un fichier choisi par l'utilisateur ; distribution distante, signature et mise à jour automatique relèvent de M4-09.

**Acceptation :** installation ratée, mise à jour incompatible, désactivation pendant appel et suppression ; registre et runtime cohérents.

### M3-04 — Découverte SKILL.md

**Code :** skills.ts/SkillPanel, nouveau scanner natif. Dépend M2-01/M0-06.

**Travail :** définir scopes et précédence, parseur des métadonnées, chemins des ressources, déduplication et rechargement. Une ressource relative reste liée au dossier de la skill ; lecture bornée et erreurs visibles.

**État au 16/09/2026 :** `skills_scan` lit les racines conventionnelles du workspace avec bornage de profondeur, taille et nombre de documents. Le parseur frontmatter, la validation des ressources relatives, la priorité projet > repo > équipe > builtin et le rafraîchissement explicite sont livrés ; le panneau affiche provenance et erreurs. Les resources ne sont pas encore chargées dans le contexte moteur, ce qui reste M3-05.

**Acceptation :** skills homonymes, fichier malformé, ressource manquante, scope projet et modification sur disque ; provenance exacte.

### M3-05 — Invocation skill

**Code :** Composer, resolver skills et adaptateur moteur. Dépend M3-04/M0-08.

**Travail :** invocation explicite, chargement des instructions et ressources via contrat moteur ; progression/découverte avec trace compréhensible. Les suggestions ne doivent pas prétendre exécuter une skill. L'état de progression reste éphémère et doit rester dérivé du hook de session, tandis que les événements du host font foi pour le démarrage et la fin.

**État au 17/09/2026 :** une invocation slash d'une skill découverte relit ses ressources relatives juste avant l'envoi via `skills_read_resources`. Les contenus sont bornés, balisés avec leur chemin, et un fichier disparu fait échouer l'envoi avec une entrée système explicite ; les retries réutilisent l'expansion de l'outbox. Une skill hôte vérifiée est envoyée comme part native `skill`; le hook expose maintenant `preparing`, `loading-resources`, `sending`, `queued`, `running`, `completed`, `failed` et `unknown` par conversation. Extensions annonce l'étape et le détail sans persister cet état. Les ressources natives supplémentaires, le contrat d'invocation détaillé côté host et la qualification live restent à confirmer.

**Acceptation :** invocation réelle avec ressource, skill supprimée entre suggestion et envoi, permission refusée ; pas de double insertion au retry.

### M3-06 — Scheduler réel

**Code :** schedules.ts/SchedulesPanel, nouveau service de scheduling hors cycle React. Dépend M0-09/M2-01 ; M2-03 pour worktree.

**Travail :** séparer Schedule et Run ; capturer projet/workspace/modèle/skills/politique, jamais « session active au moment du tick ». Occurrence crée un run durable puis exécute ; l'inbox contient le résultat, pas une demande de cliquer avant chaque run.

**État au 18/09/2026 :** `Schedule` et `ReviewItem` capturent désormais workspace, projet, modèle et politique d'autorisation au moment de la création. L'approbation vérifie le workspace et le projet de la conversation cible, résout les réglages projet capturés via la même fonction d'héritage que l'UI, puis réapplique le modèle/politique avant l'envoi ; un mismatch est refusé explicitement. Les modes workspace et YOLO dispatchent maintenant sans clic et alimentent un journal local borné `ScheduleRun`, visible dans Automations. Une fin de tour structurée marque le run `completed` ou `failed`, conserve l'aperçu assistant et envoie les erreurs réessayables dans le retry borné de M3-07 ; l'interface expose aussi le prochain déclenchement calculé depuis le curseur cron/fuseau partagé avec le dispatcher. Un arrêt du host reste un échec non réessayé car son issue est ambiguë. Le scheduler natif multi-instance, la reprise après crash/sommeil et la sortie métier riche restent à implémenter.

**Acceptation :** one-shot/récurrent, cible fixe malgré navigation, échec de démarrage, dispatch automatique selon la politique et historique local ; le run reste explicitement borné à l'admission du tour tant que le host ne fournit pas d'événement de complétion exploitable.

### M3-07 — Reprise du scheduler

**Code :** scheduler/store ; dépend M3-06.

**Travail :** clé unique schedule + occurrence, transactions de claim, politique de rattrapage, fuseau/DST, retry borné avec backoff et annulation. Distinguer machine/app fermée et run interrompu ; ne jamais relancer aveuglément une opération externe au résultat ambigu.

**État au 18/09/2026 :** les occurrences portent maintenant `occurrenceAt`/`occurrenceKey`, les cron manqués suivent `latest` ou `skip`, et le journal limite les échecs à trois tentatives avec backoff 15/30/60 secondes. Une retry en attente est annulable depuis Automations ; les timeouts ambigus ne sont jamais relancés automatiquement. Le renderer utilise encore `muse-desktop.scheduler-lease.v1` en preview, tandis qu'un build Tauri acquiert, renouvelle et libère aussi `muse-desktop.native-scheduler-lease.v1` dans le superviseur Rust : un fichier ouvert rend le claim exclusif entre processus indépendants et sa fermeture libère le bail après crash. Les runs et les définitions de schedules sont maintenant recopiés sous `app_data/scheduler/` avec enveloppe de schéma, bornes de taille et staging + rename ; leurs écritures renderer → natif sont sérialisées et coalescées, puis au démarrage le hook fusionne les deux copies par occurrence ou curseur avant de reprendre ses transitions. Le scheduler réévalue immédiatement les occurrences au `focus`, `pageshow` et retour de visibilité, puis les fuseaux IANA sont résolus en heure murale, y compris les trous et doublons DST. Au boot, les runs non terminaux sans preuve de résultat sont désormais marqués `recovery: after-restart`, rendus visibles comme **Review needed** et bloqués jusqu'à une action explicite **Mark failed** ; aucune opération externe ambiguë n'est rejouée automatiquement. Automations expose maintenant le résultat du dernier contrôle du bail en quatre états et l'heure de vérification, avec une explication explicite lorsque cette fenêtre attend une autre instance, ainsi que le prochain déclenchement ou l'état **Due now** calculé par `nextScheduleOccurrence`. Sur Windows, le superviseur programme en plus une tâche ponctuelle `Muse-Desktop\AutomationWake` vers la prochaine occurrence activée ; elle ne fait que relancer l'exécutable avec `--automation-wakeup`, après quoi la SSOT renderer reprend la réconciliation normale. Le statut et l'échéance sont visibles dans Automations, et la tâche est remplacée ou supprimée à chaque changement de planning ; les appels natifs sont sérialisés et coalescés pour que la dernière définition reste gagnante.

**Limite restante :** le bail natif arbitre désormais les processus Tauri et les définitions/runs sont durables sous app data. Sous Windows, l'application peut être relancée à la prochaine occurrence via le Planificateur de tâches ; cela reste dépendant d'une session utilisateur et ne constitue pas encore un service de fond multiplateforme. La preuve native de l'état du host après crash, le poste verrouillé et la qualification macOS/Linux restent à faire.

**Acceptation :** sommeil/réveil, changement d'heure, double instance, crash entre claim et démarrage, suppression schedule ; pas de doublon d'occurrence.

### M3-08 — Inbox de résultats

**Code :** ReviewQueuePanel à faire évoluer, store Runs ; dépend M3-06/07.

**Travail :** statuts queued/running/succeeded/failed/cancelled, timestamps, résumé, cible et lien conversation. Actions ouvrir/retry/archiver ; non-lu séparé de statut métier.

**État au 18/09/2026 :** Automations affiche les huit derniers runs avec statut, horodatage, aperçu borné, erreur, indicateur non-lu, ouverture de la conversation et marquage lu. Un run passe à `completed` au premier statut d'arrêt du host et conserve l'aperçu de la dernière réponse assistant ; avant cet événement, il reste `running` même si `send_input` a été acquitté. La liste propose désormais les filtres Active/Unread/Queued/Running/Completed/Failed/Archived, l'archivage durable et la restauration, ainsi que Retry now pour une erreur ou une retry différée. Chaque run peut aussi être déplié pour inspecter cible, autorisation, modèle, workspace, occurrence, tentative, durée, instructions, résultat et erreur. À la fin d'un run, Muse persiste en plus un résumé extractif borné (headline, compteurs, fichiers mentionnés et issues) dérivé du journal local ; il est présenté dans la ligne et dans le détail sans appel modèle supplémentaire. Lorsqu'un événement terminal fournit déjà `result`, `resultPreview`, `output`, `summary` ou `text`, le bridge Rust le borne avant de le transmettre au renderer, qui le conserve avant d'utiliser la dernière réponse assistant.

**Limite restante :** le résumé métier riche et un signal de fin de run fourni directement par le host restent à qualifier.

**Acceptation :** aucun résultat présenté avant terminaison, historique durable et ouverture de la bonne session après restart.

### M3-09 — Notifications

**Code :** `src/lib/notifications.ts`, `useMuseSessions` et `SchedulesPanel` ; dépend M3-08/M0-12.

**État au 18/09/2026 :** l'inbox locale est livrée pour les runs terminés/échoués et pour les demandes d'autorisation ou de réponse utilisateur : chaque entrée conserve une clé d'idempotence, un aperçu, la session cible et un état non-lu ; Automations permet l'ouverture de la conversation, l'ouverture d'un run sans session, le marquage d'une entrée et l'acquittement de toutes les notifications non lues en une action. Un run qui échoue avant la création d'une session reste maintenant actionnable : **Open run** ouvre Automations au lieu de perdre le clic. Dans un build Tauri, la demande de permission et l'envoi utilisent désormais `tauri-plugin-notification`; le web preview conserve l'API `Notification` comme fallback explicite, sans rejouer les historiques au démarrage. La préférence de silence desktop est persistée séparément. Les toasts et les notifications de runs terminaux restent désarmés jusqu'à la fin de la fusion du ledger natif, afin qu'une ligne historique ne soit jamais rejouée comme une nouveauté au démarrage. Les notifications Tauri déclarent désormais l'action **Open conversation** et transportent uniquement les identifiants de routage bornés ; `App` passe par le résolveur pur `resolveNotificationRoute`, qui valide la session puis ouvre directement le fil, ou ouvre l'inbox du run si seule la référence `runId` est connue, et le fallback web émet le même événement. Si l'action arrive avant la réhydratation de `session/list` ou du ledger des runs, elle est conservée jusqu'à la disponibilité de la SSOT puis expirée après 30 secondes. L'inbox est maintenant miroirée dans `app_data/notifications/notifications.json` avec enveloppe de schéma, borne de taille et écriture atomique ; le hook fusionne les copies par `dedupeKey` avant d'écrire l'état suivant, et sérialise les écritures natives pour qu'un burst de notifications ne puisse pas réinstaller un snapshot plus ancien. La persistance d'un scheduler/notification quand l'app est fermée et la qualification OS restent ouvertes.

**Travail restant :** service natif OS/Tauri quand l'application est fermée et qualification du prompt d'action sur chaque plateforme. Pas de notification par token ou tick.

**Acceptation :** notification unique, clic ouvre la cible, cible supprimée, OS refuse et mode muet respecté.

## M4 — Études puis capacités étendues

Les études produisent un ADR avec API réellement disponible, prototype minimal, contraintes OS/permissions, coûts et critère go/no-go. Un no-go reste visible dans la roadmap, sans écran laissant croire à une disponibilité.

### M4-01 — Navigateur

**Code :** BrowserPanel et nouvelle surface native ; dépend M0-06/14. Comparer webview dédiée et moteur navigateur contrôlable, sessions/cookies, navigation, téléchargements et restrictions d'embed. **Acceptation :** vrais sites non iframe, erreurs réseau et isolation ; aucune URL dangereuse chargée via protocole non prévu.

**État au 18/09/2026 :** première passe UI livrée dans `BrowserPanel` : URL normalisée, historique précédent/suivant, Reload, URL effectivement affichée, erreurs de chargement/protocole et jusqu'à huit onglets locaux restaurés sous `muse-desktop.browser.tabs.v1`. La navigation est maintenant persistée sous une clé dérivée du `sessionId` de conversation et le panneau est remonté lors d'un changement de conversation ; une session ne peut donc plus récupérer les onglets d'une autre. La persistance ne contient que des URL http(s) et un historique borné ; cookies, credentials et état de page restent dans le runtime navigateur. Un téléchargement explicite de lien same-origin est maintenant disponible : en desktop, `browser_download_fetch` fait la requête native sans credentials, refuse les redirections, borne le flux à 10 MiB et renvoie un payload base64 au dialogue de destination Tauri ; le preview web conserve un fetch sans credentials puis un Blob borné. Les liens `<a download>` déclenchés par une page same-origin sont interceptés et réutilisent ce même parcours borné, avec le grant computer-use **browser**. Le nom de fichier est réduit à un basename sûr et l'écriture desktop est validée côté Rust. **Open native** réutilise une webview Tauri dédiée et **Close native** la ferme de manière idempotente depuis le panneau. La sandbox iframe reste une prévisualisation bornée ; cookies/sessions, réponses de téléchargement initiées par la navigation et qualification multi-plateforme restent à qualifier.

### M4-02 — Annotation visuelle

**Code :** browserAnnotate.ts, capture et composer ; dépend M4-01/M1-08. Définir URL/frame/viewport/région/élément/version avec capture réelle ; conserver provenance et signaler contexte périmé. **Acceptation :** sélection scrollée, iframe, zoom et envoi de l'image/ancre correcte.

**État au 17/09/2026 :** l'ancre textuelle utilise l'URL normalisée réellement affichée et les notes sont filtrées par cette URL. Dans une iframe same-origin, un clic produit une ancre DOM bornée (sélecteur, balise, rôle, libellé et texte) qui reste de la métadonnée passive. **Add page context** et **Add to prompt** insèrent dans le composer actif un bloc borné avec provenance, URL, sélection, commentaire et ancre élément. **Capture visible page** demande explicitement une source via `getDisplayMedia`, affiche un aperçu, permet de sélectionner et recadrer une région, ajoute l'image capturée comme pièce jointe MSP et conserve URL, heure, viewport, DPR, coordonnées de région et ancre élément dans le contexte ; le hook de sessions centralise le pré-remplissage et l'attachement. Les pages cross-origin conservent le fallback manuel ; la capture automatique de la seule iframe, iframe/zoom et la qualification native restent à produire.

### M4-03 — Pilotage navigateur

**Code :** adaptateur outils navigateur ; dépend M4-01/M3-01 et moteur compatible. Exposer observe/click/type/navigation avec surface et session explicites, arrêt et erreurs ; traiter le texte de page comme données non fiables. **Acceptation :** workflow web complet, navigation inattendue et stop sans agir sur un autre onglet.

**État au 18/09/2026 :** première tranche locale livrée dans `BrowserPanel` : **Observe page** collecte titre, texte, liens et contrôles d'une iframe same-origin avec bornage et provenance ; **Navigate selected link**, **Open in new tab**, **Click selected element**, **Type into field** et le téléchargement sont des gestes explicites limités à l'élément sélectionné, aux champs texte visibles et à la frame courante, et exigent désormais le grant computer-use **browser** (default denied). La navigation vérifie l'origine http(s), réutilise l'historique de l'onglet, peut préserver l'onglet courant en ouvrant une nouvelle surface bornée et refuse les liens externes. Les skills `browser.*` annoncées par le host sont maintenant routées depuis le panneau avec URL/élément/valeur bornés ; pendant une invocation navigateur active, **Stop Muse action** appelle `cancel_session` via la SSOT et attend la confirmation de fin. Le contexte d'observation est marqué comme contenu non fiable et ne déclenche aucun IPC. Reste : qualification native d'un workflow long, cross-origin/native WebView2 et preuve d'un host qui sert effectivement ces skills.

### M4-04 — Computer use

**Code :** service distinct par OS ; dépend M0-06 et faisabilité moteur. Autorisations OS, inventaire des apps, capture/action ciblées, interruptions et journal minimal. **Acceptation :** application de test, permission refusée, fenêtre disparue, utilisateur reprenant le contrôle ; pas d'action après stop.

**État au 18/09/2026 — première tranche Windows livrée :** `src-tauri/src/desktop_control.rs` expose un statut de runtime, un inventaire borné des fenêtres de premier niveau visibles et titrées, une observation read-only des contrôles enfants (titre, classe Win32, rôle sémantique UI Automation et identifiant d'automatisation lorsqu'ils sont disponibles, géométrie relative, visibilité et état activé/désactivé), ainsi que des états/aperçus bornés issus de `ValuePattern`, `RangeValuePattern`, `SelectionItemPattern`, `TogglePattern` et `TextPattern` pour les éléments non sensibles. Les éléments marqués password et les noms/rôles/identifiants ressemblant à des secrets, tokens, codes ou credentials sont signalés `valueRedacted` sans transmettre leur contenu. Les textes natifs et les labels renderer éliminent également les marqueurs de remplacement, caractères de contrôle et formats invisibles avant affichage ou copie. Le focus, l'injection de texte UTF-16 plafonnée, une allowlist de touches et un clic dans les bounds observés sont également livrés ; chaque ligne observée propose maintenant un clic explicite sur son centre relatif, avec le même bornage. UI Automation est préférée et le repli Win32 est explicite lorsqu'une fenêtre refuse l'accès COM. `DesktopControlPanel` est accessible comme panneau de travail et partage la permission computer-use persistée ; cette préférence est réaffirmée dans un verrou natif volatile après chaque lancement, et le bridge refuse les contrôles tant que le consentement explicite n'a pas été resynchronisé. L'observation peut être ajoutée au composer avec sa provenance via la SSOT de pré-remplissage. Le même panneau demande aussi un geste `getDisplayMedia`, prévisualise la surface choisie et transmet une capture comme pièce jointe explicitement attribuée au composer. Lorsque le host annonce un selector `computer.*`, l'adaptateur réutilise l'invocation de skill, l'outbox et l'arrêt ciblé existants avec une charge bornée. Les plateformes sans runtime renvoient `supported: false`. Les tests Node couvrent l'autorisation par défaut, le bornage des coordonnées, l'observation bornée, le masquage des valeurs sensibles, les états sémantiques, la provenance de capture et le filtrage des selectors ; Cargo couvre les types natifs et le build Windows. La qualification du consentement natif et le scénario interactif restent séparés.

**Reste :** structure riche, sélections et relations de documents complexes, qualification d'un selector `computer.*` réellement servi par un host, qualification du dialogue Windows et implémentations macOS/Linux. Cette tranche ne doit pas être présentée comme un contrôle autonome du bureau : le host n'invoque aucune commande native depuis le catalogue sans contrat et consentement vérifiés.

### M4-05 — Artefacts riches

**Code :** artifacts.ts, previews et service fichiers ; dépend M1-07/08. Séparer génération image/document côté moteur, fichiers persistés et rendu sécurisé ; détecter formats supportés, version/source réelle et export. **Acceptation :** fichier ouvert hors app, preview défaillante avec fallback, version et provenance exactes ; ne pas assimiler bloc Markdown et fichier livré.

**État au 18/09/2026 :** le panneau Content exporte maintenant une version précise d'un artefact et propose **Preview/Source** pour les documents Markdown. Le preview réutilise le renderer de contenu sûr, sans interprétation HTML ou script ; la source et la provenance restent inchangées. En desktop, `save` ouvre le sélecteur natif puis `artifact_export` écrit un fichier UTF-8 borné à 2 MiB ; le preview web conserve un téléchargement navigateur. Files décode également les images et PDF reconnus sous 5 MiB en aperçu base64 borné, y compris les SVG textuels, puis propose l'ouverture système comme repli. Les CSV, TSV et JSON valides disposent d'un tableau local borné (100 lignes, 20 colonnes, 400 caractères par cellule, 40 000 caractères inspectés), tandis que les entrées mal formées retombent sur le texte brut. Les conteneurs DOCX/XLSX/PPTX/ODT/ODS/ODP jusqu'à 5 MiB sont maintenant lus localement : paragraphes, première feuille bornée et texte de diapositives sont affichés comme tableau sans exécuter macros, formules, relations ou médias. L'extraction ZIP est filtrée avant inflation : seules les parties XML utiles sont retenues, à raison de 4 MiB par entrée, 8 MiB cumulés et 500 entrées examinées. Le bridge de transcript conserve aussi les métadonnées `modelVisibleContent` et les `outputRef` bornés ; **Preview output** charge les sorties `item/readOutput` par blocs de 64 KiB, rend les images base64 complètes dans la lane d'origine, affiche les PDF complets jusqu'à 5 MiB dans le lecteur du WebView et propose **Save output** dans le desktop via une écriture Rust base64 bornée à 10 MiB, avec **Open in app** pour les chemins workspace vérifiés. Le preview web conserve le téléchargement navigateur. La destination absolue, le dossier parent existant et l'absence de NUL sont vérifiés côté Rust. Reste à câbler les sorties image/document réellement produites par le moteur, les formats bureautiques hors OOXML/ODF et la qualification sur chaque plateforme.

### M4-06 — Partage hébergé

**Code :** SharePanel/sharing.ts et nouveau service distant ; dépend décision d'hébergement/auth. Créer snapshot avec données explicitement incluses, permissions/token, durée et révocation ; secrets exclus. **Acceptation :** second client, lien révoqué, export incomplet et erreur de publication ; aucune URL annoncée avant création réelle.

**État au 18/09/2026 :** l'export local Markdown/JSON est maintenant sauvegardable via le dialogue natif dans le desktop, avec repli téléchargement dans le preview web et erreur visible en cas d'échec. Le bundle reste explicitement local et révocable uniquement dans le profil ; aucune URL publique n'est fabriquée. Reste le service d'hébergement, l'identité, la durée de vie et la révocation observables depuis un second client.

### M4-07 — Remote/cloud

**Code :** abstraction HostConnection et service distant à concevoir ; dépend M0-01/02/06 et M2. Séparer exécution sur ordinateur distant connecté et environnement cloud provisionné. Auth, découverte, événements reconnectables, transfert d'artefacts et contrôle de versions. **Acceptation :** déconnexion/reprise sans doublons, host indisponible, commande ciblée et destruction explicite d'environnement.

### M4-08 — Voix

**Code :** module audio et intégration composer à créer. ADR transcription seule vs dialogue temps réel, fournisseurs et consentement micro. Gestion annulation, latence, erreurs et absence de conservation audio implicite. **Acceptation :** micro absent/refusé, interruption, transcription éditable avant envoi et destination inchangée.

**État au 18/09/2026 :** première tranche livrée dans `src/lib/voice.ts` et `Composer` : détection standard/WebKit, pré-demande explicite `getUserMedia` au clic, arrêt immédiat des pistes temporaires, transcription continue éditable, arrêt explicite et messages bornés pour refus, absence de micro, silence ou API indisponible. Le texte rejoint le brouillon uniquement ; aucun flux audio n'est persisté ou envoyé au host. Reste : décision fournisseur/temps réel, permission micro native par OS et qualification d'une interruption pendant l'envoi.

### M4-09 — Distribution

**Code :** Tauri config, bridge, scripts build et CI. Dépend M0-10/14. Matrice OS/architecture, moteur supporté, provenance/checksum des binaires, signature selon canal, mises à jour signées et récupération. **Acceptation :** installer sur machine propre, mettre à jour depuis version précédente et désinstaller sans effacer les projets ; preuves propres à chaque plateforme.

**État au 18/09/2026 :** `scripts/build-windows.ps1` génère maintenant, après chaque bundle demandé (`nsis`, `msi` ou `all`), un manifeste adjacent via `scripts/release-manifest.mjs`. Le schéma `muse-desktop.release-manifest.v1` est volontairement déterministe : nom de fichier, taille et SHA-256 de l'installateur et du sidecar, sans chemin local ni horodatage. Le build explicite `x86_64-pc-windows-msvc` a produit et vérifié le NSIS et le MSI le 17 septembre 2026 ; une reprise NSIS le 18 septembre a produit un installateur x64 de 5 297 801 octets et validé le manifeste contre le sidecar fourni. `scripts/verify-release-manifest.mjs` compare ces fichiers explicitement fournis et signale une modification de taille ou d'empreinte avant installation ; il vérifie aussi une signature Ed25519 optionnelle lorsque la clé publique de confiance est fournie explicitement. `scripts/release-update.mjs` ajoute maintenant un plan `muse-desktop.release-update.v1`, un staging recopié et publié atomiquement, puis une bascule `current`/`previous` avec rollback transactionnel ; avec `--public-key --require-signature`, le plan signé est revalidé à chaque étape. `scripts/release-launcher.mjs` demande l'arrêt borné du PID courant, attend sa disparition, applique le candidat sans shell puis relance l'exécutable détaché ; un échec de démarrage rétablit les slots. Le scénario valide, altéré, appliqué, relancé puis handoff est testé localement avec 684 tests Node. `npm run release:installer -- --pid … --installer …` arrête Muse et délègue explicitement un installateur NSIS `.exe` ou MSI via `msiexec.exe`, toujours sans shell. `npm run release:delta -- create|apply` produit et reconstruit un delta local compressé, vérifié par les empreintes source/cible et publié par renommage atomique ; le caller peut mesurer `useDelta` et conserver l'artefact complet si le delta est plus gros. `npm run release:channel -- build|verify|select` génère et contrôle un index de canal signé puis choisit la dernière cible compatible. `npm run release:fetch -- fetch` récupère un asset HTTPS déclaré sans redirection, borne le corps, vérifie la taille et le SHA-256, puis publie le fichier par renommage atomique. `scripts/release-orchestrator.mjs sync` vérifie le canal signé, sélectionne la cible compatible, récupère les deux assets, revalide le manifeste et publie un candidat de staging prêt pour le launcher. Reste l'hébergement opérationnel, la gestion des clés et la qualification macOS/Linux. Le smoke de réconciliation est désormais documenté séparément afin que la sortie `methodNotFound` du sidecar ne soit pas confondue avec une panne de l'application.

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

Ne déclarer un parent terminé que lorsque tous ses critères d'acceptation sont couverts. Le prochain lot conseillé est la **preuve native M0-01c/M0-02c** (deux workspaces, panne/reconnexion, approbation et reprise d'un tour), maintenant que les chemins renderer et liveness sont câblés. M2-08 dispose désormais du dispatch renderer vers les conversations de worktree ; le verrouillage de fichiers, l'annulation atomique et le résultat structuré restent conditionnés au contrat writer/spawn du moteur. M3-07 dispose d'un réveil ponctuel Windows ; le service de fond multiplateforme et la preuve host restent ouverts.
