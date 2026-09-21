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

## Le correctif, en deux temps

### Premier temps : ancrer la barre (insuffisant, remplacé)

J'ai d'abord donné à la barre un conteneur **pleine largeur** qui portait le `sticky` et un fond opaque, pour que rien ne défile à côté d'elle. La bande faisait alors **980 px** et couvrait les 137 px de chaque côté.

**C'était un mieux, pas une solution.** Le signalement suivant a été : « la barre prend toujours trop de place ». Mesure : la bande occupait **61 px en permanence**, soit 69 px d'espace de tête au-dessus du premier message. Ancrer une barre ne règle pas le fait qu'elle ne devrait pas être là.

### Second temps : à la demande (retenu)

**La distinction qui manquait** — et elle a été posée par l'utilisateur :

| Contrôle | Rôle | Traitement |
|---|---|---|
| `Ctrl/Cmd+F` | trouver du texte dans **la conversation qu'on lit** | UI **à la demande**, aucun espace au repos |
| `Ctrl/Cmd+K` | chercher dans **toutes les conversations** | point d'entrée propre, icône d'en-tête |

La barre n'est donc **plus rendue du tout** tant que `Ctrl+F` n'a pas été pressé. Le conteneur a `dockHeight: 0` au repos.

**Espace rendu, mesuré : 69 px** de hauteur de tête (`headroom` : 85 px → 16 px, les 16 px étant le `padding-top` normal du flux).

### Et l'entrée de la recherche globale

Le dialogue « Search conversations » existait déjà et s'ouvrait depuis la barre latérale — mais **il disparaît quand la barre latérale est repliée**. Une icône de recherche a été ajoutée dans l'en-tête, à côté des autres contrôles, avec `Ctrl+K` en infobulle. C'est le même dialogue, pas une seconde implémentation.

## Vérification des quatre états

| État | Barre de recherche | Dialogue global |
|---|---|---|
| Au repos | absente | fermé |
| Après `Ctrl+F` | **présente** | fermé |
| Après `Échap` | absente | fermé |
| Clic sur l'icône d'en-tête | absente | **« Search conversations » ouvert** |

`Ctrl+F` est envoyé par de vrais événements clavier (`Input.dispatchKeyEvent`), pas en appelant le setter — sinon le test prouverait seulement que React sait rendre un état.

## Ce qui a été vérifié après le changement

| Contrôle | Résultat |
|---|---|
| Débordement des 7 onglets du panneau | **0** — aucune régression |
| Tests / build | **1085, 0 échec** / vert |

## Une note de méthode

J'ai testé la recherche avec « audio » et obtenu **« 0 matches »**, ce que j'ai d'abord pris pour un défaut. C'était mon propre test qui cherchait dans la mauvaise conversation. Le contrôle qui tranche est de chercher un terme **dont on a d'abord vérifié qu'il figure dans le transcript** : `ux-find-bar-finds.mjs` lisait le texte du flux, confirmait la présence du terme, puis cherchait. Un résultat nul devient alors une preuve au lieu d'une ambiguïté.

C'est la même leçon que le reste de cette campagne : **un test qui passe ne vaut rien s'il ne peut pas échouer**, et une absence observée n'est une absence de capacité que si l'on a vérifié qu'on regardait au bon endroit.

## Le vrai enseignement de ce défaut

J'ai traité **trois fois** le même symptôme avant de trouver le bon niveau :

1. `sticky` avec fond opaque — la barre était correcte, le problème était la largeur ;
2. dock pleine largeur épinglé — le défilement latéral est réglé, l'encombrement reste ;
3. **à la demande** — le symptôme disparaît.

Les deux premières réponses étaient des corrections **techniquement justes d'un défaut mal cadré**. Le signalement disait « flotte » et « trop de place » ; j'ai traité « flotte » avant d'entendre « trop de place », alors que **le second mot contenait la vraie demande** : cet élément ne devait pas être là en permanence.
