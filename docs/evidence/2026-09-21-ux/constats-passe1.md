# Passe UX/UI n° 1 — constats mesurés (21 septembre 2026)

Première passe avant la beta 0.1.0. Méthode : **capturer** chaque surface, puis **mesurer** ce qui peut l'être, et ne confier au jugement visuel que ce qui ne se mesure pas.

Toutes les captures sont dans [`pass1/`](pass1/) — 15 images. Les sondes sont rejouables :

```powershell
node scripts/ux-capture.mjs --out <dir> --port 9227          # 13 surfaces
node scripts/ux-force-conversation.mjs --out <dir> --port 9227 # conversation + onglets
node scripts/ux-contrast-audit.mjs --port 9227 [--theme light]
node scripts/ux-target-size-audit.mjs --port 9227
```

## Défauts trouvés, corrigés et vérifiés

### 1. Le libellé du modèle se coupait sur deux lignes

**Mesure :** `Range.getClientRects()` renvoyait **2 lignes** pour `muse-spark-1.3-contributor` dans un bouton de 168×48 px, alors qu'il restait de la place sur une ligne.

**Cause :** un `<button>` nu dans `.composer-model` (`display: inline-flex; min-width: 0`) — rien n'empêchait le texte de passer à la ligne.

**Correctif :** `white-space: nowrap` + `text-overflow: ellipsis` à 22ch sur le bouton.

**Vérification :** après rechargement, `white-space: nowrap`, **1 ligne**, bouton 64×32 px.

### 2. Le thème clair violait WCAG AA sur tout le texte secondaire

**Mesure :** 23 textes sous le seuil, tous portés par la même variable.

| Contexte | Fond | Ratio | Requis |
|---|---|---|---|
| Barre latérale, libellés de section, barre de statut | `#f5f6f8` | **3,62** | 4,5 |
| Métadonnées du transcript, champ de recherche | `#ffffff` | **3,92** | 4,5 |

**Cause :** `--muted: #78828a` dans la palette claire (`App.css`). Le thème sombre utilise une autre valeur (`#92a2ad`) et **passait déjà**.

**Correctif :** `--muted: #6a7279` — valeur **calculée**, pas choisie à l'œil : la plus petite correction qui passe sur les deux fonds (4,52 et 4,89), en restant nettement plus discrète que `--text` (`#182329`, ≈14:1).

**Vérification :** **0 texte sous le seuil**, dans les deux thèmes.

## Ce qui a été mesuré et qui va bien

| Contrôle | Résultat |
|---|---|
| Contraste, thème **sombre** | **0 échec** |
| Contraste, thème **clair** après correctif | **0 échec** |
| Défilement horizontal | **aucun** (document 1440 px = viewport) |
| Éléments hors viewport | **aucun** |
| Cibles interactives sous 24×24 px | **2**, toutes deux légitimes : un `+` à 20,3×28 px (marge minime) et l'`input` **masqué 1×1** de l'attache-fichier, déclenché par le bouton « Attach » |

## Un faux positif écarté, et il faut le dire

Mon premier audit annonçait **20 anomalies graves en thème sombre**, dont des options de menu à **1,16:1** (texte clair sur fond blanc) — j'ai cru à un bug d'affichage majeur.

**C'était faux.** Le point testé ne contenait pas l'option : `elementsFromPoint` renvoyait le transcript. Les popovers étaient **refermés**, et l'audit comptait leur contenu, que le navigateur ne peint pas. Le blanc venait du fond de bouton par défaut de Chrome, jamais affiché.

**Correctif apporté à l'outil** : l'audit écarte désormais `details:not([open])` et `content-visibility: hidden`. Les 20 échecs ont disparu.

Sans cette vérification, j'aurais « corrigé » un bug inexistant.

## Constats visuels, non mesurés — à confirmer

Ces points viennent de l'examen des captures. Je ne les ai **pas** instrumentés, donc je les donne comme observations.

| # | Observation | Capture | Gravité présumée |
|---|---|---|---|
| 3 | **Le composeur est très haut** : le placeholder « Ask Muse to continue… » occupe une large zone vide et la ligne de contrôles est centrée verticalement, pour ~160 px au total | `08-panneau-deplie` | MAJEUR |
| 4 | **« Local » apparaît trois fois** : pastille d'en-tête (`App.tsx:851`), pastille du composeur (`:1430`), « Local execution » en barre de statut (`:1802`). Les deux pastilles nues sont redondantes entre elles | `07`, `08` | MAJEUR |
| 5 | **Le modèle s'affiche « Model »** quand `model_id` est absent de la session, au lieu du nom réel | mesuré au DOM | MAJEUR |
| 6 | **Ligne d'événement sous-agent tassée** : `▸ Agent b44a4ae3-6c20-… Reminder child se… | Completed | 09:21:48` — identifiant tronqué et texte se disputent la même ligne | `08` | MINEUR |
| 7 | **Bandeau « Find in conversation » monté en permanence** au-dessus des messages, alors qu'un raccourci `Ctrl/Cmd F` existe | `08` | MINEUR |
| 8 | **Titre tronqué deux fois** : `Reply with exactly the word: BETA-17899752…` dans le fil d'Ariane **et** dans le `h1` | `08` | MINEUR |

Les points 3 à 8 sont soumis à une revue visuelle indépendante en cours ; je ne les corrige pas avant qu'elle confirme ou infirme — c'est la règle que cette campagne s'est fixée après dix constats d'absence erronés.
