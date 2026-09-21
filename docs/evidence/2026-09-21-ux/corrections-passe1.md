# Passe UX/UI n° 1 — corrections et échecs (21 septembre 2026)

Complète [`constats-passe1.md`](constats-passe1.md). Ce document liste ce qui a été **corrigé et vérifié**, et ce qui a été **tenté puis retiré** — la seconde liste compte autant que la première.

## Corrigé, avec vérification

| # | Défaut | Correctif | Vérification |
|---|---|---|---|
| 1 | **Le libellé du modèle se coupait sur deux lignes** dans le composeur (`muse-spark-1.3-contributor` dans un bouton de 168×48 px) | `white-space: nowrap` + ellipsis à 22ch | 1 ligne, bouton 64×32 px |
| 2 | **Le thème clair violait WCAG AA** : `--muted` à `#78828a` donnait **3,62:1** sur la sidebar et **3,92:1** sur blanc, pour 4,5 requis — toute la navigation, les libellés de section, la barre de statut, les métadonnées | `--muted: #6a7279`, valeur **calculée** (la plus petite qui passe sur les deux fonds : 4,52 et 4,89) | **0 texte sous le seuil**, deux thèmes — et **verrouillé par 7 tests** (`test/paletteContrast.test.ts`) dont l'efficacité est prouvée par mutation |
| 3 | **La modale de recherche survivait à la navigation** : après Automations/Extensions/Library, `dialog.task-search` **masquait le titre de la vue** (mesuré : `elementFromPoint` sur le `h1` renvoyait `DIALOG.task-search`) | `openPage` ferme désormais `searchOpen` — il fermait déjà `settingsOpen`, l'asymétrie était d'une ligne (`App.tsx:363`) | après navigation : `modales: []`, `dessusDuTitre: "H1."` |
| 4 | **`outil` en français** dans le résumé du panneau (`2 subagent, 0 outil, 0 system`) | `tool` (`ArtifactsPane.tsx:116`) | garde `ui-copy.test.ts` étendu à ce fichier ; mutation → échec nommant `} outil` |
| 5 | **Débordement horizontal du panneau Terminal** (+121 px) : `.terminal-toolbar` avait 411 px pour 548 px de contenu, car `.terminal-actions` est `flex-shrink: 0` et le bloc libellé ne pouvait pas rétrécir (`min-width: auto`) | `min-width: 0` sur le bloc libellé (`Desktop.css`) | **0 débordement** sur Terminal |

## Tenté, mesuré, retiré

### La grille du panneau Desktop

**Hypothèse :** `.desktop-control-layout` déclarait `minmax(180px, .8fr) minmax(240px, 1.2fr)` avec `gap: 14px` — soit un **plancher de 434 px** pour un corps de panneau d'environ 405 px. La grille ne pouvait donc pas tenir, et ses six descendants rapportaient `scrollWidth > clientWidth`.

**Correction appliquée :** planchers abaissés à `minmax(120px, .8fr) minmax(160px, 1.2fr)`.

**Résultat mesuré — mixte, donc rejeté :**

| Conteneur | Avant | Après |
|---|---|---|
| `.desktop-control-layout` | +65 | **+41** ✅ |
| `.desktop-control-panel` | +49 | **+25** ✅ |
| `.work-panel-body` | +32 | **+8** ✅ |
| `.desktop-window-list` | +25 | **+40** ❌ |
| `.desktop-control-click` | +47 | **+53** ❌ |

**Correctif retiré** (`git checkout -- src/App.css`). Améliorer trois mesures en en dégradant deux n'est pas une correction, et je ne livre pas un changement dont je ne peux pas démontrer qu'il est meilleur.

> **Mise à jour du 21 septembre (passe 2).** Cette première tentative reste retirée, mais **le défaut a été corrigé depuis, par une autre voie**, et les chiffres de ce document provenaient d'un instrument défectueux. Deux jeux de valeurs différents, à ne pas confondre : la tentative **retirée** était `minmax(120px, .8fr) minmax(160px, 1.2fr)` ; l'état **livré** est `minmax(140px, .8fr) minmax(190px, 1.2fr)`. L'état livré est donc :
>
> - `.desktop-control-layout` : `minmax(140px, .8fr) minmax(190px, 1.2fr)`, avec repli à une colonne sous `1400px` (ligne de clic) et `1290px` (grille) ;
> - `.files-layout` : `minmax(140px, .85fr) minmax(190px, 1.4fr)`, repli sous `1230px`, dans `Desktop.css` **à côté** de la règle de base à cause de l'ordre d'import ;
> - **0 débordement** sur les 7 onglets et sur 13 largeurs de fenêtre de 720 à 1440 px.
>
> Le récit complet et les mesures valides sont dans [`debordement-desktop.md`](debordement-desktop.md). **Ne reprenez aucun chiffre de la section ci-dessous sans le revérifier** : ils venaient d'un détecteur qui comptait la troncature volontaire (`overflow: hidden`, ellipse, `.sr-only`) comme un défaut.

