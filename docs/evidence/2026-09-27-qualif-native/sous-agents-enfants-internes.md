# Sous-agents : masquer les enfants internes + erreurs dans le bloc

Date campagne : 27/09/2026 · Plateforme : Windows 10 (build natif `src-tauri/target/debug/muse-desktop.exe`) · Commit : voir en fin de note.

## Symptôme rapporté

Sous la réponse de l'agent, des blocs « Reminder child session » inexploitables
apparaissent, avec une rangée de boutons (Close, Reopen, Interrupt, Stop, Resume,
Follow up, Read result, Agent conversation) qui **provoquent des erreurs** :

- bandeau rouge global : `subagent drill-down failed: … {sessionNotFound} [retryable=false]`
- et, dans le bloc : `The host returned no conversation for this agent.`

## Cause racine

1. Le host émet des items de kind **`reminderchild`** pour son propre interne
   (« Reminder child session » est l'objectif qu'il se donne à lui-même).
   `isSubagentItemKind` (phase.ts) et `is_subagent_item_kind` (main.rs) les
   routent dans la **même lane interactive** que les vrais sous-agents : le bloc
   complet US-6 est donc monté, avec une console de 8 commandes.
2. Ces enfants ne sont **pas** de vrais sous-agents : le host ne publie aucune
   identité `subagent/*` pour eux (superviseur : `agent_id` = item id) et
   `session/read` sur leur `childSessionId` répond `sessionNotFound`. Tous les
   contrôles ne peuvent donc qu'échouer.
3. Double signalement d'échec : le hook mettait l'erreur dans le **bandeau
   global** (`setError`) *et* le bloc affichait son propre message local
   (`failed[entry.id]`). Point resté ouvert de l'audit du 22/09
   (docs/plans/2026-09-22-audit-sous-agents.md).
4. Latence de casse repérée au passage : le routage des deltas matchait
   `"reminderChild"` en **casse sensible** alors que la table garde la casse
   brute ; un `reminderchild` minuscule tombait dans la voie **assistant**
   (pollution de la réponse).

## Correctif

- `src-tauri/src/main.rs` : `itemKind` propagé dans les annonces
  `subagent_event` (`item/started` et delta) ; routage des deltas par
  `is_subagent_item_kind` (insensible à la casse) au lieu du match littéral.
- `src/lib/phase.ts` : `isInternalSubagentItemKind()` (kind `reminderchild`,
  tolérant casse/séparateurs) + drapeau `internal` sur
  `upsertReflexivePlaceholder`.
- `src/lib/persist.ts` : champ `subagentInternal` sur `LogEntry` ;
  **rattrapage des logs historiques** au chargement (`loadLog`) : une entrée
  sous-agent sans type d'item dont le libellé du host (objectif ou 1re ligne de
  texte) est « Reminder child session » est marquée interne. Les données restent
  dans le log, seul le rendu change.
- `src/lib/subagent.ts` : `itemKind` lu du payload (`itemKind`/`item_kind`/`kind`).
- `src/hooks/useMuseSessions.ts` : le drapeau est posé à l'ingestion
  (`item/started` + `subagent_event`) ; les échecs `subagentDrilldown` /
  `subagentReadResult` **ne montent plus** dans le bandeau global — le bloc est
  le seul propriétaire du message.
- `src/components/StreamView.tsx` : les entrées `subagentInternal` ne sont pas
  rendues (pas de bloc, donc pas de boutons qui échouent).
- Tests : `test/phase.test.ts` (2), `test/subagent.test.ts` (2),
  `test/persistCaps.test.ts` (4).

## Preuves (rejouables)

| Étape | Commande | Résultat |
| --- | --- | --- |
| Tests | `npm test` | **1141 pass / 0 fail** (1133 avant campagne, +8) |
| Typage | `npx tsc --noEmit` | propre |
| Front embarqué | `npm run build` | succès |
| Natif | `cargo build` (workdir `src-tauri`, app fermée) | `Finished dev profile` en 25,18 s |
| Blocs internes masqués | CDP : `document.body.innerText` sur la conversation « yo » | `hasReminderBlock: false` — les 2 blocs « Reminder child session » de la capture ont disparu |
| Données conservées | CDP : lecture `muse-desktop.log.v1.*` | session « yo » (`…a98d2f994e78`) : 2 entrées `role=subagent` dont la 1re ligne de texte = « Reminder child session » — **toujours présentes**, seulement non rendues |
| Pas de régression (vrais sous-agents) | CDP : compte `details.msg.subagent` sur « Session 01a0c9c0 » | **6 lanes rendues** pour 6 entrées réelles (objectifs « Summarize the README… » etc.) |
| Erreur dans le bloc, pas en bandeau | CDP : clic sur `Agent conversation` (title `session/read`, enfant non lisible) | `anyGlobalDrilldownError: false` · message local `.subagent-failure` : « The host returned no conversation for this agent. » |

Rejeu : `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
puis `scripts/cdp-drive.mjs eval '<js>'` (JS entre guillemets simples, pas de `$`
ni de doubles guillemets).

## Décisions et limites

- **Masquage, pas suppression** : l'entrée reste dans le log local (preuve
  conservée) ; seul le rendu la filtre.
- Le discriminant est le **kind d'item** : c'est aujourd'hui le seul signal
  disponible (le superviseur annonce `agent_id` = item id pour tous les kinds
  sous-agent). Si le host expose une identité de sous-agent distincte, la règle
  deviendra « interne sauf identifié ».
- Le rattrapage des logs écrits avant la propagation du kind s'appuie sur le
  **libellé du host** (« Reminder child session »), uniquement pour les entrées
  sans type d'item. Un vrai sous-agent dont l'objectif serait exactement ce
  libellé serait masqué à tort — risque accepté et documenté.
- Restant ouvert (audit du 22/09) : mesurer `subagent/followupTask` sur un agent
  terminé ; exposition de `subagent/close`.
