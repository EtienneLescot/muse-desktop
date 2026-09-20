# Finder vers un résultat hors fenêtre — mesuré (M1-13, 20 septembre 2026)

Complète `M1-13.md` et remplace `finder-hors-fenetre-inabouti.md` (tentative ratée du round 20).

## Le piège qui avait fait échouer la première tentative

Deux erreurs de ma part, toutes deux corrigées ici :

1. **Sélecteur du conteneur au lieu de l'ouvreur.** `Find in conversation` est l'`aria-label` du **conteneur** `.stream-find` (`StreamView.tsx:812`), pas d'une action. Mon clic refermait un finder déjà ouvert.
2. **Confusion sur l'ordre des entrées.** `streamWindowStart` est un **offset depuis la fin** (`initialStreamWindowStart`), donc la fenêtre `0–160` correspond aux **160 dernières** entrées. Un marqueur placé à l'index 137 était donc **déjà visible** : le premier test ne prouvait rien sur le cas « hors fenêtre ».

Avec 2 000 entrées et un chargement de 120, un index **< 1400** est nécessaire pour être réellement hors fenêtre. La mesure retenue utilise l'index **900**.

## Protocole

```powershell
node scripts/cdp-finder-jump.mjs --entries 2000 --index 900
```

Le script écrit 2 000 entrées dont un marqueur unique à l'index 900, recharge, **ouvre le finder par le raccourci `Ctrl+F`** — dont la liaison est déjà prouvée dans `docs/evidence/2026-09-20-windows-a11y/M0-12.md` —, cible le champ par son `aria-label="Search messages"` (`StreamView.tsx:825`), saisit le marqueur, puis valide.

## Résultat

| Étape | Fenêtre DOM | Articles montés | `posinset` | Marqueur dans la fenêtre |
|---|---|---|---|---|
| initial | 0 – 160 | 160 | 1 | **non** |
| après `Ctrl+F` | 0 – 160 | 160 | 1 | non |
| après saisie de la requête | 0 – 160 | 160 | 1 | **oui** |
| après Entrée | **888 – 1048** | **160** | **889** | oui |
| après clic sur le résultat | 888 – 1048 | 160 | 889 | oui |

Résultat de recherche retourné : **1 option**, libellée `USER — FINDER-NEEDLE-900 unique marker placed outsid…`.

**Établi :**

- la recherche **atteint une entrée hors de la fenêtre DOM** : l'entrée d'index 900 est trouvée alors que la fenêtre ne couvrait que les 160 dernières ;
- la validation **déplace la fenêtre** jusqu'à inclure le résultat : `888 – 1048`, `posinset` 889 — cohérent avec un résultat à l'index 900 ;
- le **DOM reste borné à 160 articles** après le saut : le saut ne fait pas exploser le nombre de nœuds ;
- le déplacement est obtenu par **Entrée** sur le champ, sans avoir besoin du clic.

**Limite observée :** le tableau de résultats expose **8 options**, dont **7 vides** — seule la première porte un libellé. Je n'ai pas déterminé si c'est un artefact de mon extraction DOM ou un rendu réel ; à vérifier avant d'en tirer une conclusion d'accessibilité.

## Restauration

Le journal d'origine a été réécrit et **vérifié** : 21 205 octets, `hasSynthetic: false`, `hasNeedle: false`. Aucun état de profil n'est laissé modifié.

## État de M1-13 après cette mesure

| Critère | État |
|---|---|
| Fenêtre DOM bornée sur 2 000 entrées | **mesuré** (`M1-13.md`) |
| Chargement incrémental (scroll + bouton) | **mesuré** (`M1-13.md`) |
| Finder vers un résultat hors fenêtre | **mesuré** (ce document) |
| Performances (mémoire, temps de rendu) | **non mesurées** |
| Qualification assistive native | **non exercée** |
| macOS / Linux | hors périmètre |

**M1-13 reste ouvert** sur les performances et la qualification assistive — la roadmap conditionne explicitement la virtualisation complète à « une mesure réelle de mémoire et de temps de rendu », que ces documents ne remplacent pas. Mais ses trois critères de mesure d'interface sont désormais couverts.
