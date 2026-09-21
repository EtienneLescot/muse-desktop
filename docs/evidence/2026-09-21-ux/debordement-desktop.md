# Débordement du panneau Desktop — deux correctifs tentés, deux fois retirés (21 septembre 2026)

Complète [`corrections-passe1.md`](corrections-passe1.md). Le débordement du panneau Desktop reste **non corrigé**, et ce document explique pourquoi mes deux tentatives ont été retirées — la seconde pour une raison qui dépasse ce défaut.

## Le défaut, mesuré

Avec le panneau de travail ouvert sur l'onglet **Desktop**, six conteneurs rapportent `scrollWidth > clientWidth` :

| Conteneur | Débordement |
|---|---|
| `.work-panel-body` | +8 |
| `.desktop-control-panel` | +25 |
| `.desktop-control-layout` | +41 |
| `.desktop-window-list` | +40 |
| `.desktop-control-actions` | +43 |
| `.desktop-control-click` | +53 |

## Ce que la mesure a établi de solide

Un relevé structurel, fait **onglet Desktop réellement actif** :

```
corps du panneau : largeur 477, client 471, scroll 503
grille           : largeur 405, client 405, scroll 470
                   colonnes calculées "180px 240px", gap 14px
colonne 1 .desktop-window-list     : 180 px, scroll 197  (+25)
colonne 2 .desktop-control-actions : 240 px, scroll 275  (+35)
```

**Deux causes distinctes, et c'est ce qui rend le cas retors :**

1. **Les pistes tombent sur leurs planchers.** `minmax(180px, .8fr) minmax(240px, 1.2fr)` avec `gap: 14px` vaut **434 px** de minimum imposé, pour **405 px** disponibles. La grille déborde donc de 29 px avant même de regarder le contenu.
2. **Le contenu de chaque colonne dépasse sa piste** — 197 dans 180, 275 dans 240 — parce que `min-width: auto` sur un élément de grille lui interdit de rétrécir sous sa largeur intrinsèque.

**Corriger une seule des deux ne suffit pas**, et c'est exactement ce que ma première tentative a démontré.

## Première tentative : abaisser les planchers — retirée

`grid-template-columns: minmax(120px, .8fr) minmax(160px, 1.2fr)`.

| Conteneur | Avant | Après |
|---|---|---|
| `.desktop-control-layout` | +65 | **+41** ✅ |
| `.desktop-control-panel` | +49 | **+25** ✅ |
| `.work-panel-body` | +32 | **+8** ✅ |
| `.desktop-window-list` | +25 | **+40** ❌ |
| `.desktop-control-click` | +47 | **+53** ❌ |

Trois améliorés, deux dégradés → **retiré**. Améliorer trois mesures en en dégradant deux n'est pas une correction.

## Seconde tentative : traiter les deux causes — retirée, et pour une autre raison

`grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr)` **et** `min-width: 0` sur les enfants. C'était la correction fondée sur le relevé ci-dessus.

**Résultat : les six valeurs sont revenues strictement identiques à celles de la première tentative** — +8, +25, +41, +40, +43, +53 — ce qui est impossible pour deux CSS différents.

**Vérification faite :** le CSS était bien chargé (965 règles dans le CSSOM, ma règle présente), **mais `document.querySelector(".desktop-control-layout")` renvoyait `null`**. La grille Desktop **n'était pas dans le DOM** au moment de la mesure : mon script de préparation n'avait pas réellement activé l'onglet, et je mesurais un **état obsolète**.

**Le relevé structurel du début de ce document, lui, a été fait onglet actif** — c'est pour cela qu'il a produit les colonnes `"180px 240px"` et les `scrollWidth` par colonne. Les deux campagnes de vérification ne mesuraient donc pas la même chose, et je ne l'avais pas vu pendant deux tentatives.

## La leçon, qui dépasse ce défaut

**Trois fois dans cette passe, l'instrument a menti :**

1. Un audit de contraste comptait le contenu de popovers **refermés** — 20 faux échecs à 1,16:1, dont j'ai failli faire un bug majeur.
2. Un relevé de fenêtres ne permettait pas de confirmer un dialogue natif, et je l'ai écrit comme non vérifié plutôt que de conclure.
3. Cette mesure d'un panneau **absent du DOM**, avec des chiffres identiques que j'ai d'abord pris pour une confirmation.

Le point commun : **je mesure ce que je crois être à l'écran sans vérifier que l'état est celui que je pense.** Le correctif de méthode est partout le même — **asserter la précondition avant de mesurer**, comme le font déjà `ux-capture.mjs` et `beta-smoke.mjs`. Mes scripts de vérification ad hoc ne le faisaient pas.

## Ce qu'il faudrait pour finir

Reprendre avec un script qui **assert l'onglet actif** (`document.querySelector(".desktop-control-layout") !== null`) avant chaque relevé, puis appliquer la correction en deux causes décrite plus haut et **comparer les six conteneurs** — en exigeant qu'aucun ne se dégrade.

**Je m'arrête là sur ce défaut**, après deux tentatives et une remise en question de l'instrument. Le défaut est documenté, mesuré, et sa cause est identifiée : ce qui manque est une vérification fiable, pas une hypothèse.
