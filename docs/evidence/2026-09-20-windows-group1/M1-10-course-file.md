# Course UI sur la file — mesurée (M1-10, 20 septembre 2026)

Complète `M1-10-retrait-file.md`, qui ne couvrait qu'un retrait **séquentiel**. Le critère central du ticket — la **course** entre la file et son vidage — est mesuré ici.

## Pourquoi une course demandait une autre méthode

Les passes précédentes pilotaient chaque action par une commande CDP séparée. Chaque aller-retour ajoute des dizaines de millisecondes, ce qui rend une fenêtre de course **impossible à viser**. Cette fois, la rafale de retraits est exécutée **dans le contexte de page**, en une seule évaluation, avec des clics espacés de 90 ms.

## Protocole — préconditions attendues, jamais supposées

```powershell
node scripts/cdp-queue-race.mjs
```

Trois préconditions, chacune **attendue** par sondage :

| Précondition | Résultat |
|---|---|
| Composer vide et connecté | **OK** |
| Premier tour réellement en cours (`working: true`) | **OK** |
| Deux tours effectivement en file (`queuedRows >= 2`) | **OK** |

C'est la correction directe du défaut qui avait fait échouer la passe précédente.

## Résultat

| Étape | File | Panneau | Boutons de retrait | `working` | Entrées de log |
|---|---|---|---|---|---|
| **two-queued** | **2** — `RACE-QUEUED-A-3311`, `RACE-QUEUED-B-7722` | oui | 2 | oui | 70 |
| **after-race** | **0** | **non** | **0** | oui | 72 |
| after-race-settled | 0 | non | 0 | oui | 72 |
| later | 0 | non | 0 | oui | 72 |

Les deux entrées de file portent exactement les marqueurs attendus, dans l'ordre.

### Le transcript confirme l'opération

Les dernières entrées du journal, dans l'ordre :

```
user       RACE-QUEUED-B-7722 say BETA
assistant  1 2 3 4 5 … 23            <- le PREMIER tour, qui continue
system     Turn queued — it will start after the current…
subagent   (vide)
system     Queued turn removed.
system     Queued turn removed.
```

**Deux lignes « Queued turn removed. » à 111 ms d'intervalle** — le vidage de la file a bien été enregistré, entrée par entrée.

## Le point décisif : aucun tour retiré n'a démarré

| Mesure | Résultat |
|---|---|
| Occurrences de `ALPHA` dans le journal | **0** |
| Occurrences de `BETA` dans le journal | **0** |
| Dernières réponses assistant | le comptage `1 2 3 … 23` du **premier** tour uniquement |

Les invites des deux tours retirés apparaissent comme entrées `user` (elles ont été saisies) mais **aucune réponse ne leur correspond**. Ils ont été retirés de la file **avant** de démarrer, et le premier tour a continué sans être affecté (`working` reste vrai à toutes les étapes).

**Établi :** la séquence mettre-en-file → retirer tient la course. Le retrait supprime l'entrée du stockage, le panneau se retire, l'opération est tracée dans le transcript, et **les tours retirés ne s'exécutent pas**.

## Limites et une anomalie non expliquée

- **Anomalie : trois lignes « Turn queued »** apparaissent alors que je n'ai saisi que **deux** messages de file. Le total des entrées de journal passe de 70 à 72 pendant la course, ce qui correspond aux deux lignes de retrait. Je **n'explique pas** la troisième ligne « Turn queued » : peut-être une réémission, peut-être un reliquat d'une passe antérieure. Non tranché.
- **Mon objet `race` est revenu vide** (`{}`) : l'évaluation asynchrone n'a pas renvoyé son résultat exploitable. Les clics ont bien eu lieu — la file est passée de 2 à 0 et deux lignes de retrait existent — mais je **n'ai pas le compte exact** des clics effectués ni des boutons trouvés à chaque tentative.
- **Une seule prise**, sans répétition : la course n'est pas éprouvée statistiquement.
- **`turn/unqueue` n'est pas observé côté host** — je constate la conséquence locale et le tracé du transcript, pas l'accusé du host pour la commande d'annulation.
- **Aucun cas d'échec provoqué** : je n'ai pas testé le comportement si le retrait échouait côté host.
- La précondition « deux tours en file » a réussi, mais la passe précédente avait montré que mon script **poursuit après une précondition manquée** — ce défaut n'est pas corrigé ici.

## État de M1-10

| Élément | État |
|---|---|
| Admission en file, `disposition: queued` persistée | mesuré |
| Panneau **Queued messages** ordonné, action d'enlèvement | mesuré |
| État **`Stopping…`** puis bandeau d'attente du host | mesuré |
| File vidée après un Stop | mesuré |
| Retrait séquentiel d'une entrée | mesuré |
| **Course : retirer pendant que le tour précédent tourne** | **mesuré — les tours retirés ne démarrent pas** |

Ce que le ticket appelle « la course UI » est désormais exercé. **M1-10 n'est pas déclaré clos** pour autant : l'anomalie des trois lignes de file n'est pas expliquée, le compte exact des clics manque, et l'accusé du host n'est pas observé.
