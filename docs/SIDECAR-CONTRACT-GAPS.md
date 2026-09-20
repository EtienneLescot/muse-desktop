# Écarts de contrat du sidecar Muse — rapport au mainteneur

**Destinataire :** mainteneur du sidecar Muse (nous).
**Objet :** capacités que le client Muse-Desktop attend et que `muse serve` n'expose pas, avec mesures reproductibles et impact ticket par ticket.
**Version mesurée :** Muse Code **1.3.0 (1.3.0-R3401.1)**, binaire Windows natif.
**Date :** 20 septembre 2026.

Ce document ne décrit **pas** des bugs du client. Chaque écart a été confirmé en interrogeant le host directement, sans passer par l'interface. Les commandes sont fournies pour que chaque constat soit revérifiable.

## Comment reproduire toutes les mesures

```powershell
# Contrat du host, sans consommer de tour modèle
node scripts/msp-probe.mjs --surfaces --user-shell

# Contrôle, raisonnement, modèle, compaction, sur deux sidecars réels
node scripts/native-smoke.mjs --exercise-control --exercise-reasoning `
  --exercise-model --exercise-compaction --report gap-smoke.json
```

`scripts/msp-probe.mjs` a été écrit pour ce rapport : c'est un client MSP minimal qui ne fait que décrire ce que le host expose.

## 1. Surfaces de lecture

Le client déclare ces méthodes dans `src/lib/msp.ts` (lignes 28–31) et les utilise pour la reprise et la réconciliation.

| Méthode | Résultat mesuré | Conséquence pour le client |
|---|---|---|
| `session/list` | **available** | restauration paginée fonctionnelle |
| `approval/listPending` | **available** — retourne `{approvals, userInputs}` | récupération des demandes en attente possible |
| `session/read` | **unsupported** | pas de relecture d'historique après reconnexion |
| `session/resume` | **unsupported** | **reprise durable impossible** |
| `view/page` | **unsupported** | pas de repli par curseur sur les événements durables |

**Impact :** `session/read` et `session/resume` sont les deux appels sur lesquels repose toute la reprise. Sans eux, le client ne peut pas rejouer un tour interrompu, ni récupérer les items produits hors ligne — il conserve le transcript local et l'annonce honnêtement, mais ne peut pas faire mieux.

**Point d'attention :** `approval/listPending` **fonctionne** dès qu'on lui passe un `sessionId` ; un appel **sans** `sessionId` retourne `methodNotFound`. Le harness `native-smoke.mjs` l'appelait sans identifiant et le classait donc `unsupported` — la documentation du dépôt a porté cette erreur un moment. Si un `methodNotFound` sur cette méthode doit signifier « absente », il faudrait que la réponse ne dépende pas de la présence d'un paramètre.

## 2. Notification terminale de tour — **absente**

| Mesure | Résultat |
|---|---|
| `turn/interrupt` | **accepted** |
| Notification `turn/completed`, `turn/retracted`, `turn/stopped` | **`terminalNotification: unsupported`**, sur les deux hosts |
| Notifications observées après un tour | `session/started`, puis rien de terminal |

Vérifié aussi **depuis l'interface** : après un `Stop` utilisateur, la conversation affiche `Stopping…`, puis bascule en **« No recent host update »** sans jamais recevoir de terminal. Sur un tour modèle live, la réponse arrive puis l'interface passe en stale — le tour n'est jamais clos par le host.

**Impact :** le client ne peut pas distinguer « le tour est fini » de « le host est silencieux ». Toute la logique d'état final — vérifier qu'un arrêt a bien abouti, savoir qu'un tour est terminé, clore proprement une lane — dépend d'une **déduction côté client** au lieu d'un signal.

## 3. `session/userShell` — accepté, jamais restitué

| Mesure | Résultat |
|---|---|
| `session/userShell` avec `commandText` | **accepted** |
| Item `userShell` publié (`item/started` / `completed` / `updated`) | **aucun** — `itemStarted: false` |
| `outputRef` sur l'item | **aucun** |
| Historique relisible (`session/read`) | non — méthode absente de toute façon |

Le smoke harness **attend déjà** cette notification (`native-smoke.mjs`, attente d'un `item/started` de `kind: "userShell"`) et ne l'obtient pas. Une commande de ~9 s avec fichier témoin absolu a été admise, sans qu'aucun item ni fichier témoin n'apparaisse 14 s plus tard.

**Impact :** le bouton **Run in Muse** peut exécuter une commande sans jamais pouvoir en montrer le résultat. Le client a un repli honnête — il insère la sortie manuellement dans le prompt — mais le parcours annoncé « je lance et je vois la sortie » n'est pas tenable.

## 4. Projections effectives — non rapportées

| Réglage | Accusé | Projection | Effectif |
|---|---|---|---|
| `session/setReasoningEffort` — `none`, `high`, `ultra` | **accepted** (les trois) | **`not-reported`** | **vide** |
| `session/setModel` — `muse-spark-1.3` | **accepted** | rapportée | **`isActive: false`** |
| `session/compact` sur session vierge | — | — | **`missing-run`** |

**Impact :** le client ne peut pas prouver qu'un réglage a pris effet. Il affiche le dernier modèle **demandé**, en le marquant explicitement comme non live — ce qui est honnête mais empêche toute confirmation utilisateur. Un `isActive: false` après un `setModel` accepté est particulièrement ambigu : accepter sans activer n'est pas un contrat exploitable.

Pour `session/compact`, `missing-run` sur une session vierge est un refus cohérent ; ce qui manque est un scénario sur un historique réel, donc côté client ce n'est pas un écart mais une preuve à produire.

## 5. Durabilité de session — **variable**, et non `ephemeral`

**Correction (20/09/2026, fin de campagne).** Ce paragraphe affirmait que `initialize` annonce `sessionDurability: "ephemeral"`. **C'est incomplet et trompeur.**

Mesuré en début de campagne : **`ephemeral`**. Mesuré en fin de campagne, **quatre fois de suite sur des hosts neufs** : **`durable`**. La configuration n'a pas changé entre les deux (`settings.json` et `auth.json` datent du 19/09, avant la première mesure), et le résultat ne dépend ni de `clientInfo.name` ni des capacités demandées.

**Je n'identifie pas la cause.** Ce qui est établi, c'est que **`sessionDurability` ne peut pas être documenté comme une constante du host 1.3.0** : sa valeur a changé sur la même machine, le même jour, sans modification de configuration.

Conséquence directe de l'échec de reprise, observée depuis l'interface après reconnexion :

> `MSP error -32020: session … was not found [sessionNotFound] [retryable=false]`

Le client affiche « Your saved messages are still available » et ne fabrique aucun faux succès — comportement correct, mais **l'explication n'est plus la bonne**.

### Ce que `session/list` démontre à la place

Le host **connaît 9 sessions**, chacune avec son **chemin de stockage** sur disque

```
%USERPROFILE%\.local\share\muse\sessions\<année>\<mois>\<jour>\<sessionId>\session.jsonl
```

et des métadonnées complètes : `title`, `turnCount`, `status`, `workspaceRoot`, `branch`, `updatedAt`, `providerId`, `modelId`, `firstUserPrompt`.

**L'historique est donc déjà persistant et énumérable.** `session/read` et `session/resume` ne manquent pas pour *créer* de la persistance, mais pour **lire depuis un client** ce que le host stocke déjà.

### Hypothèse à tester, qui pourrait fermer M0-02

Si le host est `durable` et que `session/list` énumère ces sessions, alors **le host connaît la session après redémarrage** — et l'échec de reprise viendrait du **client**, qui lance un nouveau host sans réconcilier avec les sessions déjà présentes. Ce serait alors un **défaut côté client, corrigible**, et non un blocage du sidecar.

**C'est une hypothèse, pas un résultat.** Elle est testable : relancer l'application et vérifier si le client propose à la reprise une session que `session/list` énumère.

**Impact :** aucune reprise après redémarrage n'est possible. Une valeur `durable` avec un `session/read` fonctionnel serait le chemin le plus court pour fermer plusieurs tickets à la fois.

## 6. Champs `initialize` réellement exposés

Mesuré : `experimentalApi`, `grantedCapabilities`, `museHome`, `platformFamily`, `platformOs`, `schema`, `serverInfo`, `sessionDurability`, `userAgent`.

Deux remarques pour la documentation du protocole :

- **`initialize` exige `clientInfo.name` conforme à `^[a-z0-9_]+$`** — un tiret fait échouer l'appel avec un message explicite (`SS1.4.1`). C'est correct mais non documenté côté client ; nous l'avons découvert en écrivant la sonde.
- Détails de forme utiles, absents de notre documentation : `session/start` prend `workspaceRoot` (et non `cwd`) **et exige `commandId`** — sans lui, `invalid session/start params: missing field 'commandId'` — et répond `result.session.sessionId` ; `session/userShell` prend **`commandText`** (et non `command`) ; `turn/interrupt` exige **`commandId` en plus de `turnId`**. Un client doit donc aussi envoyer la notification **`initialized`** après `initialize`, sinon tout appel suivant répond `Not initialized`.

## Où vivent les sessions — et pourquoi cela compte pour la reprise

`session/list` retourne pour chaque session son **chemin de stockage** :

```
%USERPROFILE%\.local\share\muse\sessions\<année>\<mois>\<jour>\<sessionId>\session.jsonl
```

Champs exposés : `sessionId`, `path`, `status`, `activeTurnId`, `createdAt`, `updatedAt`, `workspaceRoot`, `providerId`, `modelId`, `turnCount`, `forkedFrom`, `title`, `firstUserPrompt`, `branch`.

**Conséquence directe sur le §1** : les conversations **existent sur disque** et le host les relit au démarrage. Ce n'est donc pas la persistance qui manque, c'est **l'API pour les relire depuis un client** — `session/read` et `session/resume` sont absents alors que les données sont là, dans un format que le host sait lire. Cela réduit sérieusement l'effort attendu pour combler l'écart n° 1 de ce rapport, et cela vaut la peine d'être dit avant toute estimation.

## Impact consolidé sur les tickets du groupe 1

| Ticket | Dépend de | Fermable sans changement du host ? |
|---|---|---|
| **M0-04** — arrêter et reprendre avec des états fiables | §2 notification terminale | **non** |
| **M1-06** — faire lire la sortie terminal au moteur | §3 items `userShell` et `outputRef` | **non** |
| **M1-11** — modèle et effort effectifs | §4 projections | **non** |
| **M0-02** — reprendre après fermeture ou panne | §1 `session/read`, `session/resume` ; §5 durabilité | **non** |
| **M0-01 / M0-14** — isolation A/B | aucune ; approbations bloquées par `promptUnmatched` | partiellement |
| **M0-06** — posture de permissions effective | plafond `promptUnmatched` | partiellement |

Quatre tickets de priorité immédiate (M0) sont donc **bloqués par le host, pas par le client**.

## Ce que nous demandons, par ordre de rentabilité

1. **`session/read` et `session/resume`**, ou une durabilité `durable` — débloque la reprise et, par ricochet, une partie de M0-02 et M0-05.
2. **Une notification terminale de tour** (`turn/completed` suffirait, avec `turnId`) — débloque M0-04 et rend l'état final vérifiable au lieu d'être déduit.
3. **La publication d'un item `userShell`** avec sa sortie et un `outputRef` — débloque M1-06.
4. **Une projection effective** pour `setModel` et `setReasoningEffort` — débloque M1-11 ; un simple `effective` ou un `isActive` conforme à l'accusé suffirait.
5. **`approval_mode` sélectionnable au-delà de `promptUnmatched`**, ou une explication du plafond — débloque le critère « approbations simultanées » de M0-01 et la portée réelle de M0-06.

## Ce que ce rapport n'affirme pas

- Il ne dit pas **pourquoi** ces capacités sont absentes : choix de conception, retard d'implémentation ou limite du mode `serve` — nous ne le savons pas. À noter que `muse exec` (entrée headless) **produit** un tour complet, donc le moteur en est capable ; c'est la projection par `serve` qui manque.
- Il ne prétend pas que ces changements sont simples : nous n'avons pas examiné le code du sidecar.
- Il ne couvre **pas** le mode interactif `muse` ni `muse exec`, uniquement `muse serve`, qui est le seul chemin utilisé par l'application.
- Toutes les mesures viennent d'un profil unique sur **Windows** ; aucun test macOS ou Linux n'a été fait.
