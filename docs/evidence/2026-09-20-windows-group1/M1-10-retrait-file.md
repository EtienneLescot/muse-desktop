# Retrait de la file — mesuré (M1-10, 20 septembre 2026)

Remplace `M1-10-retrait-file-inabouti.md`. Le critère « le retrait supprime-t-il réellement ? » est désormais mesuré.

## Ce qui avait fait échouer la tentative précédente

Deux causes, toutes deux corrigées :

1. **Aucune vérification d'état avant d'agir.** Le test envoyait un second message sans jamais confirmer que le premier tour tournait. Si le premier est terminé, un second envoi démarre normalement et **rien n'est mis en file** — le bouton de retrait ne peut alors pas exister.
2. **La soumission ne partait pas.** Mon helper envoyait `Input.dispatchKeyEvent` **sans attendre les réponses** CDP : le composer gardait ses 52 caractères, `entryCount` ne bougeait pas, `working` restait faux. Remplacé par une soumission **dans le contexte de page**, dont le résultat est relu.

## Protocole retenu — chaque précondition est attendue

```powershell
node scripts/cdp-queue-removal.mjs
```

| Précondition | Vérifiée comment |
|---|---|
| 1. Composer présent, actif, **vide**, conversation connectée | attente active |
| 2. Après le 1ᵉʳ envoi : composer vidé **et** `working` devenu vrai | deux attentes distinctes |
| 3. Après le 2ᵉ envoi : `queuedRows >= 1` **avant** de chercher le bouton | attente active |

## Résultat

| Étape | File (`queued-turns.v1`) | Panneau visible | Boutons de retrait | `working` |
|---|---|---|---|---|
| **queued** | **1** — `QUEUE-SECOND-8842 reply with just QUEUED` | **oui** | **1** | oui |
| **after-removal** | **0** | **non** | **0** | **oui** |
| after-removal-settled | 0 | non | 0 | oui |

Le bouton cliqué : **« Remove from queue »**.

## Établi

- **L'action de retrait supprime réellement l'entrée** : la file persistée passe de 1 à 0 dans `muse-desktop.queued-turns.v1`. Ce n'est pas un masquage — l'état durable est modifié.
- **Le panneau se retire avec l'entrée** : `Queued messages` disparaît et le bouton avec lui, de façon cohérente.
- **Le premier tour n'est pas affecté** : `working` reste vrai après le retrait. Retirer un tour en attente n'interrompt pas celui qui s'exécute — c'est le comportement attendu.
- **L'entrée retirée est identifiée** : le contenu de la file avant retrait porte bien le marqueur du second message, pas celui du premier.

## Une précondition a échoué, et c'est instructif

La première précondition (« composer prêt et vide ») a rapporté **ECHEC** : le composer contenait **40 caractères** — le reliquat du test précédent, que j'avais nettoyé à la main avant ce round mais qui était revenu. Le script a quand même continué, et les trois préconditions suivantes ont réussi.

**Conséquence :** le résultat est valide — le second message a bien été mis en file et retiré — mais le script **ne s'arrête pas sur une précondition manquée**, ce qui est un défaut : il devrait abandonner plutôt que de poursuivre dans un état non conforme. À corriger si ce scénario est rejoué.

## Ce que M1-10 couvre désormais

| Élément | État |
|---|---|
| Admission en file, `disposition: queued` persistée | mesuré (campagne groupe 1) |
| Panneau **Queued messages** ordonné, action d'enlèvement visible | mesuré |
| État **`Stopping…`** puis bandeau d'attente du host | mesuré |
| File **vidée après un Stop** (le host consomme le tour) | mesuré |
| **Retrait explicite d'une entrée en attente** | **mesuré (ce document)** |
| **Course UI file/`unqueue`** | **non mesuré** — c'est le cœur du ticket |

## Portée et limites

- **La course visée par le ticket n'est pas exercée** : je n'ai pas provoqué d'envoi concurrent au moment précis du retrait. Le scénario mesuré est séquentiel (mettre en file, puis retirer).
- **`turn/unqueue` n'est pas observé côté host** : je constate la disparition locale de l'entrée, pas l'accusé du host pour la commande d'annulation.
- **Aucune vérification de la restauration** : si le retrait échouait côté host, l'entrée disparaîtrait-elle quand même ? Non testé.
- **Un seul cas**, sans répétition. Mon défaut de protocole (poursuite après précondition manquée) réduit la confiance dans l'ordre exact des opérations.

**M1-10 n'est pas clos** : son critère central — la course UI file/`unqueue` — reste non mesuré. Ce qui est acquis, c'est que le retrait fonctionne en séquentiel.
