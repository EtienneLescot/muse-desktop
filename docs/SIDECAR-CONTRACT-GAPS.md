# Écarts de contrat du sidecar Muse — rapport au mainteneur

> ## ⚠️ Lire ceci avant le reste
>
> **Ce rapport a affirmé cinq écarts. Quatre ont été démentis par des mesures ultérieures, et le cinquième n'a jamais été mesuré valablement.**
>
> | Écart | Ce que ce rapport affirmait | Mesure ultérieure |
> |---|---|---|
> | 1 | `session/read` et `session/resume` absents | **fonctionnels** sur une session persistée (§1) |
> | 2 | aucune notification terminale après interruption | **`turn/completed` émis** (§2) |
> | 3 | `userShell` accepté sans item ni sortie | **item `userShell` publié, sortie incluse** (§3) |
> | 4 | projections non rapportées | **jamais mesuré valablement** — mes appels sont refusés (§4) |
> | 5 | durabilité constamment `ephemeral` | **variable** (§5) |
>
> **La cause était mon outillage, pas le sidecar.** Cinq constats d'absence, cinq artefacts de méthode : une erreur de contexte — session non persistée, capacité mal demandée, interruption sans le `turnId` exigé, attente trop courte — lue chaque fois comme une absence de capacité du host.
>
> **Ne reprenez aucune conclusion de ce document sans la revérifier** sur une ressource **persistée** et avec les **paramètres exigés**. Les sections corrigées portent leur date et leur mesure ; les sections non corrigées n'ont pas cette garantie.

**Destinataire :** mainteneur du sidecar Muse (nous).
**Objet :** capacités que le client Muse-Desktop attend et que `muse serve` n'expose pas, avec mesures reproductibles et impact ticket par ticket.
**Version mesurée :** Muse Code **1.3.0 (1.3.0-R3401.1)**, binaire Windows natif.
**Date :** 20 septembre 2026.

Ce document ne décrit **pas** des bugs du client. Chaque écart a été confirmé en interrogeant le host directement, sans passer par l'interface. Les commandes sont fournies pour que chaque constat soit revérifiable.

**Limite acquise à la fin de cette campagne :** une mesure d'absence ne vaut que si le scénario **sollicitait réellement** la ressource. Quatre des cinq constats de ce rapport ne le faisaient pas.

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
| `session/list` | **available** — énumère les sessions persistées avec leur chemin et leurs métadonnées | restauration paginée fonctionnelle |
| `approval/listPending` | **available** — retourne `{approvals, userInputs}` | récupération des demandes en attente possible |
| `session/read` | **available sur une session persistée** — retourne `{session, viewCursor, history, pendingRequests}` | **la relecture d'historique existe** ; voir la correction ci-dessous |
| `session/resume` | **`sessionInUse`** sur une session persistée déjà ouverte ; `sessionNotFound` sur une session non persistée | refus **conditionnel**, pas méthode absente |
| `view/page` | **unsupported** en tant que tel | `session/read` retourne un `viewCursor` : la pagination passe peut-être par lui |

**Correction majeure (20/09/2026, fin de campagne).** Ce tableau classait `session/read` et `session/resume` comme `unsupported`. **C'est faux, et l'erreur vient de ma sonde.** `msp-probe.mjs` appelait ces surfaces sur une session **fraîchement créée**, jamais persistée : le host répondait `sessionNotFound`, et la sonde ne distinguait pas cette erreur de `methodNotFound`. Sur une session **réellement sur disque**, `session/read` répond **`ok`** et `session/resume` répond **`sessionInUse`** — quatre sessions testées, quatre fois.

**Impact :** la reprise ne repose donc **pas** sur des méthodes absentes. Deux questions plus étroites restent ouvertes : `session/resume` sur une session **libre** n'a jamais été observé (l'application tenait les sessions pendant le test), et `view/page` doit être réévalué au regard du `viewCursor` retourné par `session/read`. Détail complet dans [`session-read-fonctionne.md`](evidence/2026-09-20-windows-sessions/session-read-fonctionne.md).

**Point d'attention :** `approval/listPending` **fonctionne** dès qu'on lui passe un `sessionId` ; un appel **sans** `sessionId` retourne `methodNotFound`. Le harness `native-smoke.mjs` l'appelait sans identifiant et le classait donc `unsupported` — la documentation du dépôt a porté cette erreur un moment. **C'est le même travers que pour `session/read`** : une erreur de contexte interprétée comme une absence de méthode. La sonde doit distinguer explicitement `methodNotFound` de `sessionNotFound`, et tester les surfaces de lecture sur une session **persistée**.

## 2. Notification terminale de tour — **émise à la fin normale, absente après une interruption**

**Seconde correction (20/09/2026, round 55).** Ce paragraphe affirmait ensuite qu'**aucun** terminal n'est émis après une interruption. **C'est faux aussi**, et le tableau est désormais :

