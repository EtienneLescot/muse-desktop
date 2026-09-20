# Finder vers un résultat hors fenêtre — test inabouti (M1-13, 20 septembre 2026)

Tentative de couvrir le dernier critère de mesure de M1-13 : **le saut du finder vers un résultat situé hors de la fenêtre DOM**.

**Le test n'a pas abouti, et l'échec vient de mon script, pas de l'application.** Je le consigne pour ne pas laisser croire que le critère est couvert.

## Protocole prévu

1. écrire 2 000 entrées dont un marqueur unique à l'index **137** — donc très au-dessus de la fenêtre initiale ;
2. recharger, remonter en haut pour déclencher un chargement, et vérifier que la fenêtre est loin de 137 ;
3. ouvrir `Find in conversation`, saisir `FINDER-NEEDLE-137`, sélectionner le résultat, valider ;
4. vérifier que la fenêtre s'est **déplacée jusqu'à inclure l'index 137**.

## Ce qui s'est passé

| Étape | Fenêtre DOM | Articles | `posinset` | Finder ouvert |
|---|---|---|---|---|
| initial | 1720 – 1880 | 160 | 1721 | oui |
| après scroll en haut | 1600 – 1760 | 160 | 1601 | **non** |
| requête envoyée | 1600 – 1760 | 160 | 1601 | **non** |
| sélection | 1600 – 1760 | 160 | 1601 | non |
| validation | 1600 – 1760 | 160 | 1601 | non |

La fenêtre **n'a jamais bougé** après l'étape 2, et le finder s'est retrouvé **fermé** avant même la saisie.

## Cause identifiée

Mon sélecteur cherchait un bouton dont le texte contient « Find in conversation ». Or ce texte appartient au **conteneur du finder** (`.stream-find`, `aria-label="Find in conversation"`), pas à un bouton d'ouverture. Le clic a donc **refermé** un finder déjà ouvert au lieu de l'ouvrir, et la recherche de champ qui suivait a échoué — faute de champ monté. La requête n'a jamais été saisie, et aucune sélection n'a pu être cliquée.

**Enseignement de méthode :** cibler un libellé par sous-chaîne sans vérifier la **balise** de l'élément est fragile. Le conteneur portait le même texte que l'action recherchée.

## Ce que le test établit quand même

Rien sur le finder. En revanche, deux mesures **valides** ont été obtenues au passage, et elles corroborent #166/#167 :

- fenêtre initiale **1720 – 1880** avec **160 articles** montés ;
- après un scroll en haut, fenêtre **1600 – 1760** : recul de **120 entrées**, DOM stable.

## Restauration

Le journal d'origine a été réécrit et **vérifié** : 21 205 octets, 25 entrées, ni entrée `long-`, ni marqueur `FINDER-NEEDLE`. Aucun état de profil n'est laissé modifié.

## Ce qu'il faudrait pour reprendre

Cibler le vrai point d'ouverture du finder — le raccourci `Ctrl+F` est déjà **prouvé câblé** (mesuré dans `docs/evidence/2026-09-20-windows-a11y/M0-12.md`), donc l'ouvrir par le clavier plutôt que par un clic est la voie la plus sûre. Ensuite localiser le champ par `aria-label="Search messages"` plutôt que par sous-chaîne sur un conteneur.

**M1-13 reste ouvert** sur ce point : le finder hors fenêtre n'est **pas** qualifié.
