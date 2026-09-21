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

### Ce que la mesure a écarté

J'ai ensuite cherché la **feuille** la plus large du panneau, en supposant qu'un élément de contenu imposait sa largeur intrinsèque à toute la chaîne :

```
largeur du panneau : 437 px
feuille la plus large : 405 px  (P.muted, « Actions are local, bounded… »)
```

**La feuille la plus large tient dans le panneau.** Aucune feuille ne dépasse sa largeur. Le débordement vient donc de la **structure** (largeurs intrinsèques de conteneurs imbriqués), pas d'un élément de contenu — ce qui invalide mon hypothèse et explique pourquoi réduire les planchers de grille n'a fait que déplacer le problème.

C'est le **sixième faux diagnostic** de cette campagne sur le même schéma : une cause plausible acceptée sans vérifier qu'elle rend compte de **toutes** les mesures.

## Reste ouvert, mesuré

| # | Défaut | Mesure | Gravité |
|---|---|---|---|
| 6 | **Panneau Desktop** : six conteneurs débordent en cascade | jusqu'à **+65 px** (`.desktop-control-layout`) | MAJEUR |
| 7 | **Review** : `.work-panel-body` déborde | **+32 px** | MINEUR |
| 8 | **Files** : `.files-panel` déborde | **+15 px** | MINEUR |
| 9 | **Panneau Browser** : l'en-tête promet « Embedded preview » avec champ d'URL et « New tab », mais **aucune surface d'aperçu** n'existe — zone vide sans message | revue visuelle | MAJEUR |
| 10 | **Message utilisateur dupliqué** : deux bulles identiques, même texte, même horodatage | revue visuelle | MAJEUR |
| 11 | Le libellé du modèle **se couperait encore panneau déplié** (composeur réduit à 646 px) — **contredit ma vérification** qui disait 1 ligne | revue visuelle | à trancher |
| 12 | « Run in Muse » quasi blanc sur blanc, à côté d'un « Send » actif | revue visuelle | MINEUR |
| 13 | Deux encadrés du panneau Desktop avec bordure épaisse ~2 px → effet « focus resté bloqué » | revue visuelle | MINEUR |
| 14 | Bas du transcript **coupé en plein glyphe** au bord de défilement, sans fondu | revue visuelle | MINEUR |
| 15 | Hiérarchie d'en-tête incohérente (Review/Desktop en majuscules + grand titre, les autres en titre simple) | revue visuelle | MINEUR |

## Ce qui a été vérifié comme correct

- **Bande d'onglets** : pixel-identique sur les six panneaux, soulignement actif toujours sous le bon onglet, aucun décalage ni réordonnancement.
- **Thème clair** : intégralement appliqué, aucune zone restée sombre.
- **Cibles interactives** : aucune sous 24×24 px hormis l'attache-fichier, masqué volontairement.
- **Aucun défilement horizontal** au niveau du document.
- Panneaux **Files** et **Memory** : leurs états vides sont expliqués.
- **Chemins ellipsés**, badges et horodatages des cartes d'outil restent lisibles.