| Situation | Notification terminale | Mesure |
|---|---|---|
| **Tour mené à son terme normalement** | **`turn/completed` émis** | `msp-resume-free-session.mjs` |
| **Tour interrompu par `turn/interrupt`** | **`turn/completed` émis à +39 ms** | `msp-interrupt-notifications.mjs` — avec `{sessionId, turnId, commandId}` |

Après interruption, le host émet `item/completed` (+19 ms), `session/statusChanged` (+39 ms) puis **`turn/completed` (+39 ms)**, portant **le `turnId` attendu**, et **zéro** `item/delta` ensuite : le tour s'est bien arrêté, et le terminal le confirme.

**Pourquoi je croyais le contraire :** `native-smoke.mjs` appelle `turn/interrupt` **sans `turnId`** (`{commandId, sessionId, retract}`), alors que le host l'exige. L'interruption était refusée en `invalidParams`, le tour n'était jamais interrompu, aucun terminal ne pouvait arriver — et le harness traduisait cette absence en `terminalNotification: unsupported`. **Le harness a besoin d'un correctif** : passer le `turnId` du tour qu'il interrompt.

**Impact, corrigé une seconde fois :** il n'y a **aucun écart de terminal côté host**, ni sur le chemin nominal, ni sur le chemin d'arrêt. L'observation d'interface — `Stopping…` qui ne se résout pas, bandeau « waiting for the desktop host to confirm it » — reste **inexpliquée**, mais elle ne peut plus être attribuée à une absence de terminal : le host le fournit. Trois pistes restent ouvertes, aucune tranchée : le renderer ne transmet peut-être pas de `turnId` non vide à `interrupt_session` ; le terminal arrive peut-être sans être associé au bon tour ; l'observation datait peut-être d'un état différent. Détail dans [`terminal-apres-interruption.md`](evidence/2026-09-20-windows-sessions/terminal-apres-interruption.md).

## 3. `session/userShell` — **fonctionne**, et la sortie est reportée

**Correction (20/09/2026, round 59).** Ce paragraphe affirmait que le host accepte `session/userShell` **sans jamais publier d'item**. **C'est faux sur les deux points.**

La cause était dans la façon dont je demandais la capacité. Elle doit être **imbriquée dans `capabilities`** :

```js
initialize({ clientInfo, capabilities: { requestedCapabilities: ["userShell"] } })
```

Mes autres formes — `capabilities: { userShell: true }`, `capabilities: ["userShell"]`, ou `requestedCapabilities` au niveau racine — échouent toutes avec `grantedCapabilities: []`, et l'appel répond alors `session/userShell requires the userShell capability`. **Je lisais ce refus comme une absence de fonctionnalité.**

Avec la bonne forme :

| Mesure | Résultat |
|---|---|
| `grantedCapabilities` | **`["userShell"]`** |
| `session/userShell` avec `commandText` | **`ok`**, `status: accepted` |
| Items publiés | **`item/started` et `item/completed`**, de `kind: "userShell"` |
| **Sortie de la commande** | **présente dans la charge utile de l'item** |
| `outputRef` | absent — mais la sortie est reportée autrement |

**Preuve par contenu, pas par présence d'un champ :** la commande exécutée écrit un marqueur unique (`muse-ushell-<horodatage>`) et ce marqueur est **retrouvé dans les notifications** reçues après l'appel.

**Impact, corrigé :** le parcours « je lance une commande et je vois la sortie » **est tenable**. Rien de ce côté n'est bloqué par le sidecar. Ce qui manquerait, s'il manquait quelque chose, serait **côté client** — demander la capacité sous la bonne forme et lire l'item. Détail dans [`user-shell-fonctionne.md`](evidence/2026-09-20-windows-sessions/user-shell-fonctionne.md).

## 4. Projections effectives — **jamais mesuré valablement**

**Avertissement (20/09/2026, round 59).** Le tableau ci-dessous provient de `native-smoke.mjs`, l'outil dont cette campagne a **démontré** qu'il produit des faux négatifs. Il n'est **pas** une mesure fiable.

Recontrôlé hors de cet outil, avec `session/start`, `model/list`, puis les deux appels :

| Appel | Résultat de mon contrôle |
|---|---|
| `session/setReasoningEffort` (`none`, `high`, `ultra`) | **`invalidParams`** |
| `session/setModel` (`muse-spark-1.3`) | **`invalidParams: missing f…`** |

Un `invalidParams` sur **ma** requête ne dit **rien** de la capacité du host : c'est le même piège que l'`approval/listPending` sans `sessionId` qui avait déjà produit un faux constat dans ce dépôt. **Je n'ai donc aucune mesure valide de cet écart, ni pour le confirmer, ni pour l'infirmer.**

