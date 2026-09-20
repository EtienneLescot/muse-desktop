# Coût de rendu d'un long transcript — mesures (M1-13, 20 septembre 2026)

Mesures relevées par le protocole `Performance` de CDP dans la webview, sur le sidecar Muse Windows natif 1.3.0.
Elles répondent au critère que la roadmap pose comme condition de la virtualisation complète : « une mesure réelle de mémoire et de temps de rendu ».

## Protocole

```powershell
node scripts/cdp-perf.mjs --entries 2000
```

Le script relève d'abord une **référence** sur le profil réel, écrit 2 000 entrées au format persisté, recharge, relève les métriques, puis déclenche **une page incrémentale de 120 entrées** et relève le delta. Le journal d'origine est restauré dans un `finally`.

## Résultat

### Chargement avec 2 000 entrées

| Mesure | Valeur |
|---|---|
| `firstContentfulPaint` | **20 ms** |
| `domInteractive` | 17 ms |
| `domContentLoaded` | 160 ms |
| `loadEvent` | 162 ms |
| Nœuds DOM totaux | 1 942 → **2 938** |
| **`JSHeapUsedSize`** | 12 233 → **12 392 KiB** |
| `LayoutDuration` (cumulé depuis l'activation) | **0,012 s** |
| `ScriptDuration` (cumulé) | **2,022 s** |
| `LayoutCount` | 15 |
| Articles montés dans le journal | **160** sur 2 000 |
| Nœuds DOM du journal | **967** |
| `scrollHeight` du journal | **173 252 px** |
| Nœuds DOM totaux de la page | 1 954 |

### Coût d'une page incrémentale (120 entrées)

| Mesure | Delta |
|---|---|
| `LayoutDuration` | **+0,001 s** |
| `RecalcStyleDuration` | **+0,001 s** |
| `ScriptDuration` | **+0,071 s** |
| Nœuds DOM du journal | **967 → 967 (inchangé)** |
| Articles montés | 160 → **160 (inchangé)** |

## Lecture

**Trois constats :**

1. **Le coût de rendu de la fenêtre est négligeable.** `LayoutDuration` cumulé reste à **12 ms** pour 2 000 entrées, et une page incrémentale coûte **1 ms de layout**. La fenêtre bornée fait son travail : ni le nombre d'articles (160) ni le nombre de nœuds du journal (967) ne bougent quand on charge 120 entrées de plus.
2. **Le temps est passé dans le script, pas dans le layout** : `ScriptDuration` cumulé atteint **2,022 s** contre 12 ms de layout. Si optimisation il y a, elle est côté JavaScript — hydratation, recherche, calcul de fenêtre — pas côté DOM ou CSS.
3. **La mémoire est contenue** : environ **+160 KiB** de tas JS pour passer de la référence à un journal de 2 000 entrées. Le journal lui-même pèse 373 671 octets en `localStorage`.

## Réserves — importantes

- **Ces chiffres ne sont pas une mesure de performance au sens strict.** La mesure a été prise sur un **build de développement** (Vite, non minifié) avec le **debug distant actif**, ce qui ajoute une surcharge non quantifiée. Un build de release donnerait d'autres valeurs.
- **`wallClockToSettledMs` (14 014 ms) n'est pas exploitable** : il inclut ma propre attente fixe de 14 s après le rechargement, pas un temps de rendu.
- **Aucune mesure d'image ni de fréquence.** Je n'ai pas mesuré le temps de rendu par image, ni la réactivité au défilement continu, ni le comportement à 10 000 entrées.
- **Une seule machine, un seul profil.** Pas de variance, pas de répétition, pas de comparaison entre configurations.
- La **virtualisation de la sidebar** évoquée par la roadmap comme conditionnée à ces mesures n'a **pas** été examinée ici : ces chiffres portent sur le journal de conversation.

**Je ne présente donc pas ces mesures comme la preuve qui débloque la virtualisation complète.** Elles donnent un ordre de grandeur et déplacent la question : le goulot observé est le script, pas le layout.

## Restauration

Journal d'origine réécrit et **vérifié** : 21 205 octets, `hasSynthetic: false`. Aucun état de profil laissé modifié.

## État de M1-13

| Critère | État |
|---|---|
| Fenêtre DOM bornée sur 2 000 entrées | mesuré |
| Chargement incrémental (scroll + bouton) | mesuré |
| Finder hors fenêtre | mesuré |
| Coût de rendu et mémoire | **ordre de grandeur obtenu**, sur build de développement |
| Qualification assistive native | **non exercée** |
| macOS / Linux | hors périmètre |

**M1-13 reste ouvert** : la qualification assistive n'est pas faite, et ces mesures de performance ne valent que pour un build de développement sur une machine.
