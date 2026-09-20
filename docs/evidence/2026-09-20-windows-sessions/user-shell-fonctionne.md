# `session/userShell` fonctionne — quatrième faux écart (20 septembre 2026)

**Ce document corrige l'écart n° 3 de [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md).** Le rapport affirmait que le host accepte `session/userShell` sans jamais publier d'item. **C'est faux sur les deux points.**

## La correction décisive : la forme de la capacité

`msp-probe.mjs` demande la capacité ainsi :

```js
connect(host, { requestedCapabilities: ["userShell"] })
// → initialize({ clientInfo, capabilities: { requestedCapabilities: ["userShell"] } })
```

**La demande est imbriquée dans `capabilities`.** Mes tentatives utilisaient `capabilities: { userShell: true }`, `capabilities: ["userShell"]` ou `requestedCapabilities` au niveau racine — **les trois échouent** avec `grantedCapabilities: []`, et `session/userShell` répond alors :

> `session/userShell requires the userShell capability`

**J'ai failli conclure une seconde fois à un écart à partir d'une sonde mal formée.** C'est le même travers que pour `session/read` : une erreur de contexte lue comme une absence de capacité.

## La mesure, avec la bonne forme

| Mesure | Résultat |
|---|---|
| `grantedCapabilities` | **`["userShell"]`** |
| `session/userShell` | **`ok`** — `{"commandId": …, "status": "accepted"}` |
| Notifications publiées | **`item/started`, `item/completed`** |
| `kind` des items | **`userShell`** |
| **Sortie de la commande** | **le marqueur `muse-ushell-…` figure dans les notifications** |
| `outputRef` | absent — mais **la sortie est là** |

**Les deux affirmations du rapport tombent :** le host **publie** un item `userShell`, et l'**output est reporté** — pas par un `outputRef`, mais **dans la charge utile de l'item**.

**Méthode :** la commande exécutée écrit un marqueur unique (`muse-ushell-<horodatage>`) et le cherche dans toutes les notifications reçues après l'appel. Le marqueur est **retrouvé** — c'est une preuve par contenu, pas par présence d'un champ.

## Ce que cela change pour M1-06

« Faire lire la sortie terminal au moteur » était classé **bloqué par le contrat sidecar**. **Il ne l'est pas** : le host accepte la commande, publie un item typé, et y met la sortie.

Ce qui manque, s'il manque quelque chose, est **côté client** : le client doit demander la capacité sous la bonne forme et lire l'item. Le rapport lui attribuait un blocage qui n'existe pas.

## Le quatrième écart était mal mesuré, lui aussi

L'écart n° 4 (projections de modèle et d'effort) a été remesuré hors du harness. **Mes appels échouent en `invalidParams`** :

```
setReasoningEffort(none|high|ultra)  → invalidParams
setModel(muse-spark-1.3)             → invalidParams: missing f…
```

Un `invalidParams` sur **ma** requête ne dit **rien** de la capacité du host — c'est le même piège que `approval/listPending` sans `sessionId`, qui avait déjà produit un faux constat dans ce dépôt.

**Je n'ai donc pas de mesure valide de l'écart n° 4.** Il n'est ni confirmé ni infirmé, et le rapport ne devrait pas l'affirmer.

Au passage, `session/read` expose un champ **`approvalMode`** sur la session — utile pour M0-06, non exploité jusqu'ici.

## Bilan : les cinq écarts

| Écart | Affirmé | Mesuré |
|---|---|---|
| 1 — `session/read`, `session/resume` absents | écart | **inexistant** — fonctionnels |
| 2 — aucun terminal après interruption | écart | **inexistant** — `turn/completed` émis |
| 3 — `userShell` accepté sans item ni sortie | écart | **inexistant** — item `userShell` publié, sortie incluse |
| 4 — projections non rapportées | écart | **non mesuré** — mes appels sont refusés en `invalidParams` |
| 5 — durabilité constamment `ephemeral` | écart | **inexistant** — variable |

**Aucun des cinq écarts n'est confirmé.** Trois sont formellement démentis, un n'a jamais été mesuré valablement, et le cinquième était une constante mal lue.

## Ce que je ne fais pas, et pourquoi

Je **n'instruis pas** l'écart n° 4 maintenant : il demande de retrouver la forme correcte de `session/setModel` et `session/setReasoningEffort`, ce qui est un travail de sonde à part entière. **Mon budget de contexte est presque épuisé**, et refaire à la hâte une mesure qui a déjà produit quatre faux constats serait la pire façon de finir.

**La leçon de ces dix rounds est nette :** je n'ai pas un problème de connaissance du host, j'ai un problème d'**outillage**. Cinq constats d'absence, cinq artefacts de méthode.