Ce que `model/list` retourne en revanche, et qui est mesuré : `{providerId: "meta", profileId: "tbh", source: "providerCatalog", models: [{modelId: "muse-spark-1.3", …}]}` — le catalogue existe et est interrogeable.

<details>
<summary>Ancien constat, conservé pour mémoire — <strong>non fiable</strong></summary>

| Réglage | Accusé | Projection | Effectif |
|---|---|---|---|
| `session/setReasoningEffort` — `none`, `high`, `ultra` | *accepted* (les trois) | **`not-reported`** | *vide* |
| `session/setModel` — `muse-spark-1.3` | *accepted* | rapportée | **`isActive: false`** |
| `session/compact` sur session vierge | — | — | **`missing-run`** |

</details>

**Impact : inconnu.** Ni « le client ne peut pas prouver qu'un réglage a pris effet », ni l'inverse, ne sont établis. `session/read` expose `modelId` et `providerId` sur la session — la projection est peut-être simplement lisible là, comme l'est `approvalMode`.

**Ce qu'il faudrait :** retrouver la forme correcte des deux appels, puis relire la session pour voir si le réglage y apparaît. Borné, non fait.

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

**Tableau corrigé (round 59).** L'ancienne version déclarait quatre tickets M0 « bloqués par le host ». C'était faux pour trois d'entre eux.

| Ticket | Dépend de | Bloqué par le host ? |
|---|---|---|
| **M0-02** — reprendre après fermeture ou panne | §1 : `session/read` et `session/resume` **fonctionnent** | **non** — le défaut observé était une session absente côté host, pas une capacité manquante |
| **M0-04** — arrêter avec un état fiable | §2 : le terminal **est émis** après interruption | **non** — la cause observée est dans l'outillage de mesure, pas dans le host |
| **M1-06** — lire la sortie terminal | §3 : item `userShell` **publié avec sa sortie** | **non** — dépend du client, qui doit demander la capacité correctement |
| **M1-11** — modèle et effort effectifs | §4 : **jamais mesuré valablement** | **inconnu** |
| **M0-01 / M0-14** — isolation A/B | approbations : plafond `promptUnmatched` | **partiellement** — seule réserve encore debout |
| **M0-06** — posture de permissions | `session/read` expose `approvalMode` ; plafond `promptUnmatched` | **à réinstruire** |

**Aucun ticket M0 n'est établi comme bloqué par le host.** Le seul constat encore debout est le plafond `promptUnmatched`, qui limite la portée de M0-01 et M0-06 — et il n'a pas été remesuré depuis.

## Ce que nous demandons, par ordre de rentabilité

**Section réécrite (round 59).** Les quatre premières demandes portaient sur des écarts **démentis** ou **non mesurés**. Il serait malhonnête de les maintenir.

| Demande | Statut |
|---|---|
| `session/read` et `session/resume` | **retirée** — les deux méthodes fonctionnent |
| Notification terminale de tour | **retirée** — `turn/completed` est émis, nominal et après interruption |
| Item `userShell` avec sa sortie | **retirée** — l'item est publié, la sortie y est |
| Projection effective pour `setModel` / `setReasoningEffort` | **suspendue** — à remesurer avant d'être demandée |
| **`approval_mode` au-delà de `promptUnmatched`** | **seule demande encore fondée** — elle limite la portée réelle de M0-01 et M0-06 |

**Ce qu'il faut faire avant de rouvrir ce rapport :** mesurer l'écart n° 4 avec les bons paramètres, puis décider s'il y a quelque chose à demander. Tant que ce n'est pas fait, **ce document ne porte aucune demande fondée**, à une exception près.

## Ce que ce rapport n'affirme pas

- **Il a déjà affirmé deux choses fausses**, corrigées depuis : que `session/read` et `session/resume` étaient `unsupported` (§1 — faux, la sonde testait une session non persistée), et que `sessionDurability` valait constamment `ephemeral` (§5 — faux, sa valeur a changé en cours de campagne). Les deux erreurs venaient de la **même cause** : une erreur de contexte interprétée comme une absence de capacité. Toute conclusion de ce rapport doit donc être lue avec cette réserve, et revérifiée sur une session **persistée** avant d'être reprise.
- Il ne dit pas **pourquoi** les capacités qui manquent vraiment sont absentes : choix de conception, retard d'implémentation ou limite du mode `serve` — nous ne le savons pas. À noter que `muse exec` (entrée headless) **produit** un tour complet, donc le moteur en est capable ; c'est la projection par `serve` qui manque.
- Il ne prétend pas que ces changements sont simples : nous n'avons pas examiné le code du sidecar.
- Il ne couvre **pas** le mode interactif `muse` ni `muse exec`, uniquement `muse serve`, qui est le seul chemin utilisé par l'application.
- Toutes les mesures viennent d'un profil unique sur **Windows** ; aucun test macOS ou Linux n'a été fait.
