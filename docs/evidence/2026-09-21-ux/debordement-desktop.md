# Débordement du panneau de travail — défauts réels et instrument réparé (21 septembre 2026)

Remplace la version précédente de ce document, dont **tous les chiffres étaient faux** : ils venaient d'un détecteur qui comptait la troncature volontaire comme un défaut. Ce qui suit a été mesuré avec un instrument dont l'auto-test passe, et vérifié sur 13 largeurs de fenêtre réelles.

## Pourquoi les chiffres précédents étaient inutilisables

Le détecteur comptait tout élément dont `scrollWidth > clientWidth`. Il signalait donc comme défauts :

- `.sr-only` — une boîte de **1×1 px** avec `overflow: hidden`. Son « débordement » de **753 px** était la longueur du texte caché, invisible par conception ;
- les **51 règles `text-overflow: ellipsis`** de la feuille de style — c'est-à-dire des éléments qui faisaient exactement leur travail.

Il souffrait en outre de trois bugs qui se compensaient en produisant des rapports plausibles :

| Bug | Effet |
|---|---|
| `offsetParent !== null` comme test de visibilité | `null` pour `<body>` **et tout élément `position: fixed`** → la sonde de contrôle s'auto-déclarait invisible |
| `getComputedStyle().paddingRight` renvoie la **chaîne** `"0px"` | `"0px" * 1` → `NaN` → `NaN > worst` toujours faux → **tous** les éléments silencieusement écartés |
| Les lignes étaient nommées d'après l'**enfant** qui dépassait | le conteneur fautif était annoncé sous le nom de son descendant → **chaque rapport désignait le mauvais élément** |

Le détecteur porte désormais un **auto-test bloquant** : une sonde de 300 px dans une boîte de 100 px doit être signalée à **+200 px**, et la même sonde avec `overflow-x: hidden` doit être **ignorée**. Aucun chiffre n'est imprimé si l'un des deux cas échoue.

## Défauts réels, et corrigés

Trois causes distinctes, toutes des **planchers intrinsèques** que la grille ne pouvait pas franchir.

### 1. Files — planchers fixes trop hauts

`grid-template-columns: minmax(180px, .85fr) minmax(250px, 1.4fr)` + `gap: 12px` impose **442 px** pour **411 px** disponibles. Les deux colonnes étaient à leur largeur `min-content` (172 et 248 px) : elles ne pouvaient pas rétrécir.

**Corrigé** : planchers abaissés à 140 / 190 px, `min-width: 0` sur les deux colonnes.

### 2. Desktop — plancher intrinsèque supérieur à la largeur du panneau

La grille réclamait **434 px** pour **405 px**. Cause mesurée : les titres de fenêtres sont des jetons insécables — `Cua.AgentCursorOverlay.default` a une largeur `min-content` de **223 px**, et sa ligne secondaire 207 px. Comme `min-width: auto` sur un élément de grille interdit de descendre sous cette valeur, la colonne imposait son plancher.

**Corrigé** : `min-width: 0` sur les deux colonnes **et**, surtout, un vrai correctif d'usage — ces boutons font 152 px pour un contenu de 223 px, donc le texte était **rogné net sans aucun repère**. Ils portent maintenant `text-overflow: ellipsis`.

### 3. `.desktop-control-click` — quatre pistes pour 218 px

`auto 68px 68px auto` demande **265 px** dans une colonne de 218 px. `auto` a un plancher `min-content`, donc le libellé « Click inside window » imposait la largeur et le bouton sortait du panneau.

**Corrigé** : le libellé occupe sa propre ligne pleine largeur, les deux champs et le bouton se partagent la suivante.

## Deux pièges de méthode, qui ont coûté le plus de temps

### Le piège de cascade

`main.tsx` importe `App.css` **puis** `Desktop.css`. À spécificité égale, le **fichier importé en dernier gagne** — donc ma media query dans `App.css` perdait contre la règle de base de `Desktop.css`, et la grille Files restait à deux colonnes jusqu'à une fenêtre de 720 px, avec jusqu'à **104 px** de débordement.

**Règle retenue** : une règle de base et sa media query de repli vivent **dans le même fichier**. `App.css` importé en premier ne peut pas surcharger `Desktop.css` de façon fiable.

### Le piège du seuil proportionnel

La largeur du panneau **ne suit pas proportionnellement la fenêtre**. Mesurée sur ce build :

| Fenêtre | Panneau |
|---|---|
| 1440 | 478 |
| 1080 | 340 |
| 900 | **369** |
| 760 | 305 |

La valeur **remonte** entre 1080 et 900 px : la colonne de conversation atteint son propre minimum et le panneau récupère la différence. Un raisonnement en « 40 % de la fenêtre » est donc faux **aux deux extrémités**. Les seuils retenus viennent d'un balayage de largeurs réelles, pas d'un calcul.

### Et un troisième, sur mes propres captures

`ux-review-captures.mjs` force la largeur du panneau **sans** changer celle de la fenêtre. Comme les règles responsives réagissent à la fenêtre, cela produit un état **qu'aucune fenêtre réelle ne peut atteindre** : un panneau étroit dans une fenêtre large, où la grille reste légitimement à deux colonnes. Les captures correspondantes ont été supprimées et le script porte désormais l'avertissement.

## Vérification

```
7 onglets · auto-test OK · 0 débordement
```

| Largeur | Files (pistes) | Desktop (pistes) | Fuites profondes |
|---|---|---|---|
| 1440 | 2 | 2 | 0 |
| 1366 | 2 | 2 | 0 |
| 1280 | 2 | 1 | 0 |
| 1200 → 720 | 1 | 1 | 0 |

**13 largeurs testées, 0 débordement**, mesures superficielles **et imbriquées**. Le balayage mesure tous les descendants du panneau, pas seulement les trois grilles — c'est précisément la restriction qui avait laissé passer une fuite de 8 px dans le bloc d'observation.

Le côte-à-côte d'origine du panneau Desktop est **conservé dès 1366 px** ; l'empilement est réservé aux largeurs où deux colonnes ne tiennent réellement pas.

## Outils

| Script | Rôle |
|---|---|
| `scripts/ux-panel-overflow.mjs` | débordements par onglet, auto-test bloquant, préconditions assertées |
| `scripts/ux-breakpoint-sweep.mjs` | balayage de 13 largeurs, superficiel et imbriqué |
| `scripts/ux-review-captures.mjs` | captures + assertions structurelles |

## Ce qui aurait dû se passer

Le défaut initial de 31 px sur Files était réel et **la correction tenait en une ligne**, mais elle était noyée sous 700 px de faux positifs : `.sr-only` à 753 px, `.terminal-meta` qui tronquait proprement, `.file-name` avec son ellipse. **Un instrument qui signale la troncature volontaire comme un défaut rend le vrai défaut invisible** — et m'a fait écrire puis retirer deux correctifs qui traitaient du néant.
