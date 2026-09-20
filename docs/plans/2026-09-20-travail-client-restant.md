# Travail restant côté client — plan (20 septembre 2026)

Cette campagne a passé vingt rounds à demander au sidecar des choses qu'il **fournissait déjà**. Les six constats d'écart étaient six artefacts de méthode. Ce document transforme le résultat utile de cette enquête — **les formes d'appel correctes et les capacités réellement disponibles** — en plan de travail pour le client.

Destinataire : la prochaine session, ou vous.

## Ce que le host 1.3.0 fournit, vérifié

| Capacité | Appel | Preuve |
|---|---|---|
| Reprendre une session persistée | `session/resume` + `session/read` | `msp-resume-free-session.mjs` — succès sur session libre |
| Énumérer les sessions | `session/list` | 10 sessions avec `path`, `turnCount`, `status`, `branch`, `title` |
| Lire l'historique | `session/read` | retourne `{session, viewCursor, history, pendingRequests}` |
| Lire l'état d'approbation | `session/read` → `session.approvalMode` | `{mode, source, lastCommandId}` |
| Configurer l'approbation | `session/setApprovalMode` | `onRequest`, `allowAll`, `promptUnmatched` acceptés |
| Exécuter une commande et lire sa sortie | `session/userShell` | item `userShell` publié, sortie incluse |
| Changer de modèle | `session/setModel` | `modelId` mis à jour sur la session |
| Changer l'effort de raisonnement | `session/setReasoningEffort` | notification `session/reasoningEffortChanged` |

## Les formes d'appel, à ne pas redécouvrir

Chacune de ces formes a été trouvée **après** avoir produit un faux constat d'écart avec une forme incorrecte. Elles sont mesurées.

```js
// Capacité userShell : IMBRIQUÉE dans capabilities. Les autres formes accordent [].
initialize({ clientInfo: { name: "muse_desktop", version: "1.0.0" },
             capabilities: { requestedCapabilities: ["userShell"] } })
// → grantedCapabilities: ["userShell"]

// Handshake incomplet sans cette notification : tout appel suivant répond `Not initialized`.
notify("initialized", {})

// commandId est un UUIDv7. crypto.randomUUID() (v4) est REFUSÉ.
session/start        { commandId, workspaceRoot }
turn/start           { sessionId, commandId, input: [{ type: "text", text }] }
turn/interrupt       { sessionId, turnId, commandId }        // turnId OBLIGATOIRE
session/userShell    { sessionId, commandText, commandId }   // commandText, pas command
session/setModel     { sessionId, commandId, model: { modelId } }   // modelId est IMBRIQUÉ
session/setReasoningEffort { sessionId, commandId, reasoningEffort } // pas `effort`
session/setApprovalMode    { sessionId, commandId, mode }   // seuls onRequest, allowAll, promptUnmatched
```

## Chantier 1 — Réconcilier les conversations locales avec le host

**Constat :** `session/list` est déclaré dans `MSP_METHODS_SENT` (`src/lib/msp.ts:32`) mais **aucun appel n'existe côté application**. Le client peut afficher dans sa barre latérale une conversation que le host ne connaît pas — visible, son historique lisible, et **non reprenable**, sans que rien n'indique pourquoi. C'est exactement ce qui s'est produit avec la session `01a0bd8e`.

**Ce qu'il faudrait :** interroger `session/list` à l'ouverture, confronter les identifiants aux conversations stockées, et marquer les orphelines. Une conversation sans contrepartie côté host ne devrait pas proposer une reprise qui échouera.

**Où :** `src/hooks/useMuseSessions.ts`, au moment où les sessions stockées sont restaurées ; le pont Rust existe déjà pour les autres méthodes MSP.

**Vérification :** `msp-list-sessions.mjs` donne la liste attendue ; l'interface doit marquer la même chose.

## Chantier 2 — Le gate `ephemeral` ne se réévalue jamais

