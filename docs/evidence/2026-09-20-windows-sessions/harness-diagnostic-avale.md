# Le harness : ce que j'ai trouvé, et où je m'arrête (20 septembre 2026)

Suite de [`correctif-harness-insuffisant.md`](correctif-harness-insuffisant.md). J'y laissais trois hypothèses non tranchées. Ce document en **élimine deux**, en **ajoute une mesure inattendue**, et **s'arrête** au point où je ne peux plus avancer sans risque.

## Hypothèse écartée : l'attente serait enregistrée trop tard

Je soupçonnais une course — une attente enregistrée après l'arrivée de la notification ne la verrait jamais. **Faux.** `waitForNotification` (`native-smoke.mjs:307`) commence par :

```js
const existing = notifications.find(
  (notification) => notification.method === method && predicate(notification.params),
);
if (existing) return Promise.resolve(existing.params);
```

Il **consulte d'abord les notifications déjà reçues**, puis enregistre une attente. La course est donc gérée, et mon hypothèse la plus probable tombe.

## Hypothèse écartée : les `turnId` se confondraient entre hosts

Deux hosts lancés dans la même milliseconde produisent des `turnId` au **préfixe identique** — `01a0c064` dans un essai, `01a0c065` dans un autre. J'ai cru à une collision qui ferait apparier le terminal du mauvais host.

**Faux, et la mesure est nette :**

```
turnId A (complet) : 01a0c065-7833-7bcf-a0e4-1ee48dd10ad0
turnId B (complet) : 01a0c065-7833-7053-845d-ffb4c96265b7
IDENTIQUES ?       : false
```

Les identifiants sont **distincts** ; le préfixe commun vient du fait que les deux hosts démarrent dans la même milliseconde, et un UUIDv7 commence par un horodatage. **Une fausse alerte de ma part**, levée par la comparaison des chaînes complètes.

## Une mesure inattendue : sans interruption, pas de terminal

Le même essai, **sans** `turn/interrupt`, a produit **zéro** `turn/completed` sur les deux hosts en 4 secondes :

```
terminal A : []
terminal B : []
```

Alors que **avec** interruption, les deux hosts émettent leur terminal — à **+2 064 ms** et **+3 974 ms** selon l'exécution.

**Mon probe initial avait donc raison deux fois, et pour une raison plus précise que je ne le pensais :** `turn/completed` est bien émis, mais **après une interruption**, pas comme une fin naturelle dans cette fenêtre. C'est ce qui explique aussi pourquoi mes mesures donnaient +39 ms dans un cas et +2 019 ms dans l'autre : le délai dépend du prompt et de la machine, pas d'une constante.

## Ce que cela implique pour le harness

Le délai du smoke est de **2 500 ms** par alias, trois alias en séquence. Or j'ai mesuré le terminal à **+2 064 ms** et **+3 974 ms**. **La marge est mince à nulle** : sur un host plus lent que le mien au moment du test, le terminal arrive après l'expiration.

**C'est l'explication la plus cohérente** avec tout ce que j'ai mesuré — mais je ne l'ai **pas** vérifiée en relevant le délai exact du smoke sur un échec, parce que le harness **avale son propre diagnostic** :

```js
// waitForTerminalNotification
catch {
  // Compatible hosts use different terminal aliases. ...
}
```

Les trois tentatives échouent en silence, et le message final ne conserve **que** `did not emit a terminal notification` — sans la liste des notifications vues, que `waitForNotification` avait pourtant construite :

```js
reject(new Error(`${label} timed out waiting for ${method} (notifications: ${seen})`));
```

**Le harness jette l'information qui permettrait de trancher.** C'est le troisième défaut trouvé dans cet outil, après le `turnId` manquant.

## Décision : je m'arrête ici

Trois raisons, et je les assume :

1. **Le défaut restant est dans mon outillage, pas dans le produit.** Le host émet son terminal après interruption, c'est mesuré quatre fois avec le bon `turnId`. Le produit n'est pas en cause.
2. **Poursuivre demanderait un troisième correctif sur le harness** — remonter le délai et/ou préserver le diagnostic — sur un outil dont deux défauts viennent d'être trouvés. Empiler des correctifs non validés dans un instrument de mesure est exactement ce qui a produit les trois faux constats de cette campagne.
3. **Mon budget de contexte est presque épuisé.** Continuer maintenant reviendrait à travailler sans la marge nécessaire pour vérifier ce que je fais, ce qui est précisément la condition dans laquelle j'ai commis mes erreurs précédentes.

## Ce qu'il faudrait pour finir, précisément

1. **Préserver le diagnostic** : dans `waitForTerminalNotification`, ne pas avaler les erreurs des trois alias — remonter la liste des notifications vues au lieu du seul message final.
2. **Élargir le délai** : 2 500 ms est inférieur au `+3 974 ms` mesuré sur un host chargé.
3. **Réexécuter** `--exercise-control --exercise-terminal` et vérifier qu'il rapporte `terminalMethod: turn/completed` au lieu de `terminalNotification: unsupported`.

Ces trois étapes sont bornées et vérifiables. Elles ne sont **pas faites**, et je ne les présente pas comme telles.

## Bilan de l'enquête sur le terminal

| Affirmation | Statut |
|---|---|
| Le host émet `turn/completed` après `turn/interrupt` | **prouvé** — 4 mesures, bon `turnId` |
| Sans interruption, pas de terminal dans la fenêtre observée | **prouvé** — 2 hosts, 4 s |
| `turn/interrupt` exige `turnId` | **prouvé** — code + mesure |
| Le harness omettait ce `turnId` | **prouvé** — corrigé |
| Le correctif fait passer `--exercise-terminal` | **réfuté** — échoue encore |
| L'attente s'enregistre trop tard | **écarté** — `waitForNotification` lit d'abord le tampon |
| Les `turnId` se confondent entre hosts | **écarté** — distincts, seule l'horodatage coïncide |
| Le délai de 2 500 ms est trop court | **hypothèse cohérente, non vérifiée** |
