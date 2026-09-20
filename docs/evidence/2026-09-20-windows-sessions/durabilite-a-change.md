# `sessionDurability` a changé : `ephemeral` → `durable` (20 septembre 2026)

**Ce document corrige une affirmation de [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md) §5**, qui présente `ephemeral` comme une propriété du host. La mesure ne le confirme pas.

## Les deux mesures

| Quand | Mesure | Host |
|---|---|---|
| Rounds 15–23 (matin et début d'après-midi) | **`sessionDurability: "ephemeral"`** | `initialize` sur deux hosts réels, `msp-probe` et `native-smoke` |
| Round 50 (soir), **quatre fois** | **`sessionDurability: "durable"`** | quatre hosts neufs, lancés un par un |

La mesure récente est **reproductible** : obtenue quatre fois de suite, avec et sans `requestedCapabilities: ["userShell"]`, sur des processus neufs.

## Ce que j'ai vérifié pour écarter les fausses pistes

- **La configuration n'a pas bougé** : `~/.config/muse/settings.json` date du **19/09 21:30** et `auth.json` du **19/09 20:47** — soit **avant** la première mesure `ephemeral`. Aucun des deux ne contient de champ de durabilité.
- **Ce n'est pas un effet de `clientInfo.name`** : `muse_durability_check` et `muse_list_sessions` donnent tous deux `durable`.
- **Ce n'est pas un effet des capacités demandées** : avec et sans `userShell`, le résultat est identique.

## Ce que je ne sais pas

**Je n'explique pas le changement.** Je n'ai pas la cause, et je préfère l'écrire plutôt que d'inventer une théorie. Ce qui est certain, c'est que **`sessionDurability` ne peut pas être documenté comme une constante du host 1.3.0** — sa valeur a changé sur la même machine, dans la même journée, sans modification de configuration.

## L'implication, et elle est importante pour M0-02

`session/list` énumère **9 sessions** que le host connaît, avec pour chacune son **chemin de stockage** :

```
%USERPROFILE%\.local\share\muse\sessions\<année>\<mois>\<jour>\<sessionId>\session.jsonl
```

et des métadonnées complètes : `title`, `turnCount`, `status`, `workspaceRoot`, `branch`, `updatedAt`. **Neuf sessions, onze tours pour la plus longue, persistées sur disque.**

Autrement dit, quand le rapport d'écart demandait `session/read` et `session/resume`, il les présentait comme le moyen de **retrouver un historique**. Or **l'historique est déjà là, persistant et énumérable** — ce qui manque est l'API pour lire le contenu depuis un client.

## Ce qui reste à tester, et qui pourrait fermer M0-02

Le README de campagne documente qu'après un clic sur **Reconnect**, l'application affiche :

> `This conversation could not be resumed. — MSP error -32020: session … was not found [sessionNotFound]`

**Hypothèse non testée :** si le host est désormais `durable` et que `session/list` énumère ces sessions, alors **le host connaît la session** — et l'échec de reprise viendrait du **client**, qui lance un nouveau host et ne réconcilie pas avec les sessions déjà présentes. Ce serait un **défaut côté client, corrigible**, et non un blocage du sidecar.

C'est une hypothèse, pas un résultat. Elle est testable : relancer l'application, vérifier si `session/list` voit encore la session après redémarrage, et si le client la propose à la reprise.

## Méthode

```powershell
node scripts/msp-list-sessions.mjs
node scripts/msp-list-sessions.mjs --json
```

Le script lance un host, fait le handshake **complet** (`initialize` puis la notification `initialized`, sans quoi tout appel suivant répond `Not initialized`), interroge `session/list` et affiche les métadonnées. **Lecture seule** : il n'écrit et ne supprime rien.

## Correction à porter dans le rapport d'écart

Le §5 doit dire : `sessionDurability` **varie** — `ephemeral` observé en début de campagne, `durable` en fin de campagne, cause non identifiée. La conclusion « la reprise durable n'est pas démontrée » reste valable, mais **pas pour la raison invoquée**.
