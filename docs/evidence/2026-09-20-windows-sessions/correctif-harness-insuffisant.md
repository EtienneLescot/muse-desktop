# Correctif du harness : nécessaire mais non suffisant (20 septembre 2026)

Suite de [`terminal-apres-interruption.md`](terminal-apres-interruption.md). J'y annonçais que le harness « a besoin d'un correctif » et que je le ferais. **Je l'ai fait, et il ne suffit pas.** Ce document dit ce qui est corrigé, ce qui reste, et pourquoi je m'arrête là.

## Le correctif appliqué

`scripts/native-smoke.mjs` appelait `turn/interrupt` sans `turnId` :

```js
await host.request("turn/interrupt", {
  commandId: uuidv7(),
  sessionId: sessions[index],
  retract: false,          // ← turnId manquant
});
```

alors que `turnIds[index]` était disponible deux lignes plus haut, et que la vérification de la réponse l'attendait. Ajouté :

```js
turnId: turnIds[index],
```

**Ce correctif est nécessaire** : le host exige `turnId`, et sans lui la requête est refusée en `invalidParams` — vérifié par lecture du code et par la mesure.

## Mais le test échoue toujours

```
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
→ host-A did not emit a terminal notification for 01a0c05f-…
```

Le rapport n'est **même pas écrit** : l'échec survient avant.

## Ce que la mesure isole

Le scénario **exact** du smoke — `turn/start` avec le prompt `"Native control smoke probe. Stop immediately."`, puis `turn/interrupt` **immédiat** avec `{commandId, sessionId, turnId, retract}` — exécuté en isolation :

| Étape | Résultat |
|---|---|
| `turn/start` | `accepted`, `turnId` retourné |
| `turn/interrupt` | **`ok`**, `status: accepted`, **même `turnId`** |
| Terminal | **`turn/completed` à +2 019 ms** |

**La séquence fonctionne.** Le host émet le terminal, avec le bon `turnId`, en 2 secondes.

## Donc il reste une cause que je n'ai pas identifiée

Le smoke et mon probe de scénario diffèrent sur au moins trois points, et je **n'ai pas** déterminé lequel est en cause :

1. **Deux hosts** en parallèle chez le smoke, un seul chez moi ;
2. le smoke attend via sa propre fonction `waitForNotification(method, predicate, 2_500)` — **peut-être enregistrée trop tard**, après que la notification est déjà arrivée (mon terminal arrive à +39 ms dans un cas, +2 019 ms dans l'autre) ;
3. le smoke interroge **trois alias en séquence** (`turn/completed`, `turn/retracted`, `turn/stopped`), ce qui peut épuiser son budget avant que le bon n'arrive.

**L'hypothèse 2 est la plus probable** — une attente enregistrée après l'événement ne le verra jamais, et c'est exactement le genre de course que ce harness est censé mesurer. Mais **je ne l'ai pas vérifiée**, et je ne l'écris donc pas comme un résultat.

## Décision : je m'arrête ici, et je le dis

Trois raisons :

1. **Le correctif appliqué est juste** — il répare un vrai défaut, celui de transmettre un paramètre exigé. Le garder est fondé même si le test échoue encore.
2. **Poursuivre demanderait d'instrumenter `native-smoke.mjs` lui-même** pour voir à quel instant l'attente s'enregistre par rapport à l'arrivée du terminal. C'est faisable, mais cela commence à empiler des modifications sur un harness dont **deux** défauts viennent d'être trouvés — le risque de le rendre moins fiable en croyant le réparer est réel.
3. **Le résultat utile est déjà acquis** : le host émet son terminal après interruption, c'est mesuré quatre fois, avec le bon `turnId`. Le défaut restant est **dans mon outillage**, pas dans le produit.

## Ce qui est établi, et ce qui ne l'est pas

| Affirmation | Statut |
|---|---|
| Le host émet `turn/completed` après `turn/interrupt` | **prouvé** — +39 ms et +2 019 ms selon le prompt |
| `turn/interrupt` exige un `turnId` | **prouvé** — le code du host et la mesure concordent |
| Le harness omettait ce `turnId` | **prouvé** — corrigé |
| Le correctif fait passer `--exercise-terminal` | **réfuté** — le test échoue encore |
| L'attente de notification est enregistrée trop tard | **hypothèse non vérifiée** |

## Ce qu'il faudrait pour finir

Instrumenter `native-smoke.mjs` : journaliser l'instant d'enregistrement de chaque `waitForNotification` et l'instant d'arrivée de chaque notification, puis comparer. Si l'attente s'enregistre après l'arrivée, le correctif est de **s'abonner avant d'envoyer la requête** — un motif que mon propre `msp-interrupt-notifications.mjs` applique déjà, puisqu'il **enregistre en continu** dès le démarrage du host plutôt que d'attendre un événement précis.
