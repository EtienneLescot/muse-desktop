# M1-06 — la carte des capacités n'est peuplée qu'au montage (21 septembre 2026)

Deux faits établis dans la même session, et ils vont ensemble.

## 1. Le « blocage côté host » est réfuté

Voir [`m1-06-blocage-refute.md`](m1-06-blocage-refute.md) : avec la forme de capacité que l'application utilise (`capabilities.requestedCapabilities`, imbriquée), le sidecar 1.3.0 **publie** `item/started` et `item/completed` de type `userShell`, avec la sortie de la commande. La sonde qui affirmait le contraire envoyait la capacité **à plat**, n'obtenait rien, et concluait à un écart de contrat.

## 2. Le vrai défaut est côté client, et il est de synchronisation

**Mesure.** Sur un lancement frais, au moment où l'onglet Terminal est affiché :

| Source | Réponse pour la session active `01a0bb03` |
|---|---|
| Pont Rust (`restore_sessions`) | `granted_capabilities: ["userShell"]` |
| Carte du renderer (`grantedCapabilitiesBySession`, hook #82) | **absente** — la carte ne contient que `01a0c2d7` |
| Prop React `canRunThroughMuse` lue sur la fibre | **`false`** |
| Infobulle du bouton | « This Muse host did not grant the userShell capability » |

**Cause.** `restore_sessions` est appelé **au montage**, et l'effet qui peuple `grantedCapabilitiesBySession` ne s'exécute qu'à ce moment-là. Or les hôtes sont lancés **par workspace** : au premier passage, toutes les sessions ne sont pas encore admises, donc la carte n'en reçoit qu'une partie. **Rien ne la repeuple ensuite** — seuls `start_session`, `resume_session` et `fork_session` renseignent une entrée, pour la session qu'ils créent.

**Conséquence visible :** après un lancement, « Run in Muse » annonce que le host n'a pas accordé la capacité **alors que le host l'a accordée**. Le motif affiché est faux, et l'action reste indisponible jusqu'à ce qu'une autre voie renseigne la carte.

**Ce n'est pas la même chose que le point précédent** : la capacité existe et fonctionne ; c'est la copie que le renderer en garde qui est incomplète.

## 3. Un état intermédiaire, mesuré

Sur une instance plus ancienne, la même carte contenait **11 sessions** avec `["userShell"]`. La différence est le moment du peuplement, pas le contenu négocié. Cela explique pourquoi ce défaut a été pris plus tôt pour un problème de capacité : selon l'instant de la mesure, le bouton était activé ou non.

## 4. Ce qui a été corrigé

**`sessionNotLoaded` n'est pas un échec opaque.** `Run in Muse` s'activait sur une conversation que le host n'avait pas chargée, et l'échec n'arrivait **qu'après le clic**. Le host rapporte `status: "notLoaded"` pour **toutes** les sessions persistées après une relance — y compris celles à 27 tours — donc « le host la liste » et « le host l'a en mémoire » sont deux états distincts.

`SessionMeta` porte désormais `loaded`, dérivé de ce statut, et le bouton est indisponible avec un motif explicite tant que la conversation n'est pas chargée. Le message ne prétend plus que la capacité manque.

**Mesure de la chaîne complète :** `restore_sessions` renvoie `"loaded": false` pour les 13 sessions, aux côtés de `model_id` et `granted_capabilities`, qui traversent donc bien la même projection.

**Et le chemin fonctionne une fois la session chargée :** `session/resume` puis `session/userShell` donnent `accepted`, **2 items `userShell`**, et le marqueur de la commande **restitué** — mesuré deux fois, avant et après la reprise, dans `scripts/msp-user-shell-after-resume.mjs`.

## 5. Reste ouvert

1. **Repeupler la carte des capacités** après le lancement des hôtes, plutôt qu'au seul montage. C'est le correctif du défaut de synchronisation décrit en 2, et il n'est **pas** fait.

2. **Charger la session à la demande** au lieu de refuser l'action : `session/resume` fournit exactement l'état manquant, comme mesuré. Le refus explicite est un progrès honnête, pas la fonction complète.

3. **Qualification native interactive sur les trois OS**, exigée par le ticket.

## La leçon, une fois de plus

Trois mesures du même contrat se sont contredites dans cette campagne — le pont, la prop React, le DOM — et à chaque fois j'ai d'abord cru la plus commode. Ce qui a tranché est chaque fois **une source supplémentaire**, pas un raisonnement : le journal persisté pour le doublon de message, la fibre React ici, la forme de capacité envoyée pour le faux blocage.

Et une note sur les états composites : `disabled` sur ce bouton combine **quatre** conditions (capacité, session chargée, commande non vide, exécution en cours). J'ai tiré deux conclusions fausses de sa seule valeur. **L'infobulle est le discriminant** — elle nomme la cause — et c'est elle qu'il faut lire.
