# Barre « Find in conversation » — la cause réelle (21 septembre 2026)

Signalement : « ctrl f find widget is weirdly floating over conversation ». Le symptôme décrit était exact ; **ma première explication ne l'était pas**, et ce document conserve les deux parce que le chemin compte.

## Deux hypothèses fausses, écartées par la mesure

### « Le fond est transparent, le texte transparaît »

**Faux.** `getComputedStyle` donne un fond **opaque** et l'échantillonnage des pixels le confirme : sur une zone vide de la barre, **384 pixels sur 384** valent exactement `238,243,251`, la couleur du fond de la barre. Aucune encre du transcript.

### « Le `z-index` perd l'arbitrage »

**Faux.** L'empilement au même point est `["stream-find", "stream-find-dock", "msg-footer"]` : la barre gagne. Un message en `static; z-index: auto` ne peut pas passer devant un élément `sticky; z-index: 2` avec un fond opaque.

Ces deux vérifications ont coûté du temps, et elles étaient **nécessaires** : sans elles j'aurais « corrigé » une transparence inexistante.

## La cause réelle, géométrique

| Mesure | Valeur |
|---|---|
| Largeur du flux de conversation | **1034 px** |
| Largeur de la carte de recherche | **760 px** |
| Espace de chaque côté | **137 px** |

La barre était **elle-même** l'élément `sticky` : une carte centrée de 760 px dans un flux de 1034 px. Le texte **défilait donc dans les 137 px de chaque côté** pendant que la carte restait immobile au milieu, sans rien qui l'ancre au bord.

C'est précisément ce que « floating over conversation » décrit : non pas du texte *derrière* la carte, mais du contenu qui continue de défiler **à côté** d'un élément qui, lui, ne bouge plus. L'ombre portée (`box-shadow: 0 6px 18px`) renforçait l'effet en la détachant du fond.

## Le correctif

Un conteneur **pleine largeur** (`.stream-find-dock`) porte désormais le `sticky`, un fond opaque et un liseré de séparation. La carte garde exactement son dessin et reste centrée dedans.

```css
.stream-find-dock {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: -16px -8px 4px;   /* annule le padding du flux, bord à bord */
  padding: 8px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}
```

Les marges négatives annulent le `padding: 16px` et le `padding: 8px` latéral du flux, pour que la bande aille **bord à bord** au lieu de flotter en encart.

**Conséquence mesurée :** la bande fait **980 px** et couvre donc les 137 px de chaque côté. Plus rien ne défile à côté de la carte. Le défilement total passe de 648 à 669 px — le coût assumé de la bande.

## Ce qui a été vérifié après le changement

| Contrôle | Résultat |
|---|---|
| Ouverture par le bouton, saisie, fermeture | OK |
| Recherche d'un terme **présent** (« BETA ») | **3 correspondances**, panneau de résultats visible |
| Empilement sous la bande pendant qu'elle est épinglée | `stream-find-dock` gagne, le contenu est couvert |
| Débordement des 7 onglets du panneau | **0** — aucune régression |
| Tests / build | **1085, 0 échec** / vert |

## Une note de méthode

J'ai testé la recherche avec « audio » et obtenu **« 0 matches »**, ce que j'ai d'abord pris pour un défaut. C'était mon propre test qui cherchait dans la mauvaise conversation. Le contrôle qui tranche est de chercher un terme **dont on a d'abord vérifié qu'il figure dans le transcript** : `ux-find-bar-finds.mjs` lit le texte du flux, confirme la présence du terme, puis cherche. Un résultat nul devient alors une preuve au lieu d'une ambiguïté.

C'est la même leçon que le reste de cette campagne : **un test qui passe ne vaut rien s'il ne peut pas échouer**, et une absence observée n'est une absence de capacité que si l'on a vérifié qu'on regardait au bon endroit.