**Constat :** `isEphemeralSession` (`useMuseSessions.ts:569`) et `isResumeEligible` (`bootResume.ts:39`) refusent la reprise si `session_durability === "ephemeral"`. Cette valeur est écrite **à la création de la session** et jamais révisée. Or le host a annoncé **`ephemeral` puis `durable`** dans la même journée, sans changement de configuration.

**Ce qu'il faudrait :** ne pas traiter un `ephemeral` stocké comme définitif. Tenter la reprise et laisser le host répondre, ou relire la durabilité courante.

**Réserve honnête :** **aucune preuve que ce gate ait bloqué quoi que ce soit** — les 41 sessions sauvegardées portaient toutes `durable`. C'est un **risque latent**, pas un défaut observé. À traiter en connaissance de cause.

## Chantier 3 — Afficher la sortie des commandes `userShell`

**Constat :** le host publie un item `userShell` dont la charge utile **contient la sortie**. Le client a un repli — insérer la sortie manuellement dans le prompt.

**Ce qu'il faudrait :** lire l'item et l'afficher dans l'interface. Aucun `outputRef` n'est fourni ; la sortie est **dans l'item**.

## Chantier 4 — Confirmer les changements de modèle et d'effort

**Constat :** le modèle est visible dans `session.modelId` après l'appel, et l'effort est signalé par **`session/reasoningEffortChanged`**. Le client affiche aujourd'hui le dernier modèle **demandé**, marqué comme non live.

**Ce qu'il faudrait :** écouter `session/modelChanged` et `session/reasoningEffortChanged`, puis refléter l'état **confirmé** au lieu du demandé.

## Chantier 5 — Le terminal après un arrêt demandé

**Constat :** le host émet `turn/completed` **39 ms** après `turn/interrupt`, avec le bon `turnId`. Le client attend délibérément ce terminal (son commentaire Rust le dit).

**Ce qu'il faudrait :** vérifier que `interrupt_session` reçoit un `turnId` **non vide** — il est optionnel dans le code Rust, et sans lui l'interruption est refusée. Reproduire ensuite un arrêt depuis l'interface avec une trace des appels.

**L'observation d'interface** — `Stopping…` qui ne se résout pas — **reste inexpliquée** et mérite d'être reproduite avant tout correctif : c'est la leçon des six faux constats.

## Avant de toucher au code : reproduire

**Pour chacun de ces chantiers, la première étape est de reproduire le défaut de façon fiable.** Cette campagne a montré six fois qu'un constat d'absence non reproduit cachait une erreur de méthode. Un correctif écrit sans défaut reproduit est une supposition, et j'en ai retiré un pour cette raison exacte (le correctif `prefers-contrast`, round 16).

## Les outils de mesure, à utiliser plutôt que `native-smoke.mjs`

`native-smoke.mjs` a produit **trois faux négatifs** documentés. Pour toute vérification de contrat, préférer les sondes qui **enregistrent en continu** plutôt que celles qui attendent un événement précis :

| Sonde | Ce qu'elle établit |
|---|---|
| `msp-list-sessions.mjs` | ce que le host connaît, avec métadonnées |
| `msp-resume-free-session.mjs` | la reprise fonctionne sur une session persistée et libre |
| `msp-session-survival.mjs` | une session sans tour ne se persiste pas |
| `msp-interrupt-notifications.mjs` | le terminal après interruption, toutes notifications enregistrées |
| `msp-user-shell-capability.mjs` | la capacité et l'item `userShell` |
| `msp-projection-check.mjs` | modèle et effort, avec relecture de la session |
| `msp-approval-mode-check.mjs` | les modes d'approbation réellement acceptés |

## La leçon, pour la prochaine session

**Une erreur de contexte n'est pas une absence de capacité.** Six fois, un appel refusé — session non persistée, capacité mal demandée, paramètre manquant, mauvaise forme, attente trop courte, mode inexistant — a été lu comme « le host ne sait pas faire ». Avant d'écrire qu'une capacité manque, vérifier que **le scénario la sollicitait réellement**, sur une ressource **persistée**, avec les **paramètres exigés**.
