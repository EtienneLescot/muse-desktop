# Le composeur rognait son propre sélecteur de modèle (21 septembre 2026)

Signalé par une capture d'écran : dans le composeur, la pastille du modèle sort du cadre et son libellé est coupé en plein glyphe, alors que les quatre autres contrôles tiennent sur la ligne.

## La cause : un correctif qui a cessé de s'appliquer

Le défaut avait **déjà** été corrigé une fois. La passe 1 l'avait diagnostiqué ainsi — « le libellé du modèle se coupait sur deux lignes » — et corrigé par :

```css
.composer-model > button {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22ch;
}
```

Puis le bouton « modèle » a été **remplacé** par un sélecteur `<details>` + `<summary>` (UX-212, même journée) pour que le clic ouvre une liste au lieu du panneau Réglages. Le sélecteur CSS ne correspondait plus à rien : plus de plafond, plus d'ellipse. La règle morte est restée dans la feuille, et sa seule lecture suffisait à croire le sujet traité.

Et le libellé est redevenu long au même moment, pour une autre raison : `model_id` est désormais transmis par Rust, donc la pastille affiche `muse-spark-1.3-contributor` au lieu du mot générique « Model » qui masquait le problème.

## Ce que la mesure a établi

`node scripts/ux-composer-overflow.mjs`, avant correctif (fenêtre 1296 px, la largeur réelle de la fenêtre de test) :

| Mesure | Valeur |
|---|---|
| Largeur intérieure du composeur | 538 px |
| Défilement de `.composer-actions` | **579 px** |
| Pastille du modèle : contenu / boîte accordée | **199 px / 154 px** |
| Libellé à 1100 px | **0 px** — la pastille devient vide |
| Largeurs en défaut | **10 sur 11**, de +43 px à +305 px |

Le composeur n'est **pas monotone** en fonction de la fenêtre : 416 px de large à 1024 px de fenêtre, 610 px à 900 px (le panneau de travail prend sa part). Une media query sur la largeur de fenêtre aurait donc déclenché au mauvais endroit — la mesure l'a écartée avant l'écriture, pas après.

## Le correctif

1. **La ligne peut passer à la seconde** — `.composer-context { flex-wrap: wrap; row-gap: 6px }`. Les quatre pastilles fixes ne peuvent pas rétrécir (`white-space: nowrap`), donc une ligne qui ne peut pas se rompre n'a que deux issues, toutes deux fausses : écraser la pastille du modèle jusqu'à la vider, ou la laisser sortir du cadre.
2. **La pastille ne se colle plus à droite** — `margin-left: auto` retiré de `.composer-model`. Sur une ligne complète il n'avait aucun effet ; sur une ligne rompue il envoyait la pastille seule à droite, ce qui se lisait comme un élément tombé du groupe.
3. **L'ellipse reste, en dernier recours** — le libellé garde `overflow: hidden` + `text-overflow: ellipsis` avec `min-width: 0`, pour un identifiant plus long qu'une ligne entière.

Vérifié : `11 largeurs testees, aucun rognage`. Le libellé testé — `muse-spark-1.3-contributor`, 25 caractères — reste **entier** (171/171) à toutes les largeurs : c'est le retour à la ligne qui le protège, pas la troncature. L'ellipse demeure le repli assumé pour un libellé plus long que la ligne, ce que le catalogue du host peut fournir (`displayLabel` vient du host) : le garde-fou la **signale** sans la compter comme un échec, puisqu'elle est voulue.

| | Avant (`pass3/composer-avant.png`) | Après (`pass3/composer-apres.png`) |
|---|---|---|
| 1296 px | pastille coupée par le bord droit de la carte | ligne rompue, pastille entière, alignée sous Attach |
| 1366 px | +43 px de débordement | 0 |
| 640 px | +305 px | 0 |

## Le garde-fou, et sa preuve

`scripts/ux-composer-overflow.mjs` balaie 11 largeurs et vérifie trois choses : la ligne ne défile pas, le contexte ne défile pas, aucun descendant ne peint hors de la boîte de padding du composeur, et la pastille du modèle ne s'écrase pas sous 90 px. La précondition est assertée — sans conversation ouverte il n'y a pas de composeur, et mesurer zéro n'aurait rien prouvé.

La troncature du libellé, elle, est **rapportée et non comptée comme un échec** : l'ellipse est le repli voulu quand un `displayLabel` du host dépasse la ligne.

**Le garde-fou peut échouer** : correctif retiré (`git stash push -- src/App.css`), il rapporte **10 largeurs sur 11** en défaut avec les valeurs ci-dessus. Remis, il rapporte 0.

Un piège de sonde au passage, du même genre que les précédents : le contenu d'un `<details>` fermé **conserve un rectangle**. Chrome le masque par `content-visibility`, donc `display`, `visibility` et `getClientRects()` disent tous « rendu ». Le popover du modèle, large de 300 px, était compté comme débordant de plus de 200 px **à toutes les largeurs** — un rapport plausible et entièrement faux. Le prédicat écarte maintenant `details:not([open])`.

## Ce qui n'a pas été fait

- Le catalogue n'offre **aucun libellé plus court** : `model/list` renvoie l'identifiant comme son propre `displayLabel` pour les quatre modèles. Raccourcir la pastille est donc une décision produit (quelle forme ?), pas un correctif d'affichage — la troncature et le retour à la ligne sont les deux seules options honnêtes en attendant.
- Les deux autres pastilles longues (`Attach`, `Voice`) ne sont pas concernées : elles sont courtes par construction.
