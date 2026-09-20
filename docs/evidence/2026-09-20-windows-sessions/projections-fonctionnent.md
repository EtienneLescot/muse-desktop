# Les projections fonctionnent — cinquième et dernier faux écart (20 septembre 2026)

**Ce document corrige l'écart n° 4 de [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, le dernier qui restait ouvert. Il tombe comme les quatre autres.

## La cause : mes paramètres étaient faux

| Méthode | Ce que j'envoyais | Ce que le host attend |
|---|---|---|
| `session/setModel` | `{ sessionId, modelId }` | `{ commandId, sessionId, model: { modelId } }` |
| `session/setReasoningEffort` | `{ sessionId, effort }` | `{ commandId, sessionId, reasoningEffort }` |

Mes appels étaient refusés en `invalidParams` — **ce qui ne dit rien de la capacité du host**. J'avais déjà écrit cette leçon dans le rapport au round 59, après avoir failli conclure à un écart sur la base de la même erreur. Le constat d'origine, lui, venait de `native-smoke.mjs` dont l'irrégularité est documentée.

## La mesure, avec les bonnes formes

Session `01a0c07a`, catalogue `model/list` : `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`.

**Changement de modèle :**

| Étape | `session.modelId` |
|---|---|
| avant | `muse-spark-1.3-contributor` |
| `setModel({ model: { modelId: "muse-spark-1.3" } })` | **`accepted`** |
| après | **`muse-spark-1.3`** |

**La projection est visible sur la session relue.**

**Changement d'effort de raisonnement :**

| Appel | Accusé | Notification |
|---|---|---|
| `setReasoningEffort("none")` | `accepted` | `session/reasoningEffortChanged` |
| `setReasoningEffort("high")` | `accepted` | `session/reasoningEffortChanged` |
| `setReasoningEffort("ultra")` | `accepted` | `session/reasoningEffortChanged` |

**Trois appels, trois notifications.** Le host **signale** le changement par une notification dédiée, et `session/modelChanged` pour le modèle.

**Ce que la session ne porte pas :** un champ `reasoningEffort` reste **absent** de l'objet session. C'est le seul point où l'on peut dire que la projection n'est pas dans la session — mais elle est **dans la notification**, ce qui est une forme de projection au moins aussi exploitable pour un client.

## Les cinq écarts : aucun n'existe

| Écart | Affirmé dans le rapport | Mesuré |
|---|---|---|
| 1 | `session/read` et `session/resume` absents | **fonctionnels** sur une session persistée |
| 2 | aucun terminal après interruption | **`turn/completed` émis** (+39 ms) |
| 3 | `userShell` accepté sans item ni sortie | **item publié, sortie incluse** |
| 4 | projections non rapportées | **modèle visible sur la session, effort signalé par notification** |
| 5 | durabilité constamment `ephemeral` | **variable** |

**Les cinq constats d'absence étaient cinq artefacts de méthode.** Aucun ne décrit une limite du sidecar.

## Ce que le client peut faire dès maintenant, sans changement du host

- **Reprendre une session persistée** : `session/resume` puis `session/read`.
- **Découvrir les sessions** : `session/list`, jamais appelé par l'application.
- **Lancer une commande et en lire la sortie** : demander la capacité sous la forme `capabilities: { requestedCapabilities: ["userShell"] }`, puis lire l'item `userShell`.
- **Changer de modèle ou d'effort** : `{ model: { modelId } }` et `reasoningEffort`, puis écouter `session/modelChanged` et `session/reasoningEffortChanged`.

**Aucun de ces parcours ne dépend d'une évolution du sidecar.**

## Ce qui reste, et qui n'est pas un écart

- **`approval_mode` au-delà de `promptUnmatched`** : la seule limite encore debout dans le rapport, et elle n'a **pas** été remesurée. `session/read` expose `approvalMode` — dont on lit ici `{mode: "onRequest", source: "startup", lastCommandId: null}` — ce qui ouvre peut-être une mesure plus simple qu'avant.
- **Le faux négatif de `native-smoke.mjs`** sur le chemin de contrôle reste inexpliqué. Trois de ses défauts sont corrigés, le quatrième est documenté.

## Reproductibilité

```powershell
node scripts/msp-projection-check.mjs
```

Lance un host, démarre une session, appelle les deux méthodes avec les **formes correctes**, relit la session et enregistre les notifications. Aucune supposition sur les noms de champs : le script affiche les champs réellement présents.