### Ce que la mesure a écarté

J'ai ensuite cherché la **feuille** la plus large du panneau, en supposant qu'un élément de contenu imposait sa largeur intrinsèque à toute la chaîne :

```
largeur du panneau : 437 px
feuille la plus large : 405 px  (P.muted, « Actions are local, bounded… »)
```

**La feuille la plus large tient dans le panneau.** Aucune feuille ne dépasse sa largeur. Le débordement vient donc de la **structure** (largeurs intrinsèques de conteneurs imbriqués), pas d'un élément de contenu — ce qui invalide mon hypothèse et explique pourquoi réduire les planchers de grille n'a fait que déplacer le problème.

C'est le **sixième faux diagnostic** de cette campagne sur le même schéma : une cause plausible acceptée sans vérifier qu'elle rend compte de **toutes** les mesures.

## Reste ouvert, mesuré

État au **21 septembre, après la passe 2** ([`revue-passe2.md`](revue-passe2.md)). Les lignes 6 à 8 et 11 sont **corrigées**, la 12 était un **faux positif**, et les autres sont requalifiées par la mesure.

| # | Défaut | État | Mesure / preuve |
|---|---|---|---|
| 6 | **Panneau Desktop** : six conteneurs débordaient en cascade | **CORRIGÉ** | 3 causes distinctes (planchers `minmax`, `min-width: auto`, ligne de clic) ; **0 débordement** sur 13 largeurs |
| 7 | **Review** : `.work-panel-body` débordait | **FAUX POSITIF** | mesuré sur un instrument qui comptait la troncature volontaire ; 0 débordement réel |
| 8 | **Files** : `.files-panel` débordait | **CORRIGÉ** | planchers 180/250 → 140/190 + `min-width: 0`, repli sous `1230px` |
| 9 | **Panneau Browser** : « Embedded preview » promis, **aucune surface d'aperçu** ni état vide | **OUVERT** | confirmé par mesure de structure : plus grand blanc vertical ~36 px, aucun viewport |
| 10 | **Message utilisateur dupliqué** : deux bulles identiques, même horodatage | **OUVERT, cause localisée** | doublon **pixel pour pixel** (diff 0,05/765) ; **absent des données** (`session.jsonl` ne contient qu'un message) → double projection cliente ; `mergeHistoryLog` ne déduplique pas les entrées distantes entre elles |
| 11 | Le libellé du modèle se couperait panneau déplié | **FAUX POSITIF** | mesuré sous le bon état ; le libellé générique « Model » venait de `model_id` **non transmis par Rust** — corrigé et vérifié sur 11 sessions |
| 12 | « Run in Muse » quasi blanc sur blanc | **FAUX POSITIF** | bouton **`disabled` + `opacity: .45`**, que WCAG exempte ; « Send » actif mesure **4,82:1** |
| 13 | Deux encadrés du panneau Desktop avec bordure épaisse ~2 px | **REQUALIFIÉ** | contours natifs non stylés `#545D62`/`#687075`/`#767676` contre `#E6E9ED` ailleurs : **hors charte**, pas « quasi noirs » |
| 14 | Bas du transcript coupé en plein glyphe | **NON DÉMONTRÉ** | la mesure ne montre pas de glyphe coupé en pleine hauteur, seulement du contenu atteignant le bord |
| 15 | Hiérarchie d'en-tête incohérente (kicker en majuscules sur Review/Desktop) | **OUVERT** | confirmé : hauteur d'en-tête 100 px (Review) contre 26 px (Memory) |
| 16 | **« Close panel » à 16 px de large** | **CORRIGÉ** | `padding: 15px 1px` réduisait la cible à la largeur du glyphe ; `min-width: 24px` sur `.icon` — 24×50 px, et les autres boutons (28×30, 32×32) inchangés |
| 17 | **« Run in Muse » reste désactivé** alors que le host accorde `userShell` | **OUVERT, non tranché** | pont : `["userShell"]` · prop React lue sur la fibre : `false` · infobulle : « did not grant ». Écart prouvé, chaîne non élucidée |

## Ce qui a été vérifié comme correct

- **Bande d'onglets** : pixel-identique sur les six panneaux, soulignement actif toujours sous le bon onglet, aucun décalage ni réordonnancement.
- **Thème clair** : intégralement appliqué, aucune zone restée sombre.
- **Cibles interactives** : aucune sous 24×24 px hormis l'attache-fichier, masqué volontairement.
- **Aucun défilement horizontal** au niveau du document.
- Panneaux **Files** et **Memory** : leurs états vides sont expliqués.
- **Chemins ellipsés**, badges et horodatages des cartes d'outil restent lisibles.
